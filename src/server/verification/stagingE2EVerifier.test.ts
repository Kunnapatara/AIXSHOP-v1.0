import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';
import { createApp } from '../app';
import { MemoryRepository } from '../db/memoryRepository';
import { setCustomEmailTransport } from '../services/emailService';
import { runStagingE2EVerification } from './stagingE2EVerifier';
import {
  evaluateCommercialReadiness,
  parseProductionAppUrlHost,
  parseProductionHosts,
  parseStagingAllowedHosts,
  resolveProductionDenylist,
  validateStagingBaseUrlNonProduction,
} from './statusModel';

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

  test('6. Non-production guard refuses production STAGING_BASE_URL hostnames and missing remote denylist while allowing staging APP_URL in NODE_ENV=production', async () => {
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

    // Remote staging without explicit PRODUCTION_HOSTS / PRODUCTION_APP_URL fails closed even when NODE_ENV=production & APP_URL matches staging host
    await withEnvOverrides(
      buildLocalStagingEnv('https://staging.example.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://staging.example.com',
        STAGING_ALLOW_LOCAL: 'false',
        STAGING_ALLOWED_HOSTS: 'staging.example.com',
      }),
      async () => {
        const summary = await runStagingE2EVerification();
        assert.equal(summary.status, 'FAIL');
        assert.match(summary.checks[0].blockerOrFailure || '', /STAGING_TARGET_REJECTED.*PRODUCTION_DENYLIST_MISSING/);
      }
    );

    // Explicit PRODUCTION_HOSTS rejects production hostname even in NODE_ENV=production, while staging APP_URL is allowed when denylist excludes it
    await withEnvOverrides(
      buildLocalStagingEnv('https://shop.customer.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://staging.example.com',
        STAGING_ALLOW_LOCAL: 'false',
        STAGING_ALLOWED_HOSTS: 'staging.example.com',
        PRODUCTION_HOSTS: 'shop.customer.com',
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

describe('Fix B — Staging Environment Allowlist & URL Safety Protection', () => {
  test('B1: Valid HTTPS host in STAGING_ALLOWED_HOSTS with explicit production denylist passes URL & allowlist validation cleanly', () => {
    const parsed = parseStagingAllowedHosts('staging.aixshop.example.com, QA-Staging.Example.org.');
    assert.equal(parsed.valid, true);
    assert.ok(parsed.hosts.has('staging.aixshop.example.com'));
    assert.ok(parsed.hosts.has('qa-staging.example.org'));

    const res = validateStagingBaseUrlNonProduction('https://STAGING.aixshop.example.com:8443/', {
      allowedHosts: 'staging.aixshop.example.com,qa-staging.example.org',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
    });
    assert.equal(res.valid, true);
    assert.equal(res.isProductionTarget, false);
    assert.equal(res.isLocalTarget, false);
  });

  test('B2: Rejects unallowlisted hosts, empty allowlist (even with STAGING_CONFIRM_NON_PRODUCTION=true), lookalike domains, userinfo, remote HTTP, wildcards, and loopback in remote mode', () => {
    // 1. Empty/unset allowlist rejected even when STAGING_CONFIRM_NON_PRODUCTION=true
    const noAllowlist = validateStagingBaseUrlNonProduction('https://staging.example.com', {
      allowedHosts: '',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
    });
    assert.equal(noAllowlist.valid, false);
    assert.match(noAllowlist.reason || '', /STAGING_ALLOWED_HOSTS/);

    // 2. Host not in allowlist rejected
    const notAllowed = validateStagingBaseUrlNonProduction('https://other-staging.example.com', {
      allowedHosts: 'staging.example.com',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
    });
    assert.equal(notAllowed.valid, false);
    assert.match(notAllowed.reason || '', /STAGING_HOST_NOT_ALLOWED/);

    // 3. Lookalike suffix/prefix hosts rejected (exact match only)
    const lookalikeSuffix = validateStagingBaseUrlNonProduction('https://staging.example.com.attacker.com', {
      allowedHosts: 'staging.example.com',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
    });
    assert.equal(lookalikeSuffix.valid, false);

    const lookalikeSubdomain = validateStagingBaseUrlNonProduction('https://evil.staging.example.com', {
      allowedHosts: 'staging.example.com',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
    });
    assert.equal(lookalikeSubdomain.valid, false);

    // 4. Production hosts rejected (including prod.* and aixshop.io/com/app)
    const prodDomain = validateStagingBaseUrlNonProduction('https://prod.example.com', {
      allowedHosts: 'prod.example.com',
      allowLocalMode: false,
    });
    assert.equal(prodDomain.valid, false);
    assert.equal(prodDomain.isProductionTarget, true);

    // 5. Embedded credentials / userinfo rejected
    const userinfo = validateStagingBaseUrlNonProduction('https://staging.example.com@evil.com', {
      allowedHosts: 'staging.example.com,evil.com',
      allowLocalMode: false,
    });
    assert.equal(userinfo.valid, false);
    assert.match(userinfo.reason || '', /credentials|userinfo/i);

    const userPass = validateStagingBaseUrlNonProduction('https://user:pass@staging.example.com', {
      allowedHosts: 'staging.example.com',
      allowLocalMode: false,
    });
    assert.equal(userPass.valid, false);

    // 6. Remote HTTP rejected even if host is in allowlist AND even if allowLocalMode=true
    const remoteHttp = validateStagingBaseUrlNonProduction('http://staging.example.com', {
      allowedHosts: 'staging.example.com',
      allowLocalMode: true,
    });
    assert.equal(remoteHttp.valid, false);
    assert.match(remoteHttp.reason || '', /https:\/\//i);

    // 7. Wildcards & URL-like entries in STAGING_ALLOWED_HOSTS rejected
    assert.equal(parseStagingAllowedHosts('*.example.com').valid, false);
    assert.equal(parseStagingAllowedHosts('https://staging.example.com').valid, false);
    assert.equal(parseStagingAllowedHosts('staging.example.com:8443').valid, false);

    // 8. Localhost / loopback rejected in remote mode (allowLocalMode=false)
    for (const localUrl of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
    ]) {
      const localRejected = validateStagingBaseUrlNonProduction(localUrl, {
        allowedHosts: 'staging.example.com',
        allowLocalMode: false,
      });
      assert.equal(localRejected.valid, false, `Expected ${localUrl} to be rejected in remote mode`);
    }

    // 9. Malformed URLs & private IPs rejected
    assert.equal(
      validateStagingBaseUrlNonProduction('https://staging.example.com\\@evil.com', {
        allowedHosts: 'staging.example.com',
      }).valid,
      false
    );
    assert.equal(
      validateStagingBaseUrlNonProduction('https://169.254.169.254/latest/meta-data', {
        allowedHosts: '169.254.169.254',
      }).valid,
      false
    );
  });

  test('B3: runStagingE2EVerification rejects invalid/unallowlisted STAGING_BASE_URL BEFORE any HTTP request or account creation', async () => {
    const repo = new MemoryRepository(false);
    let requestsObserved = 0;
    const srv = await startEphemeralServer(repo, () => {
      requestsObserved++;
      return false;
    });

    try {
      const spyFetch: typeof fetch = async (...args) => {
        requestsObserved++;
        return originalFetch(...args);
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = spyFetch;
      try {
        const scenarios: Array<{ label: string; env: Record<string, string | undefined>; expectedPattern: RegExp }> = [
          {
            label: 'loopback when STAGING_ALLOW_LOCAL is false',
            env: buildLocalStagingEnv(srv.baseUrl, {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: 'staging.example.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_TARGET_REJECTED/,
          },
          {
            label: 'unallowlisted remote host even with STAGING_CONFIRM_NON_PRODUCTION=true',
            env: buildLocalStagingEnv('https://untrusted.example.com', {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: 'staging.example.com',
              PRODUCTION_HOSTS: 'shop.customer.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_TARGET_REJECTED.*STAGING_HOST_NOT_ALLOWED/,
          },
          {
            label: 'empty STAGING_ALLOWED_HOSTS with STAGING_CONFIRM_NON_PRODUCTION=true',
            env: buildLocalStagingEnv('https://staging.example.com', {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: '',
              PRODUCTION_HOSTS: 'shop.customer.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_TARGET_REJECTED.*STAGING_ALLOWED_HOSTS/,
          },
          {
            label: 'lookalike suffix host',
            env: buildLocalStagingEnv('https://staging.example.com.attacker.com', {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: 'staging.example.com',
              PRODUCTION_HOSTS: 'shop.customer.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_HOST_NOT_ALLOWED/,
          },
          {
            label: 'embedded userinfo',
            env: buildLocalStagingEnv('https://staging.example.com@evil.com', {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: 'staging.example.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_TARGET_REJECTED/,
          },
          {
            label: 'remote plain http',
            env: buildLocalStagingEnv('http://staging.example.com', {
              STAGING_ALLOW_LOCAL: 'false',
              STAGING_ALLOWED_HOSTS: 'staging.example.com',
              STAGING_CONFIRM_NON_PRODUCTION: 'true',
            }),
            expectedPattern: /STAGING_TARGET_REJECTED.*https:\/\//i,
          },
        ];

        for (const sc of scenarios) {
          await withEnvOverrides(sc.env, async () => {
            const summary = await runStagingE2EVerification();
            assert.equal(summary.status, 'FAIL', `Expected FAIL for scenario: ${sc.label}`);
            assert.equal(summary.checks[0].status, 'FAIL', `Expected check 0 FAIL for: ${sc.label}`);
            assert.match(summary.checks[0].blockerOrFailure || '', sc.expectedPattern, sc.label);
            assert.ok(summary.checks.slice(1).every((c) => c.status === 'BLOCKED'), sc.label);
            assert.equal(summary.cleanupReport?.status, 'NONE_CREATED', sc.label);
            assert.deepEqual(summary.cleanupReport?.trackedResources.userIds, [], sc.label);
          });
        }

        assert.equal(requestsObserved, 0, 'Expected ZERO HTTP requests or account creation calls');
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await srv.close();
    }
  });
});

describe('Task A — Staging Environment Separation & Explicit Production Host Denylist Protection', () => {
  test('A1: Rejects custom PRODUCTION_HOSTS hostname even when also listed in STAGING_ALLOWED_HOSTS', () => {
    const res = validateStagingBaseUrlNonProduction('https://shop.customer.com', {
      allowedHosts: 'shop.customer.com,staging-shop.customer.com',
      productionHosts: 'shop.customer.com',
      allowLocalMode: false,
      nodeEnv: 'development',
    });
    assert.equal(res.valid, false);
    assert.equal(res.isProductionTarget, true);
    assert.match(res.reason || '', /PRODUCTION_HOSTS/);

    const contradictoryAllowlist = parseStagingAllowedHosts('shop.customer.com', {
      productionHosts: 'shop.customer.com',
    });
    assert.equal(contradictoryAllowlist.valid, false);
    assert.match(contradictoryAllowlist.reason || '', /cannot include production domain/i);
  });

  test('A2: NODE_ENV=production staging deployment with APP_URL matching STAGING_BASE_URL is ALLOWED when valid denylist & allowlist exclude it', async () => {
    // 1. Valid staging target running under NODE_ENV=production where APP_URL is the staging deployment URL itself
    const allowedInProdMode = validateStagingBaseUrlNonProduction('https://staging.customer.com', {
      allowedHosts: 'staging.customer.com',
      productionHosts: 'shop.customer.com',
      productionAppUrl: 'https://checkout.customer.com',
      appUrl: 'https://staging.customer.com',
      nodeEnv: 'production',
      allowLocalMode: false,
    });
    assert.equal(allowedInProdMode.valid, true);
    assert.equal(allowedInProdMode.isProductionTarget, false);

    // 2. Same check via evaluateCommercialReadiness() in NODE_ENV=production
    await withEnvOverrides(
      buildLocalStagingEnv('https://staging.customer.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://staging.customer.com',
        SHOPIFY_APP_URL: 'https://staging.customer.com',
        STAGING_ALLOW_LOCAL: 'false',
        STAGING_ALLOWED_HOSTS: 'staging.customer.com',
        PRODUCTION_HOSTS: 'shop.customer.com',
        PRODUCTION_APP_URL: 'https://checkout.customer.com',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
      () => {
        const readiness = evaluateCommercialReadiness();
        assert.equal(readiness.integrations.stage_4_staging_e2e.status, 'READY');
        assert.deepEqual(readiness.integrations.stage_4_staging_e2e.missingEnvVars, []);
      }
    );

    // 3. Explicit PRODUCTION_HOSTS and PRODUCTION_APP_URL still reject matching targets across ALL NODE_ENV values
    for (const nodeEnv of ['development', 'test', 'production']) {
      const fromProdHosts = validateStagingBaseUrlNonProduction('https://shop.customer.com', {
        allowedHosts: 'staging-shop.customer.com',
        productionHosts: 'shop.customer.com',
        appUrl: 'https://staging-shop.customer.com',
        nodeEnv,
      });
      assert.equal(fromProdHosts.valid, false, `Expected rejection in NODE_ENV=${nodeEnv}`);
      assert.equal(fromProdHosts.isProductionTarget, true, `Expected isProductionTarget in NODE_ENV=${nodeEnv}`);

      const fromProdAppUrl = validateStagingBaseUrlNonProduction('https://checkout.customer.com', {
        allowedHosts: 'staging-shop.customer.com',
        productionAppUrl: 'https://checkout.customer.com',
        appUrl: 'https://staging-shop.customer.com',
        nodeEnv,
      });
      assert.equal(fromProdAppUrl.valid, false, `Expected PRODUCTION_APP_URL rejection in NODE_ENV=${nodeEnv}`);
      assert.equal(fromProdAppUrl.isProductionTarget, true);
    }
  });

  test('A3: Remote staging with empty/unset PRODUCTION_HOSTS and PRODUCTION_APP_URL fails closed (PRODUCTION_DENYLIST_MISSING), while STAGING_ALLOW_LOCAL=true works cleanly', async () => {
    // 1. Both empty in remote mode -> REJECTED even if STAGING_ALLOWED_HOSTS & STAGING_CONFIRM_NON_PRODUCTION=true are set
    const missingDenylist = validateStagingBaseUrlNonProduction('https://staging.customer.com', {
      allowedHosts: 'staging.customer.com',
      productionHosts: '',
      productionAppUrl: '',
      allowLocalMode: false,
      nodeEnv: 'production',
      appUrl: 'https://staging.customer.com',
    });
    assert.equal(missingDenylist.valid, false);
    assert.equal(missingDenylist.isProductionTarget, false);
    assert.match(missingDenylist.reason || '', /PRODUCTION_DENYLIST_MISSING/);

    // 2. evaluateCommercialReadiness flags missing explicit production denylist for remote staging
    await withEnvOverrides(
      buildLocalStagingEnv('https://staging.customer.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://staging.customer.com',
        SHOPIFY_APP_URL: 'https://staging.customer.com',
        STAGING_ALLOW_LOCAL: 'false',
        STAGING_ALLOWED_HOSTS: 'staging.customer.com',
        PRODUCTION_HOSTS: undefined,
        PRODUCTION_APP_URL: undefined,
      }),
      () => {
        const readiness = evaluateCommercialReadiness();
        assert.equal(readiness.integrations.stage_4_staging_e2e.status, 'BLOCKED');
        assert.ok(
          readiness.integrations.stage_4_staging_e2e.missingEnvVars.some((m) =>
            m.includes('PRODUCTION_HOSTS or PRODUCTION_APP_URL')
          )
        );
      }
    );

    // 3. Only PRODUCTION_APP_URL set is accepted as an explicit production denylist
    const prodAppUrlOnly = validateStagingBaseUrlNonProduction('https://staging.customer.com', {
      allowedHosts: 'staging.customer.com',
      productionAppUrl: 'https://shop.customer.com',
      allowLocalMode: false,
      nodeEnv: 'production',
    });
    assert.equal(prodAppUrlOnly.valid, true);

    // 4. STAGING_ALLOW_LOCAL=true with loopback does NOT require remote denylist (existing local tests remain green)
    const localStillAllowed = validateStagingBaseUrlNonProduction('http://127.0.0.1:45123', {
      allowLocalMode: true,
      productionHosts: '',
      productionAppUrl: '',
    });
    assert.equal(localStillAllowed.valid, true);
    assert.equal(localStillAllowed.isLocalTarget, true);
  });

  test('A4: Accepts legitimate HTTPS staging hostname in STAGING_ALLOWED_HOSTS when excluded from denylist, using exact match only (no substring heuristics)', () => {
    // Non-identical similar hostnames: "shop.customer.com" does not false-block "staging-shop.customer.com", "staging.shop.customer.com", or neutral custom staging host "preview-1.customer-sandbox.net"
    for (const candidate of [
      'https://staging-shop.customer.com',
      'https://staging.shop.customer.com',
      'https://preview-1.customer-sandbox.net',
    ]) {
      const host = new URL(candidate).hostname;
      const res = validateStagingBaseUrlNonProduction(candidate, {
        allowedHosts: 'staging-shop.customer.com,staging.shop.customer.com,preview-1.customer-sandbox.net',
        productionHosts: 'shop.customer.com',
        productionAppUrl: 'https://checkout.customer.com',
        nodeEnv: 'production',
        appUrl: candidate,
      });
      assert.equal(res.valid, true, `Expected ${host} to pass exact-match validation`);
      assert.equal(res.isProductionTarget, false);
    }

    // Lookalike suffix/prefix domains are still rejected when not in STAGING_ALLOWED_HOSTS
    const lookalikeEvil = validateStagingBaseUrlNonProduction('https://shop.customer.com.evil.com', {
      allowedHosts: 'staging-shop.customer.com',
      productionHosts: 'shop.customer.com',
    });
    assert.equal(lookalikeEvil.valid, false);
  });

  test('A5: Case normalization, trailing-dot normalization, and multiple comma-separated PRODUCTION_HOSTS + PRODUCTION_APP_URL', () => {
    const multiple = validateStagingBaseUrlNonProduction('https://Shop.Customer.COM.', {
      allowedHosts: 'staging-shop.customer.com',
      productionHosts: 'api.customer.com, SHOP.CUSTOMER.COM , checkout.customer.com.',
      productionAppUrl: 'https://Storefront.Customer.COM.:8443',
      nodeEnv: 'development',
    });
    assert.equal(multiple.valid, false);
    assert.equal(multiple.isProductionTarget, true);

    const fromMixedCaseProdUrl = validateStagingBaseUrlNonProduction('https://storefront.customer.com', {
      allowedHosts: 'staging-shop.customer.com',
      productionHosts: 'api.customer.com,checkout.customer.com',
      productionAppUrl: 'https://Storefront.Customer.COM.',
      nodeEnv: 'test',
    });
    assert.equal(fromMixedCaseProdUrl.valid, false);
    assert.equal(fromMixedCaseProdUrl.isProductionTarget, true);

    const parsedDenylist = resolveProductionDenylist({
      productionHosts: 'API.Customer.COM., checkout.customer.com',
      productionAppUrl: 'https://Storefront.Customer.COM.',
    });
    assert.equal(parsedDenylist.valid, true);
    assert.equal(parsedDenylist.configured, true);
    assert.ok(parsedDenylist.hosts.has('api.customer.com'));
    assert.ok(parsedDenylist.hosts.has('checkout.customer.com'));
    assert.ok(parsedDenylist.hosts.has('storefront.customer.com'));
  });

  test('A6: Malformed PRODUCTION_HOSTS and PRODUCTION_APP_URL fail closed', () => {
    assert.equal(parseProductionHosts('*.customer.com').valid, false);
    assert.equal(parseProductionHosts('https://shop.customer.com').valid, false);
    assert.equal(parseProductionHosts('shop.customer.com,').valid, false);
    assert.equal(parseProductionHosts('shop.customer.com:8443').valid, false);

    assert.equal(parseProductionAppUrlHost('http://shop.customer.com').valid, false);
    assert.equal(parseProductionAppUrlHost('not-a-url').valid, false);
    assert.equal(parseProductionAppUrlHost('https://user@shop.customer.com').valid, false);
    assert.equal(parseProductionAppUrlHost('https://127.0.0.1').valid, false);
    assert.equal(parseProductionAppUrlHost('https://shop.customer.com?foo=bar').valid, false);

    const failClosed = validateStagingBaseUrlNonProduction('https://staging.customer.com', {
      allowedHosts: 'staging.customer.com',
      productionHosts: '*.customer.com',
      nodeEnv: 'development',
    });
    assert.equal(failClosed.valid, false);
    assert.match(failClosed.reason || '', /PRODUCTION_HOSTS/);

    const failClosedUrl = validateStagingBaseUrlNonProduction('https://staging.customer.com', {
      allowedHosts: 'staging.customer.com',
      productionAppUrl: 'http://insecure-prod.customer.com',
      nodeEnv: 'development',
    });
    assert.equal(failClosedUrl.valid, false);
    assert.match(failClosedUrl.reason || '', /PRODUCTION_APP_URL/);
  });

  test('A7: runStagingE2EVerification performs 0 HTTP requests on production denylist rejection, missing remote denylist, or malformed denylist', async () => {
    let requestsObserved = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      requestsObserved++;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const rejectScenarios: Array<{ label: string; env: Record<string, string | undefined>; expectedPattern: RegExp }> = [
        {
          label: 'PRODUCTION_HOSTS overlap with STAGING_ALLOWED_HOSTS in development',
          env: buildLocalStagingEnv('https://shop.customer.com', {
            NODE_ENV: 'development',
            STAGING_ALLOW_LOCAL: 'false',
            STAGING_ALLOWED_HOSTS: 'shop.customer.com',
            PRODUCTION_HOSTS: 'shop.customer.com',
          }),
          expectedPattern: /PRODUCTION_TARGET_REJECTED/,
        },
        {
          label: 'PRODUCTION_APP_URL match with trailing dot in NODE_ENV=production',
          env: buildLocalStagingEnv('https://Storefront.Customer.COM.', {
            NODE_ENV: 'production',
            APP_URL: 'https://staging.customer.com',
            STAGING_ALLOW_LOCAL: 'false',
            STAGING_ALLOWED_HOSTS: 'staging.customer.com',
            PRODUCTION_APP_URL: 'https://storefront.customer.com',
          }),
          expectedPattern: /PRODUCTION_TARGET_REJECTED/,
        },
        {
          label: 'Remote target missing explicit PRODUCTION_HOSTS and PRODUCTION_APP_URL',
          env: buildLocalStagingEnv('https://staging.customer.com', {
            NODE_ENV: 'production',
            APP_URL: 'https://staging.customer.com',
            STAGING_ALLOW_LOCAL: 'false',
            STAGING_ALLOWED_HOSTS: 'staging.customer.com',
            PRODUCTION_HOSTS: undefined,
            PRODUCTION_APP_URL: undefined,
          }),
          expectedPattern: /STAGING_TARGET_REJECTED.*PRODUCTION_DENYLIST_MISSING/,
        },
        {
          label: 'Malformed PRODUCTION_HOSTS even with unset STAGING_BASE_URL',
          env: {
            ...buildLocalStagingEnv('', {
              NODE_ENV: 'development',
              STAGING_BASE_URL: undefined,
              PRODUCTION_HOSTS: '*.customer.com',
            }),
          },
          expectedPattern: /STAGING_TARGET_REJECTED.*PRODUCTION_HOSTS/,
        },
        {
          label: 'Malformed PRODUCTION_APP_URL',
          env: buildLocalStagingEnv('https://staging.customer.com', {
            NODE_ENV: 'development',
            STAGING_ALLOW_LOCAL: 'false',
            STAGING_ALLOWED_HOSTS: 'staging.customer.com',
            PRODUCTION_APP_URL: 'https://user:pass@shop.customer.com',
          }),
          expectedPattern: /STAGING_TARGET_REJECTED.*PRODUCTION_APP_URL/,
        },
      ];

      for (const sc of rejectScenarios) {
        await withEnvOverrides(sc.env, async () => {
          const summary = await runStagingE2EVerification();
          assert.equal(summary.status, 'FAIL', sc.label);
          assert.equal(summary.checks[0].status, 'FAIL', sc.label);
          assert.match(summary.checks[0].blockerOrFailure || '', sc.expectedPattern, sc.label);
          assert.ok(summary.checks.slice(1).every((c) => c.status === 'BLOCKED'), sc.label);
          assert.equal(summary.cleanupReport?.status, 'NONE_CREATED', sc.label);
        });
      }

      assert.equal(requestsObserved, 0, 'Expected zero outbound HTTP requests when rejected before HTTP execution');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('A8: End-to-end runStagingE2EVerification executes cleanly when NODE_ENV=production and APP_URL equals staging host (remote HTTPS & local)', async () => {
    const readyHealthIntercept = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === '/api/health/ready' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', probe: 'readiness', database: { connected: true, schemaReady: true } }));
        return true;
      }
      return false;
    };

    // 1. Remote HTTPS staging deployment running with NODE_ENV=production & APP_URL=https://staging.customer.com (routed in-memory to ephemeral server)
    const remoteRepo = new MemoryRepository(false);
    const remoteSrv = await startEphemeralServer(remoteRepo, readyHealthIntercept);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const rewritten = rawUrl.startsWith('https://staging.customer.com')
        ? rawUrl.replace('https://staging.customer.com', remoteSrv.baseUrl)
        : rawUrl;
      return originalFetch(rewritten, init);
    }) as typeof fetch;

    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(
          buildLocalStagingEnv('https://staging.customer.com', {
            NODE_ENV: 'production',
            APP_URL: 'https://staging.customer.com',
            SHOPIFY_APP_URL: 'https://staging.customer.com',
            STAGING_ALLOW_LOCAL: 'false',
            STAGING_ALLOWED_HOSTS: 'staging.customer.com',
            PRODUCTION_HOSTS: 'shop.customer.com,checkout.customer.com',
            PRODUCTION_APP_URL: 'https://storefront.customer.com',
          }),
          async () => {
            const summary = await runStagingE2EVerification({ targetEnvironment: 'staging-node-env-prod' });
            assert.equal(summary.status, 'PASS');
            assert.equal(summary.counts.fail, 0);
            assert.equal(summary.cleanupReport?.status, 'CLEANED');
          }
        )
      );
    } finally {
      globalThis.fetch = originalFetch;
      await remoteSrv.close();
    }

    // 2. Local server mode (STAGING_ALLOW_LOCAL=true) preserves non-production local testing cleanly
    const localRepo = new MemoryRepository(false);
    const localSrv = await startEphemeralServer(localRepo);
    try {
      await withMockEmailTransport(() =>
        withEnvOverrides(
          buildLocalStagingEnv(localSrv.baseUrl, {
            NODE_ENV: 'test',
            PRODUCTION_HOSTS: 'shop.customer.com,checkout.customer.com',
            PRODUCTION_APP_URL: 'https://storefront.customer.com',
          }),
          async () => {
            const summary = await runStagingE2EVerification();
            assert.equal(summary.status, 'PASS');
            assert.equal(summary.cleanupReport?.status, 'CLEANED');
          }
        )
      );
    } finally {
      await localSrv.close();
    }
  });
});



