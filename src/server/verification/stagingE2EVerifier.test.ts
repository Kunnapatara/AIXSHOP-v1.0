import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';
import { createApp } from '../app';
import { MemoryRepository } from '../db/memoryRepository';
import { setCustomEmailTransport } from '../services/emailService';
import { runStagingE2EVerification } from './stagingE2EVerifier';

function withMockEmailTransport(fn: () => Promise<void>): Promise<void> {
  setCustomEmailTransport(async () => ({
    delivered: true,
    mode: 'custom_transport',
    messageId: '<mock-staging-e2e@aixshop.test>',
  }));
  return fn().finally(() => {
    setCustomEmailTransport(null);
  });
}

async function withEnvOverrides(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    previous.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of previous.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function startEphemeralServer(repo: MemoryRepository, intercept?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean) {
  const app = createApp(repo);
  const server = http.createServer((req, res) => {
    if (intercept && intercept(req, res)) return;
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function buildLocalStagingEnv(baseUrl: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    COMMERCIAL_VERIFY_EXTERNAL: 'true',
    STAGING_ALLOW_LOCAL: 'true',
    STAGING_CONFIRM_NON_PRODUCTION: 'true',
    STAGING_BASE_URL: baseUrl,
    APP_URL: baseUrl,
    SHOPIFY_API_KEY: 'test_shopify_key',
    SHOPIFY_API_SECRET: 'test_shopify_secret_for_unit_test',
    SHOPIFY_APP_URL: baseUrl,
    SHOPIFY_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SHOPIFY_DEV_STORE_DOMAIN: 'aixshop-staging-test.myshopify.com',
    SHOPIFY_DEV_ACCESS_TOKEN: 'shpat_local_test_stub',
    STRIPE_SECRET_KEY: 'sk_test_local_stub_1234',
    STRIPE_WEBHOOK_SECRET: 'whsec_local_test_1',
    STRIPE_PRICE_STARTER: 'price_starter_test',
    STRIPE_PRICE_GROWTH: 'price_growth_test',
    STRIPE_PRICE_ENTERPRISE: 'price_enterprise_test',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'smtp-user@example.test',
    SMTP_PASS: 'smtp-pass-stub',
    SMTP_FROM: 'no-reply@aixshop.example.com',
    SMTP_TEST_RECIPIENT: 'verify-recipient@example.com',
    BILLING_PROVIDER: 'sandbox',
    ...extra,
  };
}

describe('Tasks A & B — Staging E2E Resource Cleanup & Strict Tenant Isolation', () => {
  test('1. Full local staging E2E run passes all 7 checks, isolates tenants, cleans up A & B, and preserves pre-existing tenants', async () => {
    const repo = new MemoryRepository(false);
    // Pre-existing user + workspace that MUST NEVER be touched by cleanup
    const preexisting = await repo.registerUser({
      user: {
        id: 'usr_preexisting_c',
        email: 'preexisting-c@example.com',
        passwordHash: 'hashed_pw',
        fullName: 'Preexisting Merchant C',
      },
      workspace: {
        id: 'ws_preexisting_c',
        name: 'Preexisting Store C',
        slug: 'preexisting-c',
      },
      session: {
        id: 'sess_preexisting_c',
        sessionTokenHash: 'hash_preexisting_c',
        userId: 'usr_preexisting_c',
        activeWorkspaceId: 'ws_preexisting_c',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    const srv = await startEphemeralServer(repo);
    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification({ targetEnvironment: 'local-ephemeral-test' });
        assert.equal(summary.status, 'PASS');
        assert.equal(summary.counts.fail, 0);
        assert.equal(summary.counts.blocked, 0);
        assert.equal(summary.counts.pass, 7);

        // Task B evidence
        const isoCheck = summary.checks.find((c) => c.testId === 'S4-TENANT-ISOLATION-STRICT');
        assert.equal(isoCheck?.status, 'PASS');
        assert.equal(isoCheck?.evidence?.switchWorkspaceRejectedStatus, 403);

        // Task A cleanup report
        assert.ok(summary.cleanupReport);
        assert.equal(summary.cleanupReport.enabled, true);
        assert.equal(summary.cleanupReport.status, 'CLEANED');
        assert.equal(summary.cleanupReport.trackedResources.userIds.length, 2);
        assert.equal(summary.cleanupReport.trackedResources.workspaceIds.length, 2);
        assert.equal(summary.cleanupReport.deletedUserIds.length, 2);
        assert.equal(summary.cleanupReport.deletedWorkspaceIds.length, 2);

        // Verify both test users & workspaces are genuinely gone from repository
        for (const uid of summary.cleanupReport.deletedUserIds) {
          assert.equal(await repo.getUserById(uid), null);
        }
        for (const wid of summary.cleanupReport.deletedWorkspaceIds) {
          assert.equal(await repo.getWorkspaceById(wid), null);
          assert.equal(await repo.loadWorkspaceCatalog(wid), null);
        }

        // Verify pre-existing User C & Workspace C were NOT touched
        assert.ok(await repo.getUserById(preexisting.user.id));
        assert.ok(await repo.getWorkspaceById(preexisting.workspace.id));
      }));
    } finally {
      await srv.close();
    }
  });

  test('2. Mid-run failure STILL triggers finally cleanup and removes created test resources', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startEphemeralServer(repo, (req, res) => {
      if (req.url?.startsWith('/api/shopify/connect')) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Injected Shopify connect failure for cleanup test' }));
        return true;
      }
      return false;
    });

    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification();
          assert.equal(summary.status, 'FAIL');
          const shopifyCheck = summary.checks.find((c) => c.testId === 'S4-SHOPIFY-OAUTH-CONNECT-INIT');
          assert.equal(shopifyCheck?.status, 'FAIL');

          const cleanupCheck = summary.checks.find((c) => c.testId === 'S4-STAGING-CLEANUP');
          assert.equal(cleanupCheck?.status, 'PASS');
          assert.equal(summary.cleanupReport?.status, 'CLEANED');
          assert.equal(summary.cleanupReport?.deletedUserIds.length, 2);

          for (const uid of summary.cleanupReport?.trackedResources.userIds || []) {
            assert.equal(await repo.getUserById(uid), null);
          }
        })
      );
    } finally {
      await srv.close();
    }
  });

  test('3. STAGING_CLEANUP_ENABLED=false skips cleanup honestly and preserves resources for inspection', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startEphemeralServer(repo);
    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(
          buildLocalStagingEnv(srv.baseUrl, { STAGING_CLEANUP_ENABLED: 'false' }),
          async () => {
            const summary = await runStagingE2EVerification();
            assert.equal(summary.cleanupReport?.enabled, false);
            assert.equal(summary.cleanupReport?.status, 'SKIPPED_DISABLED');
            assert.equal(summary.cleanupReport?.deletedUserIds.length, 0);

            const cleanupCheck = summary.checks.find((c) => c.testId === 'S4-STAGING-CLEANUP');
            assert.equal(cleanupCheck?.status, 'NOT RUN');

            // Resources intentionally remain in repository
            assert.equal(summary.cleanupReport?.trackedResources.userIds.length, 2);
            for (const uid of summary.cleanupReport?.trackedResources.userIds || []) {
              assert.ok(await repo.getUserById(uid));
            }
          }
        )
      );
    } finally {
      await srv.close();
    }
  });

  test('4. Shared workspace safety & idempotent account deletion via DELETE /api/auth/account', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startEphemeralServer(repo);
    try {
      const regA = await fetch(`${srv.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner-shared@example.com',
          password: 'Password123!',
          fullName: 'Owner A',
          workspaceName: 'Shared WS',
        }),
      });
      assert.equal(regA.status, 201);
      const cookieA = (regA.headers.get('set-cookie') || '').match(/aixshop_session=[^;]+/)![0];
      const regABody: any = await regA.json();

      // Add a second user to the workspace manually to simulate a shared workspace
      const user2 = await repo.createUser({
        id: 'usr_member_2',
        email: 'member2@example.com',
        passwordHash: 'hash',
        fullName: 'Member Two',
      });
      // Register user2 as a co-member in Shared WS while creating a sole workspace for A
      const memSharedId = `mem_${regABody.workspace.id}_${user2.id}`;
      (repo as any).memberships.set(memSharedId, {
        id: memSharedId,
        workspaceId: regABody.workspace.id,
        userId: user2.id,
        role: 'admin',
        createdAt: new Date().toISOString(),
      });
      const { workspace: soleWs } = await repo.createWorkspace(
        { id: 'ws_sole_extra', name: 'Sole Extra', slug: 'sole-extra' },
        regABody.user.id
      );

      // Delete A without CSRF header must fail with 403
      const noCsrf = await fetch(`${srv.baseUrl}/api/auth/account`, {
        method: 'DELETE',
        headers: { Cookie: cookieA },
      });
      assert.equal(noCsrf.status, 403);

      // Delete A with CSRF header succeeds
      const del1 = await fetch(`${srv.baseUrl}/api/auth/account`, {
        method: 'DELETE',
        headers: { Cookie: cookieA, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(del1.status, 200);
      const delBody: any = await del1.json();
      assert.equal(delBody.success, true);
      assert.equal(delBody.deletedUserId, regABody.user.id);
      assert.ok(delBody.deletedWorkspaceIds.includes(soleWs.id));
      assert.ok(!delBody.deletedWorkspaceIds.includes(regABody.workspace.id));
      assert.ok(delBody.preservedSharedWorkspaceIds.includes(regABody.workspace.id));
      assert.ok(await repo.getWorkspaceById(regABody.workspace.id));
      assert.equal(await repo.getWorkspaceById(soleWs.id), null);

      // Replay DELETE with deleted user's old cookie is rejected cleanly (401)
      const del2 = await fetch(`${srv.baseUrl}/api/auth/account`, {
        method: 'DELETE',
        headers: { Cookie: cookieA, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(del2.status, 401);

      // Co-member user2 still exists and retains membership in Shared WS
      assert.ok(await repo.getUserById(user2.id));
      assert.ok(await repo.getMembership(regABody.workspace.id, user2.id));
    } finally {
      await srv.close();
    }
  });

  test('5. Negative false-positive check: S4-TENANT-ISOLATION-STRICT fails if catalog endpoint leaks Tenant A marker', async () => {
    const repo = new MemoryRepository(false);
    let markerSeen = '';
    const srv = await startEphemeralServer(repo, (req, res) => {
      if (req.url === '/api/catalog' && req.headers['x-workspace-id']) {
        // Simulate a buggy endpoint that honors tampered x-workspace-id header!
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            workspaceId: req.headers['x-workspace-id'],
            products: [{ id: 'leaked', title: markerSeen || 'Leaked Product' }],
          })
        );
        return true;
      }
      return false;
    });

    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification();
          assert.equal(summary.status, 'FAIL');
          const isoCheck = summary.checks.find((c) => c.testId === 'S4-TENANT-ISOLATION-STRICT');
          assert.equal(isoCheck?.status, 'FAIL');
          assert.match(isoCheck?.blockerOrFailure || '', /Cross-tenant catalog scope leak/);
          // Even on isolation failure, cleanup still cleaned up!
          assert.equal(summary.cleanupReport?.status, 'CLEANED');
        })
      );
    } finally {
      await srv.close();
    }
  });

  test('6. Non-production guard refuses production STAGING_BASE_URL hostnames and APP_URL match in production', async () => {
    await withEnvOverrides(
      buildLocalStagingEnv('https://app.aixshop.io'),
      async () => {
        const summary = await runStagingE2EVerification();
        assert.equal(summary.status, 'FAIL');
        assert.equal(summary.checks[0].testId, 'S4-STAGING-HEALTH-ISOLATION');
        assert.equal(summary.checks[0].status, 'FAIL');
        assert.match(summary.checks[0].blockerOrFailure || '', /PRODUCTION_TARGET_REJECTED/);
        assert.ok(summary.checks.slice(1).every((c) => c.status === 'BLOCKED'));
      }
    );

    await withEnvOverrides(
      buildLocalStagingEnv('https://staging.example.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://staging.example.com',
      }),
      async () => {
        const summary = await runStagingE2EVerification();
        assert.equal(summary.status, 'FAIL');
        assert.match(summary.checks[0].blockerOrFailure || '', /PRODUCTION_TARGET_REJECTED/);
      }
    );
  });

  test('7. Cleanup expires cs_test_ Stripe Checkout Sessions and surfaces PARTIAL_CLEANUP if expiration fails', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startEphemeralServer(repo, (req, res) => {
      if (req.url === '/api/billing/checkout-session' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.tier === 'InvalidTier') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid tier' }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              success: true,
              provider: 'stripe',
              sessionId: 'cs_test_staging_expire_1',
              checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_staging_expire_1',
            })
          );
        });
        return true;
      }
      return false;
    });

    try {
      const expiredCalled: string[] = [];
      const mockStripeOk: any = {
        checkout: {
          sessions: {
            expire: async (id: string) => {
              expiredCalled.push(id);
              return { id, status: 'expired' };
            },
            retrieve: async (id: string) => ({ id, status: 'expired' }),
          },
        },
      };

      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification({ stripeClient: mockStripeOk });
          assert.equal(summary.status, 'PASS');
          assert.deepEqual(expiredCalled, ['cs_test_staging_expire_1']);
          assert.deepEqual(summary.cleanupReport?.expiredCheckoutSessionIds, ['cs_test_staging_expire_1']);
          assert.deepEqual(summary.cleanupReport?.failedCheckoutSessionIds, []);
          assert.equal(summary.cleanupReport?.status, 'CLEANED');
        })
      );

      // Failure to expire Stripe checkout session must fail cleanup honestly (never silently report CLEANED)
      const mockStripeFail: any = {
        checkout: {
          sessions: {
            expire: async () => {
              throw new Error('Stripe session expire timeout');
            },
            retrieve: async (id: string) => ({ id, status: 'open' }),
          },
        },
      };

      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification({ stripeClient: mockStripeFail });
          assert.equal(summary.status, 'FAIL');
          assert.equal(summary.cleanupReport?.status, 'PARTIAL_CLEANUP');
          assert.deepEqual(summary.cleanupReport?.failedCheckoutSessionIds, ['cs_test_staging_expire_1']);
          const cleanupCheck = summary.checks.find((c) => c.testId === 'S4-STAGING-CLEANUP');
          assert.equal(cleanupCheck?.status, 'FAIL');
        })
      );
    } finally {
      await srv.close();
    }
  });

  test('8. Cleanup fails S4-STAGING-CLEANUP if /api/auth/me does not return 401 after account deletion', async () => {
    const repo = new MemoryRepository(false);
    let accountDeleted = false;
    const srv = await startEphemeralServer(repo, (req, res) => {
      if (req.url === '/api/auth/account' && req.method === 'DELETE') {
        accountDeleted = true;
      }
      if (accountDeleted && req.url === '/api/auth/me' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ user: { id: 'still_alive' } }));
        return true;
      }
      return false;
    });

    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(buildLocalStagingEnv(srv.baseUrl), async () => {
          const summary = await runStagingE2EVerification();
          assert.equal(summary.status, 'FAIL');
          assert.equal(summary.cleanupReport?.status, 'PARTIAL_CLEANUP');
          assert.ok(summary.cleanupReport?.errors.some((e) => e.includes('returned HTTP 200 instead of 401')));
          const cleanupCheck = summary.checks.find((c) => c.testId === 'S4-STAGING-CLEANUP');
          assert.equal(cleanupCheck?.status, 'FAIL');
        })
      );
    } finally {
      await srv.close();
    }
  });
});

