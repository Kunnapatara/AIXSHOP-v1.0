import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { _resetRateLimiter } from './middleware/auth';
import { clearDevEmailOutbox, getDevEmailOutbox, sendPasswordResetEmail } from './services/emailService';
import { SandboxBillingProvider, setBillingProvider } from './billing/providerAdapter';
import { hashSessionToken } from './security/tokens';
import { encryptCredential } from './security/encryption';

describe('AIXSHOP v1.0 — Commercial Paywall, Workstream B (Auth/Recovery) & Workstream C (Hardening)', () => {
  const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  let repo: MemoryRepository;
  let server: http.Server;
  let baseUrl: string;
  let sandboxProvider: SandboxBillingProvider;

  function extractSessionCookie(res: Response): string {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const m = raw.match(/aixshop_session=([^;]+)/);
      if (m?.[1]) return m[1];
    }
    const single = res.headers.get('set-cookie') || '';
    const m = single.match(/aixshop_session=([^;]+)/);
    return m?.[1] || '';
  }

  function buildCookieHeader(cookieToken: string) {
    return {
      Cookie: `aixshop_session=${cookieToken}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  async function registerMerchant(email: string, workspaceName: string, password = 'Password123!') {
    const res = await originalFetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        email,
        password,
        fullName: 'Merchant Owner',
        workspaceName,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.token, undefined, 'Registration JSON must never expose raw session token');
    const cookieToken = extractSessionCookie(res);
    assert.ok(cookieToken, 'HttpOnly aixshop_session cookie must be set');
    return {
      res,
      cookieToken,
      user: body.user,
      workspace: body.workspace,
    };
  }

  async function seedCatalogWithIssue(workspaceId: string) {
    const importRes = await repo.importCatalog(workspaceId, [
      {
        id: `prod_seed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: 'Porcelain Espresso Cup',
        brand: 'Kanso Goods',
        category: 'Drinkware',
        description: 'Dishwasher-safe porcelain espresso cup with 90ml capacity.',
        image: 'https://cdn.example.com/cup.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [
          {
            id: `v_seed_${Date.now()}`,
            sku: 'KNS-ESP-01',
            title: 'Default',
            barcode: '', // missing GTIN on non-exempt item triggers finding + action
            price: 24.0,
            inventoryCount: 10,
            attributes: {},
          },
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
      },
    ]);
    assert.equal(importRes.importedCount, 1);
    const catalog = await repo.loadWorkspaceCatalog(workspaceId);
    assert.ok(catalog && catalog.products.length === 1);
    const auditRes = await repo.executeWorkspaceAudit(workspaceId);
    assert.ok(auditRes.catalog.findings.length > 0, 'Audit must generate at least one finding');
    assert.ok(auditRes.catalog.actions.length > 0, 'Audit must generate at least one action');
    return {
      auditRun: auditRes.auditRun,
      finding: auditRes.catalog.findings[0],
      action: auditRes.catalog.actions[0],
    };
  }

  before(async () => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
    repo = new MemoryRepository(false);
    sandboxProvider = new SandboxBillingProvider('commercial_test_webhook_secret');
    setBillingProvider(sandboxProvider);

    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.APP_URL = baseUrl;
        process.env.SHOPIFY_APP_URL = baseUrl;
        resolve();
      });
    });
  });

  after(async () => {
    setBillingProvider(null);
    globalThis.fetch = originalFetch;
    _resetRateLimiter();
    clearDevEmailOutbox();
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    _resetRateLimiter();
    clearDevEmailOutbox();
    globalThis.fetch = originalFetch;
  });

  describe('1. Commercial Product Model & Backend Paywall Enforcement', () => {
    test('GET /api/billing/plans defines Free Audit as non-recurring (billingInterval=none) and preserves paid monthly SKU capacities', async () => {
      const res = await originalFetch(`${baseUrl}/api/billing/plans`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const data = await res.json();

      assert.equal(data.currency, 'USD');
      assert.ok(Array.isArray(data.commercialSummary));

      const freePlan = data.plans.find((p: any) => p.tier === 'Free Audit');
      const free = data.commercialSummary.find((p: any) => p.tier === 'Free Audit');
      const starter = data.commercialSummary.find((p: any) => p.tier === 'Starter');
      const growth = data.commercialSummary.find((p: any) => p.tier === 'Growth');
      const enterprise = data.commercialSummary.find((p: any) => p.tier === 'Enterprise');

      assert.ok(freePlan && free && starter && growth && enterprise);
      assert.equal(freePlan.billingInterval, 'none');
      assert.equal(free.priceCents, 0);
      assert.equal(free.billingInterval, 'none');
      assert.equal(free.skuLimit, 2500);
      assert.equal(free.quotaSemantics, 'preliminary_evaluation_capacity');
      assert.equal(free.reportAccess, 'preliminary_only');

      assert.equal(starter.priceCents, 4900);
      assert.equal(starter.billingInterval, 'month');
      assert.equal(starter.skuLimit, 250);
      assert.equal(starter.quotaSemantics, 'verified_monthly_catalog_skus');
      assert.equal(starter.reportAccess, 'full_report_and_remediation');

      assert.equal(growth.priceCents, 14900);
      assert.equal(growth.billingInterval, 'month');
      assert.equal(growth.skuLimit, 2500);
      assert.equal(growth.quotaSemantics, 'verified_monthly_catalog_skus');
      assert.equal(growth.reportAccess, 'full_report_and_remediation');

      assert.equal(enterprise.priceCents, 49900);
      assert.equal(enterprise.billingInterval, 'month');
      assert.equal(enterprise.isUnlimited, true);
      assert.equal(enterprise.skuLimit, null);
      assert.equal(enterprise.quotaSemantics, 'verified_monthly_catalog_skus');
      assert.equal(enterprise.reportAccess, 'full_report_and_remediation');
    });

    test('Free Audit blocks all audit results, scores, summaries, history, discovery, and feed endpoints with 403 + no-store before payment', async () => {
      const merchantA = await registerMerchant('free-paywall-a@example.com', 'Free Paywall Shop A');
      const merchantB = await registerMerchant('free-paywall-b@example.com', 'Free Paywall Shop B');

      const seededA = await seedCatalogWithIssue(merchantA.workspace.id);
      const seededB = await seedCatalogWithIssue(merchantB.workspace.id);

      // 0. Free Audit cannot create checkout sessions or recurring subscriptions
      const freeCheckoutRes = await originalFetch(`${baseUrl}/api/billing/checkout-session`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchantA.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'Free Audit' }),
      });
      assert.equal(freeCheckoutRes.status, 400);

      const subRes = await originalFetch(`${baseUrl}/api/billing/subscription`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(subRes.status, 200);
      assert.equal(subRes.headers.get('cache-control'), 'no-store');
      const subData = await subRes.json();
      assert.equal(subData.subscription.tier, 'Free Audit');
      assert.equal(subData.subscription.billingInterval, 'none');
      assert.equal(subData.subscription.isRecurring, false);
      assert.equal(subData.subscription.provider, 'none');
      assert.equal(subData.reportEntitlement.hasFullReportAccess, false);
      assert.equal(subData.storeProfile.catalogCompletenessAvg, 0);
      assert.equal(subData.storeProfile.evidenceCoverageAvg, undefined);
      assert.equal(subData.storeProfile.lastAuditDate, undefined);

      // 1. GET /api/catalog returns redacted catalog with NO preliminarySummary, NO findings, NO actions, and masked scores
      const catRes = await originalFetch(`${baseUrl}/api/catalog`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(catRes.status, 200);
      assert.equal(catRes.headers.get('cache-control'), 'no-store');
      const catData = await catRes.json();
      assert.equal(catData.reportEntitlement.hasFullReportAccess, false);
      assert.equal(catData.reportEntitlement.accessLevel, 'preliminary');
      assert.equal(catData.reportEntitlement.reasonCode, 'FREE_AUDIT_PRELIMINARY_ONLY');
      assert.equal(catData.preliminarySummary, undefined, 'Must not expose preliminarySummary before payment');
      assert.deepEqual(catData.catalog.findings, []);
      assert.deepEqual(catData.catalog.actions, []);
      assert.equal(catData.catalog.storeProfile?.catalogCompletenessAvg, 0);
      assert.equal(catData.catalog.storeProfile?.evidenceCoverageAvg, undefined);
      assert.equal(catData.catalog.storeProfile?.lastAuditDate, undefined);
      assert.equal(catData.catalog.products[0].findingsCount, 0);
      assert.equal(catData.catalog.products[0].completenessScore, 0);
      assert.equal(catData.catalog.products[0].evidenceCoverageScore, 0);
      assert.equal(catData.catalog.products[0].externalDiscoveryStatus, 'not_checked');

      // 1b. GET /api/store/profile omits audit scores before payment
      const storeRes = await originalFetch(`${baseUrl}/api/store/profile`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(storeRes.status, 200);
      assert.equal(storeRes.headers.get('cache-control'), 'no-store');
      const storeData = await storeRes.json();
      assert.equal(storeData.catalogCompletenessAvg, 0);
      assert.equal(storeData.evidenceCoverageAvg, undefined);
      assert.equal(storeData.lastAuditDate, undefined);

      // 2. POST /api/audit/run is blocked with 403 REPORT_PAYMENT_REQUIRED
      const runRes = await originalFetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(runRes.status, 403);
      assert.equal(runRes.headers.get('cache-control'), 'no-store');
      const runData = await runRes.json();
      assert.equal(runData.code, 'REPORT_PAYMENT_REQUIRED');
      assert.equal(runData.preliminarySummary, undefined);
      assert.equal(runData.auditRun, undefined);
      assert.equal(runData.catalog, undefined);

      // 3. GET /api/audit/latest & GET /api/audit/history are blocked with 403 REPORT_PAYMENT_REQUIRED
      const latestRes = await originalFetch(`${baseUrl}/api/audit/latest`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(latestRes.status, 403);
      assert.equal(latestRes.headers.get('cache-control'), 'no-store');
      assert.equal((await latestRes.json()).code, 'REPORT_PAYMENT_REQUIRED');

      const histRes = await originalFetch(`${baseUrl}/api/audit/history`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(histRes.status, 403);
      assert.equal(histRes.headers.get('cache-control'), 'no-store');
      const histData = await histRes.json();
      assert.equal(histData.code, 'REPORT_PAYMENT_REQUIRED');
      assert.equal(histData.items, undefined);

      // 4. Paid-only routes return 403 REPORT_PAYMENT_REQUIRED + no-store for Free Audit workspace
      const detailRes = await originalFetch(`${baseUrl}/api/audit/${seededA.auditRun.id}`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(detailRes.status, 403);
      assert.equal(detailRes.headers.get('cache-control'), 'no-store');
      assert.equal((await detailRes.json()).code, 'REPORT_PAYMENT_REQUIRED');

      const compareRes = await originalFetch(
        `${baseUrl}/api/audit/compare?baseId=${seededA.auditRun.id}&targetId=${seededA.auditRun.id}`,
        { headers: buildCookieHeader(merchantA.cookieToken) }
      );
      assert.equal(compareRes.status, 403);
      assert.equal(compareRes.headers.get('cache-control'), 'no-store');
      assert.equal((await compareRes.json()).code, 'REPORT_PAYMENT_REQUIRED');

      const feedValidateRes = await originalFetch(`${baseUrl}/api/feed/validate`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchantA.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'google_merchant_center' }),
      });
      assert.equal(feedValidateRes.status, 403);
      assert.equal(feedValidateRes.headers.get('cache-control'), 'no-store');
      const feedValidateBody = await feedValidateRes.json();
      assert.equal(feedValidateBody.code, 'REPORT_PAYMENT_REQUIRED');
      assert.equal(feedValidateBody.report, undefined);

      const discoveryRes = await originalFetch(`${baseUrl}/api/discovery/audit`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(discoveryRes.status, 403);
      assert.equal(discoveryRes.headers.get('cache-control'), 'no-store');
      const discoveryBody = await discoveryRes.json();
      assert.equal(discoveryBody.code, 'REPORT_PAYMENT_REQUIRED');
      assert.equal(discoveryBody.readiness, undefined);
      assert.equal(discoveryBody.hubChecklist, undefined);

      for (const op of ['approve', 'dismiss', 'recheck']) {
        const mutRes = await originalFetch(
          `${baseUrl}/api/catalog/actions/${seededA.action.id}/${op}`,
          {
            method: 'POST',
            headers: { ...buildCookieHeader(merchantA.cookieToken), 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        assert.equal(mutRes.status, 403, `POST /actions/:id/${op} must return 403 on Free Audit`);
        assert.equal((await mutRes.json()).code, 'REPORT_PAYMENT_REQUIRED');
      }

      const exportRes = await originalFetch(`${baseUrl}/api/feed/export?platform=google_merchant_center`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(exportRes.status, 403);
      assert.equal(exportRes.headers.get('cache-control'), 'no-store');
      assert.equal((await exportRes.json()).code, 'REPORT_PAYMENT_REQUIRED');

      // 5. Tenant ownership check MUST still return 404 before paywall 403 on cross-workspace IDs
      const crossAuditRes = await originalFetch(`${baseUrl}/api/audit/${seededB.auditRun.id}`, {
        headers: buildCookieHeader(merchantA.cookieToken),
      });
      assert.equal(crossAuditRes.status, 404);
      assert.equal((await crossAuditRes.json()).code, 'AUDIT_NOT_FOUND');

      const crossActionRes = await originalFetch(
        `${baseUrl}/api/catalog/actions/${seededB.action.id}/approve`,
        {
          method: 'POST',
          headers: { ...buildCookieHeader(merchantA.cookieToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      assert.equal(crossActionRes.status, 404);
      assert.equal((await crossActionRes.json()).code, 'ACTION_NOT_FOUND');
    });

    test('Subscription lifecycle fails closed on lapsed statuses and unlocks on verified active/trialing or checkout verify', async () => {
      const merchant = await registerMerchant('lifecycle-paywall@example.com', 'Lifecycle Shop');
      const otherMerchant = await registerMerchant('lifecycle-other@example.com', 'Other Shop');
      const seeded = await seedCatalogWithIssue(merchant.workspace.id);

      const blockedStatuses: Array<'past_due' | 'canceled' | 'expired' | 'unpaid' | 'incomplete'> = [
        'past_due',
        'canceled',
        'expired',
        'unpaid',
        'incomplete',
      ];

      for (const status of blockedStatuses) {
        await repo.saveSubscription({
          id: `sub_${merchant.workspace.id}`,
          workspaceId: merchant.workspace.id,
          provider: 'sandbox',
          customerId: 'cus_lifecycle',
          subscriptionId: 'sub_lifecycle',
          tier: 'Growth',
          status,
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
          cancelAtPeriodEnd: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const res = await originalFetch(`${baseUrl}/api/audit/${seeded.auditRun.id}`, {
          headers: buildCookieHeader(merchant.cookieToken),
        });
        assert.equal(res.status, 403, `Subscription status "${status}" must fail closed with 403`);
        const body = await res.json();
        assert.equal(body.code, 'REPORT_PAYMENT_REQUIRED');
        assert.equal(body.reportEntitlement.hasFullReportAccess, false);
      }

      // Trialing grants access
      await repo.saveSubscription({
        id: `sub_${merchant.workspace.id}`,
        workspaceId: merchant.workspace.id,
        provider: 'sandbox',
        customerId: 'cus_lifecycle',
        subscriptionId: 'sub_lifecycle',
        tier: 'Starter',
        status: 'trialing',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 14 * 86400_000).toISOString(),
        cancelAtPeriodEnd: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const trialingRes = await originalFetch(`${baseUrl}/api/audit/${seeded.auditRun.id}`, {
        headers: buildCookieHeader(merchant.cookieToken),
      });
      assert.equal(trialingRes.status, 200);
      const trialingData = await trialingRes.json();
      assert.equal(trialingData.reportEntitlement.hasFullReportAccess, true);
      assert.ok(trialingData.findings.length > 0);

      // Revert to canceled then verify via POST /api/billing/checkout-session/verify
      await repo.saveSubscription({
        id: `sub_${merchant.workspace.id}`,
        workspaceId: merchant.workspace.id,
        provider: 'sandbox',
        customerId: 'cus_lifecycle',
        subscriptionId: 'sub_lifecycle',
        tier: 'Starter',
        status: 'canceled',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 14 * 86400_000).toISOString(),
        cancelAtPeriodEnd: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const checkoutRes = await originalFetch(`${baseUrl}/api/billing/checkout-session`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'Growth' }),
      });
      assert.equal(checkoutRes.status, 200);
      const checkoutBody = await checkoutRes.json();
      assert.ok(checkoutBody.sessionId);

      // Spoofed/unknown checkout sessionId rejected with 404
      const spoofRes = await originalFetch(`${baseUrl}/api/billing/checkout-session/verify`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'cs_forged_nonexistent' }),
      });
      assert.equal(spoofRes.status, 404);
      assert.equal((await spoofRes.json()).code, 'CHECKOUT_SESSION_NOT_FOUND');

      // Cross-workspace checkout session verification rejected with 403
      const crossVerifyRes = await originalFetch(`${baseUrl}/api/billing/checkout-session/verify`, {
        method: 'POST',
        headers: { ...buildCookieHeader(otherMerchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: checkoutBody.sessionId }),
      });
      assert.equal(crossVerifyRes.status, 403);
      assert.equal((await crossVerifyRes.json()).code, 'CHECKOUT_WORKSPACE_MISMATCH');

      // Legitimate workspace verification unlocks Growth & full reports
      const verifyRes = await originalFetch(`${baseUrl}/api/billing/checkout-session/verify`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: checkoutBody.sessionId }),
      });
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.verified, true);
      assert.equal(verifyData.subscription.tier, 'Growth');
      assert.equal(verifyData.subscription.status, 'active');
      assert.equal(verifyData.reportEntitlement.hasFullReportAccess, true);

      const unlockedExport = await originalFetch(`${baseUrl}/api/feed/export?platform=google_merchant_center`, {
        headers: buildCookieHeader(merchant.cookieToken),
      });
      assert.equal(unlockedExport.status, 200);
    });
  });

  describe('2. Workstream B: Cookie Auth, CSRF Protection, Session Rotation & Account Recovery', () => {
    test('Auth endpoints enforce HttpOnly cookies, omit JSON token, reject missing CSRF header and cross-origin Origin/Referer', async () => {
      const m = await registerMerchant('csrf-merchant@example.com', 'CSRF Shop');

      // Login with prior cookie sets new rotated HttpOnly cookie and omits JSON token
      const loginRes = await originalFetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: `aixshop_session=${m.cookieToken}`,
        },
        body: JSON.stringify({ email: 'csrf-merchant@example.com', password: 'Password123!' }),
      });
      assert.equal(loginRes.status, 200);
      const loginData = await loginRes.json();
      assert.equal(loginData.token, undefined, 'Login JSON must not expose raw session token');
      const rotatedCookie = extractSessionCookie(loginRes);
      assert.ok(rotatedCookie);
      assert.notEqual(rotatedCookie, m.cookieToken, 'Login must rotate session token');

      // Old registration session token MUST now be invalid (session rotation)
      const oldSessRes = await originalFetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `aixshop_session=${m.cookieToken}` },
      });
      assert.equal(oldSessRes.status, 401);

      // Cookie POST without X-Requested-With / X-CSRF-Token => 403 CSRF_REJECTED
      const noCsrfRes = await originalFetch(`${baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: { Cookie: `aixshop_session=${rotatedCookie}` },
      });
      assert.equal(noCsrfRes.status, 403);
      assert.equal((await noCsrfRes.json()).code, 'CSRF_REJECTED');

      // Cookie POST with cross-origin Origin => 403 CSRF_ORIGIN_MISMATCH
      const badOriginRes = await originalFetch(`${baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: {
          Cookie: `aixshop_session=${rotatedCookie}`,
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://evil.example.com',
        },
      });
      assert.equal(badOriginRes.status, 403);
      assert.equal((await badOriginRes.json()).code, 'CSRF_ORIGIN_MISMATCH');

      // Cookie POST with cross-origin Referer when Origin is absent => 403 CSRF_ORIGIN_MISMATCH
      const badRefererRes = await originalFetch(`${baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: {
          Cookie: `aixshop_session=${rotatedCookie}`,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://phishing.attacker.test/steal',
        },
      });
      assert.equal(badRefererRes.status, 403);
      assert.equal((await badRefererRes.json()).code, 'CSRF_ORIGIN_MISMATCH');

      // Same-origin Referer with X-Requested-With when Origin is absent succeeds
      const goodRefererRes = await originalFetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Cookie: `aixshop_session=${rotatedCookie}`,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${baseUrl}/?page=settings`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Referer Store' }),
      });
      assert.equal(goodRefererRes.status, 200);
    });

    test('Session rotation invalidates prior token on /register and /switch-workspace', async () => {
      const m1 = await registerMerchant('rotate-ctx@example.com', 'Workspace One');

      // Registering a new user while sending an existing session cookie revokes old cookie
      const m2 = await (() =>
        originalFetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: baseUrl,
            Cookie: `aixshop_session=${m1.cookieToken}`,
          },
          body: JSON.stringify({
            email: 'rotate-second@example.com',
            password: 'Password123!',
            fullName: 'Second User',
            workspaceName: 'Workspace Two',
          }),
        }))();
      assert.equal(m2.status, 201);

      const oldM1Check = await originalFetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `aixshop_session=${m1.cookieToken}` },
      });
      assert.equal(oldM1Check.status, 401);

      // Re-login user 1 and create a second workspace via repo, then switch workspace
      const login1 = await originalFetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'rotate-ctx@example.com', password: 'Password123!' }),
      });
      assert.equal(login1.status, 200);
      const tokenBeforeSwitch = extractSessionCookie(login1);
      const extraWs = await repo.createWorkspace(
        { id: `ws_extra_${Date.now()}`, name: 'Extra Workspace', slug: `extra-ws-${Date.now()}` },
        m1.user.id
      );

      const switchRes = await originalFetch(`${baseUrl}/api/auth/switch-workspace`, {
        method: 'POST',
        headers: {
          ...buildCookieHeader(tokenBeforeSwitch),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId: extraWs.workspace.id }),
      });
      assert.equal(switchRes.status, 200);
      const tokenAfterSwitch = extractSessionCookie(switchRes);
      assert.ok(tokenAfterSwitch);
      assert.notEqual(tokenAfterSwitch, tokenBeforeSwitch);

      // Prior token before switch-workspace is now revoked
      const revokedRes = await originalFetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `aixshop_session=${tokenBeforeSwitch}` },
      });
      assert.equal(revokedRes.status, 401);

      // New rotated token works and points to Extra Workspace
      const activeRes = await originalFetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `aixshop_session=${tokenAfterSwitch}` },
      });
      assert.equal(activeRes.status, 200);
      assert.equal((await activeRes.json()).workspace.id, extraWs.workspace.id);
    });

    test('Forgot/Reset Password enforces non-enumeration, fragment reset_token, Referrer-Policy, single-use/expiry validation, and full session revocation', async () => {
      const m = await registerMerchant('recover-user@example.com', 'Recovery Shop', 'InitialPass123!');

      // Check HTML meta no-referrer and HTTP Referrer-Policy header
      const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
      assert.match(indexHtml, /<meta\s+name="referrer"\s+content="no-referrer"/i);

      // 1. Unknown email yields identical uniform 200 without sending email + no-referrer header
      const unknownRes = await originalFetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'does-not-exist@example.com' }),
      });
      assert.equal(unknownRes.status, 200);
      assert.equal(unknownRes.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(unknownRes.headers.get('cache-control'), 'no-store');
      const unknownData = await unknownRes.json();
      assert.equal(getDevEmailOutbox().length, 0);

      // 2. Existing email yields uniform 200 and dispatches single-use reset link using URL fragment (#reset_token=...)
      const knownRes = await originalFetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'recover-user@example.com' }),
      });
      assert.equal(knownRes.status, 200);
      const knownData = await knownRes.json();
      assert.deepEqual(knownData, unknownData, 'Forgot-password responses must prevent account enumeration');

      const outbox = getDevEmailOutbox();
      assert.equal(outbox.length, 1);
      assert.doesNotMatch(outbox[0].text, /\?reset_token=/, 'Reset link must NEVER place reset_token in query string');
      const match = outbox[0].text.match(/#reset_token=([A-Za-z0-9._~+/=-]+)/);
      assert.ok(match?.[1], 'Reset email must place reset_token in URL fragment (#reset_token=...)');
      const rawResetToken = decodeURIComponent(match[1]);

      // 3. Rejects invalid reset token
      const invalidRes = await originalFetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: 'bogus-invalid-token', newPassword: 'NewStrongPass999!' }),
      });
      assert.equal(invalidRes.status, 400);
      assert.equal((await invalidRes.json()).code, 'INVALID_RESET_TOKEN');

      // 4. Consumes valid single-use reset token, updates password, revokes all prior sessions
      const resetRes = await originalFetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: rawResetToken, newPassword: 'NewStrongPass999!' }),
      });
      assert.equal(resetRes.status, 200);
      assert.equal((await resetRes.json()).success, true);

      // Reusing same token fails
      const reuseRes = await originalFetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: rawResetToken, newPassword: 'AnotherPass999!' }),
      });
      assert.equal(reuseRes.status, 400);
      assert.equal((await reuseRes.json()).code, 'INVALID_RESET_TOKEN');

      // Prior active session cookie was revoked on password reset
      const priorSessionRes = await originalFetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `aixshop_session=${m.cookieToken}` },
      });
      assert.equal(priorSessionRes.status, 401);

      // Old password rejected, new password accepted
      const oldPwLogin = await originalFetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'recover-user@example.com', password: 'InitialPass123!' }),
      });
      assert.equal(oldPwLogin.status, 401);

      const newPwLogin = await originalFetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'recover-user@example.com', password: 'NewStrongPass999!' }),
      });
      assert.equal(newPwLogin.status, 200);

      // Expired reset token is rejected
      const expiredToken = 'raw_expired_token_value_12345';
      await repo.createPasswordResetToken({
        id: 'pwr_expired_1',
        userId: m.user.id,
        tokenHash: hashSessionToken(expiredToken),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const expiredRes = await originalFetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: expiredToken, newPassword: 'AfterExpiredPass999!' }),
      });
      assert.equal(expiredRes.status, 400);
      assert.equal((await expiredRes.json()).code, 'INVALID_RESET_TOKEN');
    });

    test('SMTP delivery handles multi-line EHLO, AUTH PLAIN & LOGIN, rejects missing STARTTLS when required, handles socket close, and never logs secrets or reset tokens', async () => {
      async function startMockSmtpServer(opts: {
        authModes?: string[];
        failAuth?: boolean;
        dropOnMail?: boolean;
      }) {
        const receivedMessages: string[] = [];
        const commands: string[] = [];
        const srv = net.createServer((socket) => {
          let buffer = '';
          let inData = false;
          let authLoginStep: 0 | 1 | 2 = 0;
          let dataBuf = '';

          socket.write('220 mock-smtp.local ESMTP ready\r\n');
          socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            while (true) {
              const idx = buffer.indexOf('\r\n');
              if (idx === -1) break;
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);

              if (inData) {
                if (line === '.') {
                  inData = false;
                  receivedMessages.push(dataBuf);
                  dataBuf = '';
                  socket.write('250 2.0.0 OK queued\r\n');
                } else {
                  dataBuf += `${line}\r\n`;
                }
                continue;
              }

              commands.push(line);
              if (authLoginStep === 1) {
                authLoginStep = 2;
                socket.write('334 UGFzc3dvcmQ6\r\n');
                continue;
              }
              if (authLoginStep === 2) {
                authLoginStep = 0;
                socket.write(opts.failAuth ? '535 5.7.8 Auth failed\r\n' : '235 2.7.0 Authentication successful\r\n');
                continue;
              }

              const upper = line.toUpperCase();
              if (upper.startsWith('EHLO')) {
                const modes = (opts.authModes || ['PLAIN', 'LOGIN']).join(' ');
                socket.write('250-mock-smtp.local\r\n');
                socket.write('250-SIZE 35882577\r\n');
                socket.write(`250 AUTH ${modes}\r\n`);
              } else if (upper.startsWith('AUTH PLAIN')) {
                socket.write(opts.failAuth ? '535 5.7.8 Auth failed\r\n' : '235 2.7.0 Authentication successful\r\n');
              } else if (upper === 'AUTH LOGIN') {
                authLoginStep = 1;
                socket.write('334 VXNlcm5hbWU6\r\n');
              } else if (upper.startsWith('MAIL FROM:')) {
                if (opts.dropOnMail) {
                  socket.destroy();
                  return;
                }
                socket.write('250 2.1.0 OK\r\n');
              } else if (upper.startsWith('RCPT TO:')) {
                socket.write('250 2.1.5 OK\r\n');
              } else if (upper === 'DATA') {
                inData = true;
                socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
              } else if (upper === 'QUIT') {
                socket.write('221 Bye\r\n');
                socket.end();
              } else {
                socket.write('500 Unknown command\r\n');
              }
            }
          });
        });

        await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
        const port = (srv.address() as any).port;
        return {
          port,
          commands,
          receivedMessages,
          close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
        };
      }

      const prevEnv = {
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        SMTP_FROM: process.env.SMTP_FROM,
        SMTP_STARTTLS: process.env.SMTP_STARTTLS,
        SMTP_SECURE: process.env.SMTP_SECURE,
      };
      const origLog = console.log;
      const origErr = console.error;
      const capturedLogs: string[] = [];
      console.log = (...args: any[]) => capturedLogs.push(args.map(String).join(' '));
      console.error = (...args: any[]) => capturedLogs.push(args.map(String).join(' '));

      try {
        // 1. Successful AUTH PLAIN delivery + zero secret/token logging
        const srvPlain = await startMockSmtpServer({ authModes: ['PLAIN'] });
        try {
          process.env.SMTP_HOST = '127.0.0.1';
          process.env.SMTP_PORT = String(srvPlain.port);
          process.env.SMTP_USER = 'mailer@aixshop.test';
          process.env.SMTP_PASS = 'super_secret_smtp_pass_999';
          process.env.SMTP_FROM = 'no-reply@aixshop.test';
          process.env.SMTP_STARTTLS = 'false';
          process.env.SMTP_SECURE = 'false';

          const secretToken = 'tok_fragment_secret_abc123';
          const res = await sendPasswordResetEmail({
            to: 'merchant@example.com',
            fullName: 'Merchant',
            resetUrl: `https://app.aixshop.test/#reset_token=${secretToken}`,
            ttlMinutes: 30,
          });
          assert.equal(res.delivered, true);
          assert.equal(res.mode, 'smtp');
          assert.equal(srvPlain.receivedMessages.length, 1);
          assert.match(srvPlain.receivedMessages[0], /#reset_token=tok_fragment_secret_abc123/);
          assert.ok(srvPlain.commands.some((c) => c.startsWith('AUTH PLAIN ')));

          const combinedLogs = capturedLogs.join('\n');
          assert.doesNotMatch(combinedLogs, /super_secret_smtp_pass_999/);
          assert.doesNotMatch(combinedLogs, /tok_fragment_secret_abc123/);
          assert.doesNotMatch(combinedLogs, /AUTH PLAIN/);
        } finally {
          await srvPlain.close();
        }

        // 2. Successful AUTH LOGIN fallback when server only advertises LOGIN
        const srvLogin = await startMockSmtpServer({ authModes: ['LOGIN'] });
        try {
          process.env.SMTP_PORT = String(srvLogin.port);
          const res = await sendPasswordResetEmail({
            to: 'merchant2@example.com',
            fullName: 'Merchant Two',
            resetUrl: 'https://app.aixshop.test/#reset_token=login_tok_456',
            ttlMinutes: 30,
          });
          assert.equal(res.delivered, true);
          assert.ok(srvLogin.commands.includes('AUTH LOGIN'));
        } finally {
          await srvLogin.close();
        }

        // 3. Rejects cleanly when SMTP_STARTTLS=require and server lacks STARTTLS
        const srvNoTls = await startMockSmtpServer({ authModes: ['PLAIN'] });
        try {
          process.env.SMTP_PORT = String(srvNoTls.port);
          process.env.SMTP_STARTTLS = 'require';
          const resNoTls = await sendPasswordResetEmail({
            to: 'merchant3@example.com',
            fullName: 'Merchant Three',
            resetUrl: 'https://app.aixshop.test/#reset_token=notls_tok',
            ttlMinutes: 30,
          });
          assert.equal(resNoTls.delivered, false);
          assert.equal(resNoTls.mode, 'smtp');
          assert.match(resNoTls.error || '', /STARTTLS/);
        } finally {
          process.env.SMTP_STARTTLS = 'false';
          await srvNoTls.close();
        }

        // 4. Fails cleanly when socket closes abruptly mid-transaction (no unhandled hang)
        const srvDrop = await startMockSmtpServer({ authModes: ['PLAIN'], dropOnMail: true });
        try {
          process.env.SMTP_PORT = String(srvDrop.port);
          const resDrop = await sendPasswordResetEmail({
            to: 'merchant4@example.com',
            fullName: 'Merchant Four',
            resetUrl: 'https://app.aixshop.test/#reset_token=drop_tok',
            ttlMinutes: 30,
          });
          assert.equal(resDrop.delivered, false);
          assert.equal(resDrop.mode, 'smtp');
          assert.match(resDrop.error || '', /closed/i);
        } finally {
          await srvDrop.close();
        }
      } finally {
        console.log = origLog;
        console.error = origErr;
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  describe('3. Workstream C: Operational Hardening (Shared Rate Limits, Operation Leases, Payload/Batch Caps, Clamping)', () => {
    test('Shared DB-backed workspace rate limiter enforces 429 RATE_LIMITED + Retry-After across two Express app instances', async () => {
      const merchant = await registerMerchant('ratelimit-shared@example.com', 'Shared RL Shop');

      // Spin up a second independent Express app instance sharing the same `repo`
      const app2 = createApp(repo);
      const server2 = http.createServer(app2);
      await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
      const addr2 = server2.address() as any;
      const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

      try {
        // POST /api/catalog/import has limit 15/min shared per workspace across instances
        for (let i = 0; i < 8; i++) {
          const r1 = await originalFetch(`${baseUrl}/api/catalog/import`, {
            method: 'POST',
            headers: {
              ...buildCookieHeader(merchant.cookieToken),
              Origin: baseUrl,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ candidates: [] }),
          });
          assert.equal(r1.status, 200, `Instance 1 request ${i + 1} should succeed`);
        }

        for (let i = 0; i < 7; i++) {
          const r2 = await originalFetch(`${baseUrl2}/api/catalog/import`, {
            method: 'POST',
            headers: {
              ...buildCookieHeader(merchant.cookieToken),
              Origin: baseUrl2,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ candidates: [] }),
          });
          assert.equal(r2.status, 200, `Instance 2 request ${i + 9} should succeed`);
        }

        // 16th request on either instance must hit shared limit with 429 + Retry-After
        const blockedRes = await originalFetch(`${baseUrl2}/api/catalog/import`, {
          method: 'POST',
          headers: {
            ...buildCookieHeader(merchant.cookieToken),
            Origin: baseUrl2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ candidates: [] }),
        });
        assert.equal(blockedRes.status, 429);
        assert.ok(blockedRes.headers.get('retry-after'), '429 response must include Retry-After header');
        const blockedBody = await blockedRes.json();
        assert.equal(blockedBody.code, 'RATE_LIMITED');
        assert.ok(blockedBody.retryAfterSeconds >= 1);
      } finally {
        await new Promise<void>((resolve) => server2.close(() => resolve()));
      }
    });

    test('Concurrent workspace operation leases return 409 OPERATION_IN_PROGRESS for /shopify/sync and /catalog/migrate-demo', async () => {
      const merchant = await registerMerchant('lease-op@example.com', 'Lease Shop');

      // Pre-acquire shopify_sync lease simulating an active worker
      const syncLease = await repo.acquireWorkspaceOperationLease(
        merchant.workspace.id,
        'shopify_sync',
        'worker_A',
        60_000
      );
      assert.equal(syncLease.acquired, true);

      const syncRes = await originalFetch(`${baseUrl}/api/shopify/sync`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(syncRes.status, 409);
      const syncErr = await syncRes.json();
      assert.equal(syncErr.code, 'OPERATION_IN_PROGRESS');
      assert.equal(syncErr.operationKey, 'shopify_sync');

      await repo.releaseWorkspaceOperationLease(merchant.workspace.id, 'shopify_sync', 'worker_A');

      // Pre-acquire catalog_migrate_demo lease
      const demoLease = await repo.acquireWorkspaceOperationLease(
        merchant.workspace.id,
        'catalog_migrate_demo',
        'worker_B',
        60_000
      );
      assert.equal(demoLease.acquired, true);

      const demoRes = await originalFetch(`${baseUrl}/api/catalog/migrate-demo`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(demoRes.status, 409);
      const demoErr = await demoRes.json();
      assert.equal(demoErr.code, 'OPERATION_IN_PROGRESS');
      assert.equal(demoErr.operationKey, 'catalog_migrate_demo');

      await repo.releaseWorkspaceOperationLease(merchant.workspace.id, 'catalog_migrate_demo', 'worker_B');
    });

    test('Scoped body limits (256kb default -> 413 vs 5mb /api/catalog), batch limit (>1000 -> 413), Shopify param clamping, and artifact blocking', async () => {
      const merchant = await registerMerchant('limits-cap@example.com', 'Limits Shop');

      // 1. Default route >256kb => 413 PAYLOAD_TOO_LARGE
      const hugeBio = 'x'.repeat(300 * 1024);
      const tooLargeStoreRes = await originalFetch(`${baseUrl}/api/store/profile`, {
        method: 'PATCH',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: hugeBio }),
      });
      assert.equal(tooLargeStoreRes.status, 413);
      assert.equal((await tooLargeStoreRes.json()).code, 'PAYLOAD_TOO_LARGE');

      // 2. /api/catalog accepts ~350kb payload under 5mb limit
      const largeCatalogRes = await originalFetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: {
            products: [
              {
                id: 'prod_big_desc',
                title: 'Large Description Item',
                brand: 'Brand',
                category: 'Electronics',
                description: 'y'.repeat(350 * 1024),
                status: 'active',
                completenessScore: 80,
                evidenceCoverageScore: 50,
                externalDiscoveryStatus: 'observed_in_sample',
                attributes: {},
                variants: [{ id: 'v_1', sku: 'BIG-1', barcode: '', price: 19.99, inventoryCount: 5, attributes: {} }],
                offers: [],
                evidenceDocuments: [],
                findingsCount: 0,
              },
            ],
            variants: [],
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
          },
        }),
      });
      assert.equal(largeCatalogRes.status, 200);

      // 3. Batch import limit > 1000 => 413 BATCH_LIMIT_EXCEEDED
      const overBatch = Array.from({ length: 1001 }, (_, idx) => ({
        title: `Item ${idx}`,
        sku: `SKU-${idx}`,
        price: 10,
      }));
      const batchRes = await originalFetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidates: overBatch }),
      });
      assert.equal(batchRes.status, 413);
      assert.equal((await batchRes.json()).code, 'BATCH_LIMIT_EXCEEDED');

      // 4. Shopify sync pageSize clamped to <= 100
      await repo.saveShopifyConnection({
        id: 'shpc_clamp_test',
        workspaceId: merchant.workspace.id,
        shopDomain: 'clamp-shop.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_clamp_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        webhookSubscriptions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      let observedFirstArg: number | undefined;
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('clamp-shop.myshopify.com/admin/api/')) {
          const parsedBody = JSON.parse(String(init?.body || '{}'));
          observedFirstArg = parsedBody?.variables?.first;
          return new Response(
            JSON.stringify({
              data: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return originalFetch(url, init);
      }) as typeof fetch;

      const clampSyncRes = await originalFetch(`${baseUrl}/api/shopify/sync`, {
        method: 'POST',
        headers: { ...buildCookieHeader(merchant.cookieToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPages: 999, pageSize: 5000 }),
      });
      assert.equal(clampSyncRes.status, 200);
      assert.equal(observedFirstArg, 100, 'Shopify pageSize must be clamped to maximum 100');

      // 5. Internal AI Studio artifact routes return 404 RESOURCE_NOT_FOUND
      const artifactRes = await originalFetch(`${baseUrl}/assets/aistudio/secret_prompt.txt`);
      assert.equal(artifactRes.status, 404);
      assert.equal((await artifactRes.json()).code, 'RESOURCE_NOT_FOUND');
    });
  });
});
