import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { apiClient } from './client';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/db/memoryRepository';
import {
  normalizeShopDomain,
  isValidShopDomain,
  validateAndNormalizeShopDomain,
  isValidExternalHttpUrl,
  isValidShopifyAuthUrl,
} from '../domain/validation/shopify';

const originalFetch = globalThis.fetch;

describe('Task C1 & Validation: Billing & Shopify Frontend API Client', () => {
  beforeEach(() => {
    apiClient.setToken(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    apiClient.setToken(null);
  });

  describe('Shop domain & redirect URL validators', () => {
    test('normalizes bare store handle, URL, and canonical domain', () => {
      assert.equal(normalizeShopDomain('solstice-goods'), 'solstice-goods.myshopify.com');
      assert.equal(normalizeShopDomain('https://Solstice-Goods.myshopify.com/admin'), 'solstice-goods.myshopify.com');
      assert.equal(normalizeShopDomain('solstice-goods.myshopify.com'), 'solstice-goods.myshopify.com');
      assert.equal(isValidShopDomain('solstice-goods.myshopify.com'), true);
      assert.equal(isValidShopDomain('-bad.myshopify.com'), false);
      assert.equal(isValidShopDomain('evil.com'), false);

      const ok = validateAndNormalizeShopDomain('my-brand');
      assert.equal(ok.valid, true);
      if (ok.valid) assert.equal(ok.shopDomain, 'my-brand.myshopify.com');

      const bad = validateAndNormalizeShopDomain('notshopify.example.com');
      assert.equal(bad.valid, false);
    });

    test('validates external HTTP(S) redirect URLs and strict Shopify OAuth URLs', () => {
      assert.equal(isValidExternalHttpUrl('https://checkout.stripe.com/c/pay/cs_test_123'), true);
      assert.equal(isValidExternalHttpUrl('https://billing.stripe.com/p/session/bps_123'), true);
      assert.equal(isValidExternalHttpUrl('javascript:alert(1)'), false);
      assert.equal(isValidExternalHttpUrl('data:text/html,<script>'), false);
      assert.equal(isValidExternalHttpUrl('/relative/path'), false);
      assert.equal(isValidExternalHttpUrl('https://user:pass@stripe.com/x'), false);
      assert.equal(isValidExternalHttpUrl(''), false);

      assert.equal(
        isValidShopifyAuthUrl('https://solstice.myshopify.com/admin/oauth/authorize?client_id=abc&scope=read_products&state=xyz'),
        true
      );
      assert.equal(
        isValidShopifyAuthUrl('http://solstice.myshopify.com/admin/oauth/authorize?client_id=abc'),
        false
      );
      assert.equal(
        isValidShopifyAuthUrl('https://evil.example.com/admin/oauth/authorize?client_id=abc'),
        false
      );
      assert.equal(
        isValidShopifyAuthUrl('https://solstice.myshopify.com/some/other/path'),
        false
      );
    });
  });

  describe('apiClient.getBillingPlans', () => {
    test('retrieves authoritative plans including Enterprise null skuLimit from serialized Infinity', async () => {
      let calledUrl = '';
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return new Response(
          JSON.stringify({
            plans: [
              {
                id: 'plan_starter',
                tier: 'Starter',
                name: 'Starter Plan',
                priceCents: 4900,
                currency: 'USD',
                billingInterval: 'month',
                skuLimit: 250,
                features: ['Up to 250 verified SKUs'],
              },
              {
                id: 'plan_enterprise',
                tier: 'Enterprise',
                name: 'Enterprise Plan',
                priceCents: 49900,
                currency: 'USD',
                billingInterval: 'month',
                skuLimit: null,
                features: ['Unlimited SKUs'],
              },
            ],
            currency: 'USD',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const res = await apiClient.getBillingPlans();
      assert.equal(calledUrl, '/api/billing/plans');
      assert.equal(res.currency, 'USD');
      assert.equal(res.plans.length, 2);
      assert.equal(res.plans[0].priceCents, 4900);
      assert.equal(res.plans[1].skuLimit, null);
    });

    test('rejects HTTP failure and malformed plans response', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'Service unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;
      await assert.rejects(() => apiClient.getBillingPlans(), /Service unavailable/);

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ plans: 'not-an-array' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;
      await assert.rejects(() => apiClient.getBillingPlans(), /Malformed billing plans/);
    });
  });

  describe('apiClient.getBillingSubscription', () => {
    test('forwards Bearer token and validates subscription response structure', async () => {
      let authHeader = '';
      let creds: RequestCredentials | undefined;
      apiClient.setToken('tok_sub_123');

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers || {}) as Record<string, string>;
        authHeader = headers['Authorization'];
        creds = init?.credentials;
        return new Response(
          JSON.stringify({
            workspaceId: 'ws_1',
            subscription: {
              provider: 'stripe',
              tier: 'Growth',
              status: 'active',
              currentPeriodStart: '2026-11-01T00:00:00.000Z',
              currentPeriodEnd: '2026-12-01T00:00:00.000Z',
              cancelAtPeriodEnd: false,
            },
            storeProfile: {
              name: 'Solstice',
              domain: 'solstice.myshopify.com',
              currency: 'USD',
              skuCount: 120,
              skuLimit: 2500,
              catalogCompletenessAvg: 88,
              truthBoundaryStrictness: 'standard',
              tier: 'Growth',
              connectors: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const res = await apiClient.getBillingSubscription();
      assert.equal(authHeader, 'Bearer tok_sub_123');
      assert.equal(creds, 'include');
      assert.equal(res.workspaceId, 'ws_1');
      assert.equal(res.subscription.tier, 'Growth');
      assert.equal(res.subscription.status, 'active');
    });

    test('handles malformed subscription responses and 401 errors', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 })) as typeof fetch;
      await assert.rejects(() => apiClient.getBillingSubscription(), /Authentication required/);

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ workspaceId: 'ws_1', subscription: null }), { status: 200 })) as typeof fetch;
      await assert.rejects(() => apiClient.getBillingSubscription(), /Malformed subscription/);
    });
  });

  describe('apiClient.createCheckoutSession & createPortalSession', () => {
    test('creates checkout session and validates returned checkoutUrl', async () => {
      let method = '';
      let sentBody: any = null;
      apiClient.setToken('tok_chk_123');

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        method = init?.method || 'GET';
        sentBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            success: true,
            sessionId: 'cs_test_999',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_999',
            provider: 'stripe',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const res = await apiClient.createCheckoutSession({
        tier: 'Growth',
        successUrl: 'http://localhost:3000/?page=settings&tab=subscription',
        cancelUrl: 'http://localhost:3000/?page=settings&tab=subscription',
      });
      assert.equal(method, 'POST');
      assert.equal(sentBody.tier, 'Growth');
      assert.equal(res.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_999');
    });

    test('rejects missing, empty, or unsafe checkoutUrl and HTTP errors', async () => {
      for (const badPayload of [
        { success: true, sessionId: 'cs_1', checkoutUrl: '' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'javascript:alert(1)' },
        { success: false, sessionId: 'cs_1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1' },
      ]) {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(badPayload), { status: 200 })) as typeof fetch;
        await assert.rejects(() => apiClient.createCheckoutSession({ tier: 'Starter' }), /checkout URL/i);
      }

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'Stripe credentials not configured' }), { status: 400 })) as typeof fetch;
      await assert.rejects(() => apiClient.createCheckoutSession({ tier: 'Starter' }), /Stripe credentials/);
    });

    test('creates portal session and rejects missing or unsafe portalUrl', async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: true,
            portalUrl: 'https://billing.stripe.com/p/session/bps_test_1',
            provider: 'stripe',
          }),
          { status: 200 }
        )) as typeof fetch;

      const portal = await apiClient.createPortalSession({ returnUrl: 'http://localhost:3000/settings' });
      assert.equal(portal.portalUrl, 'https://billing.stripe.com/p/session/bps_test_1');

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: true,
            portalUrl: 'javascript:void(0)',
            provider: 'stripe',
          }),
          { status: 200 }
        )) as typeof fetch;
      await assert.rejects(() => apiClient.createPortalSession(), /portal URL/i);
    });
  });

  describe('apiClient.connectShopify', () => {
    test('normalizes shop domain, sends authenticated GET request, and validates Shopify authUrl', async () => {
      let calledUrl = '';
      let authHeader = '';
      apiClient.setToken('tok_shop_123');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        authHeader = ((init?.headers || {}) as Record<string, string>)['Authorization'];
        return new Response(
          JSON.stringify({
            success: true,
            authUrl: 'https://demo-store.myshopify.com/admin/oauth/authorize?client_id=cid&scope=read_products&state=st_1',
            state: 'st_1',
            shopDomain: 'demo-store.myshopify.com',
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const res = await apiClient.connectShopify('demo-store');
      assert.equal(calledUrl, '/api/shopify/connect?shop=demo-store.myshopify.com');
      assert.equal(authHeader, 'Bearer tok_shop_123');
      assert.equal(res.shopDomain, 'demo-store.myshopify.com');
      assert.match(res.authUrl, /^https:\/\/demo-store\.myshopify\.com\/admin\/oauth\/authorize/);
    });

    test('rejects invalid shop domain before network call and rejects untrusted authUrl from server', async () => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            authUrl: 'https://phishing.example.com/admin/oauth/authorize',
            state: 'st_bad',
            shopDomain: 'demo-store.myshopify.com',
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      await assert.rejects(() => apiClient.connectShopify('not-a-shopify-domain.com'), /valid Shopify store domain/i);
      assert.equal(fetchCalls, 0);

      await assert.rejects(() => apiClient.connectShopify('demo-store.myshopify.com'), /valid Shopify authorization URL/i);
      assert.equal(fetchCalls, 1);
    });
  });

  describe('End-to-End Backend Route Compatibility via Express App', () => {
    test('apiClient communicates cleanly with real /api/billing/* and /api/shopify/connect endpoints', async () => {
      const repo = new MemoryRepository();
      const prevApiKey = process.env.SHOPIFY_API_KEY;
      const prevApiSecret = process.env.SHOPIFY_API_SECRET;
      const prevAppUrl = process.env.APP_URL;
      process.env.SHOPIFY_API_KEY = 'test_shopify_api_key';
      process.env.SHOPIFY_API_SECRET = 'test_shopify_api_secret';
      process.env.APP_URL = 'http://localhost:3000';

      const app = createApp(repo);
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
        return originalFetch(url, init);
      }) as typeof fetch;

      try {
        const plans = await apiClient.getBillingPlans();
        assert.equal(plans.plans.length, 4);
        assert.ok(plans.plans.some(p => p.tier === 'Growth' && p.priceCents === 14900));

        await apiClient.register({
          email: 'billing-client-e2e@example.com',
          password: 'Password123!',
          fullName: 'E2E Merchant',
          workspaceName: 'E2E Shop',
        });

        const sub = await apiClient.getBillingSubscription();
        assert.equal(sub.subscription.tier, 'Free Audit');
        assert.equal(sub.subscription.provider, 'none');

        const checkout = await apiClient.createCheckoutSession({ tier: 'Growth' });
        assert.equal(checkout.success, true);
        assert.ok(checkout.checkoutUrl.startsWith('http'));

        const shopifyConnect = await apiClient.connectShopify('e2e-brand.myshopify.com');
        assert.equal(shopifyConnect.success, true);
        assert.equal(shopifyConnect.shopDomain, 'e2e-brand.myshopify.com');
        assert.match(shopifyConnect.authUrl, /^https:\/\/e2e-brand\.myshopify\.com\/admin\/oauth\/authorize/);
        assert.match(shopifyConnect.authUrl, /scope=read_products/);
      } finally {
        if (prevApiKey === undefined) delete process.env.SHOPIFY_API_KEY;
        else process.env.SHOPIFY_API_KEY = prevApiKey;
        if (prevApiSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
        else process.env.SHOPIFY_API_SECRET = prevApiSecret;
        if (prevAppUrl === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = prevAppUrl;
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });
});
