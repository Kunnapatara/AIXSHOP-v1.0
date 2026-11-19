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
  isValidBillingRedirectUrl,
  parseTrustedStripeCustomDomains,
  isValidShopifyAuthUrl,
} from '../domain/validation/shopify';

const originalFetch = globalThis.fetch;

describe('Task C1 & Validation: Billing & Shopify Frontend API Client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    test('strictly validates Stripe Checkout & Portal URLs, rejects lookalikes, arbitrary HTTPS hosts, HTTP in production, and embedded credentials', () => {
      // Valid standard Stripe destinations
      assert.equal(
        isValidBillingRedirectUrl('https://checkout.stripe.com/c/pay/cs_live_123', { flow: 'checkout', provider: 'stripe' }),
        true
      );
      assert.equal(
        isValidBillingRedirectUrl('https://billing.stripe.com/p/session/bps_live_123', { flow: 'portal', provider: 'stripe' }),
        true
      );

      // Cross-flow mismatch must fail closed
      assert.equal(
        isValidBillingRedirectUrl('https://billing.stripe.com/p/session/bps_1', { flow: 'checkout', provider: 'stripe' }),
        false
      );
      assert.equal(
        isValidBillingRedirectUrl('https://checkout.stripe.com/c/pay/cs_1', { flow: 'portal', provider: 'stripe' }),
        false
      );

      // Explicitly configured flow-specific trusted Stripe custom domains
      const prevCheckoutDomains = process.env.VITE_STRIPE_CHECKOUT_DOMAINS;
      const prevPortalDomains = process.env.VITE_STRIPE_PORTAL_DOMAINS;
      try {
        process.env.VITE_STRIPE_CHECKOUT_DOMAINS = 'https://pay.solsticecraft.com';
        process.env.VITE_STRIPE_PORTAL_DOMAINS = 'billing.solsticecraft.com';

        // Matching flow succeeds
        assert.equal(
          isValidBillingRedirectUrl('https://pay.solsticecraft.com/c/pay/cs_custom_1', { flow: 'checkout', provider: 'stripe' }),
          true
        );
        assert.equal(
          isValidBillingRedirectUrl('https://billing.solsticecraft.com/p/session/bps_custom_1', { flow: 'portal', provider: 'stripe' }),
          true
        );

        // Cross-flow mismatch: Checkout-only domain rejected for Portal and Portal-only domain rejected for Checkout
        assert.equal(
          isValidBillingRedirectUrl('https://pay.solsticecraft.com/p/session/bps_cross', { flow: 'portal', provider: 'stripe' }),
          false
        );
        assert.equal(
          isValidBillingRedirectUrl('https://billing.solsticecraft.com/c/pay/cs_cross', { flow: 'checkout', provider: 'stripe' }),
          false
        );

        // Subdomain or suffix lookalike of configured custom domain must be rejected
        assert.equal(
          isValidBillingRedirectUrl('https://sub.pay.solsticecraft.com/c/pay/cs_bad', { flow: 'checkout', provider: 'stripe' }),
          false
        );
        assert.equal(
          isValidBillingRedirectUrl('https://pay.solsticecraft.com.evil.com/c/pay/cs_bad', { flow: 'checkout', provider: 'stripe' }),
          false
        );
      } finally {
        if (prevCheckoutDomains === undefined) delete process.env.VITE_STRIPE_CHECKOUT_DOMAINS;
        else process.env.VITE_STRIPE_CHECKOUT_DOMAINS = prevCheckoutDomains;
        if (prevPortalDomains === undefined) delete process.env.VITE_STRIPE_PORTAL_DOMAINS;
        else process.env.VITE_STRIPE_PORTAL_DOMAINS = prevPortalDomains;
      }

      // Custom domain parser rejects wildcards, HTTP, IPs, localhost, paths, credentials
      const parsedDomains = parseTrustedStripeCustomDomains(
        '*.stripe.com, http://insecure.brand.com, https://127.0.0.1, https://localhost, https://user:pass@pay.brand.com, https://pay.brand.com/path, https://checkout.verifiedbrand.com'
      );
      assert.deepEqual([...parsedDomains], ['checkout.verifiedbrand.com']);

      // Arbitrary external HTTPS hostnames rejected
      assert.equal(
        isValidBillingRedirectUrl('https://evil.example.com/c/pay/cs_123', { flow: 'checkout', provider: 'stripe' }),
        false
      );
      assert.equal(
        isValidBillingRedirectUrl('https://attacker.dev/portal', { flow: 'portal', provider: 'stripe' }),
        false
      );

      // Lookalike Stripe domains (broad suffix check trap) rejected
      for (const lookalike of [
        'https://checkout.stripe.com.evil.com/pay',
        'https://evil-checkout.stripe.com/pay',
        'https://fake.stripe.com/pay',
        'https://billing.stripe.com.attacker.org/session',
        'https://stripe.com/pay',
        'https://checkout.stripe.com./pay',
        'https://checkout.stripe.com:8443/pay',
      ]) {
        assert.equal(
          isValidBillingRedirectUrl(lookalike, { flow: 'checkout', provider: 'stripe' }),
          false,
          `Must reject lookalike/port/dot URL: ${lookalike}`
        );
        assert.equal(
          isValidBillingRedirectUrl(lookalike, { flow: 'portal', provider: 'stripe' }),
          false,
          `Must reject lookalike/port/dot URL for portal: ${lookalike}`
        );
      }

      // Malformed, non-HTTP(S), whitespace, and embedded credential URLs rejected
      for (const bad of [
        '',
        '   ',
        'not-a-url',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'https://user:pass@checkout.stripe.com/c/pay/cs_1',
        'https://checkout.stripe.com@evil.com/c/pay/cs_1',
        'http://checkout.stripe.com/c/pay/cs_1',
        'http://billing.stripe.com/p/session/bps_1',
      ]) {
        assert.equal(isValidBillingRedirectUrl(bad, { flow: 'checkout', provider: 'stripe' }), false, `Must reject: ${bad}`);
      }

      // Production mode rejects HTTP everywhere (including sandbox localhost)
      const prevNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        assert.equal(
          isValidBillingRedirectUrl('http://localhost:3000/?session_id=1', { flow: 'checkout', provider: 'sandbox' }),
          false
        );
        assert.equal(
          isValidBillingRedirectUrl('http://checkout.stripe.com/c/pay/cs_1', { flow: 'checkout', provider: 'stripe' }),
          false
        );
        assert.equal(
          isValidBillingRedirectUrl('https://checkout.stripe.com/c/pay/cs_prod_1', { flow: 'checkout', provider: 'stripe' }),
          true
        );
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
      }
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
    test('uses cookie-only credentials without Bearer Authorization header and validates subscription response structure', async () => {
      let authHeader: string | undefined;
      let creds: RequestCredentials | undefined;

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
      assert.equal(authHeader, undefined, 'Browser client must not send Bearer Authorization header');
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

    test('rejects missing, empty, lookalike, arbitrary external HTTPS, HTTP-in-production, and credentialed checkoutUrl / portalUrl', async () => {
      for (const badPayload of [
        { success: true, sessionId: 'cs_1', checkoutUrl: '', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'javascript:alert(1)', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'data:text/html,<script>', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'not-a-valid-url', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'https://evil.example.com/checkout', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'https://checkout.stripe.com.evil.com/pay', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'https://evil-checkout.stripe.com/pay', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'https://user:pass@checkout.stripe.com/c/pay/cs_1', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'http://checkout.stripe.com/c/pay/cs_1', provider: 'stripe' },
        { success: true, sessionId: 'cs_1', checkoutUrl: 'https://billing.stripe.com/p/session/bps_1', provider: 'stripe' },
        { success: false, sessionId: 'cs_1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', provider: 'stripe' },
      ]) {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(badPayload), { status: 200 })) as typeof fetch;
        await assert.rejects(() => apiClient.createCheckoutSession({ tier: 'Starter' }), /checkout URL/i);
      }

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'Stripe credentials not configured' }), { status: 400 })) as typeof fetch;
      await assert.rejects(() => apiClient.createCheckoutSession({ tier: 'Starter' }), /Stripe credentials/);
    });

    test('accepts configured flow-specific Stripe custom domains for checkout & portal and rejects cross-flow usage', async () => {
      const prevCheckoutDomains = process.env.VITE_STRIPE_CHECKOUT_DOMAINS;
      const prevPortalDomains = process.env.VITE_STRIPE_PORTAL_DOMAINS;
      process.env.VITE_STRIPE_CHECKOUT_DOMAINS = 'https://pay.solsticecraft.com';
      process.env.VITE_STRIPE_PORTAL_DOMAINS = 'https://portal.solsticecraft.com';
      try {
        // 1. Valid checkout custom domain accepted
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              sessionId: 'cs_custom_1',
              checkoutUrl: 'https://pay.solsticecraft.com/c/pay/cs_custom_1',
              provider: 'stripe',
            }),
            { status: 200 }
          )) as typeof fetch;

        const checkout = await apiClient.createCheckoutSession({ tier: 'Growth' });
        assert.equal(checkout.checkoutUrl, 'https://pay.solsticecraft.com/c/pay/cs_custom_1');

        // 2. Portal-only custom domain rejected on Checkout
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              sessionId: 'cs_cross',
              checkoutUrl: 'https://portal.solsticecraft.com/c/pay/cs_cross',
              provider: 'stripe',
            }),
            { status: 200 }
          )) as typeof fetch;
        await assert.rejects(() => apiClient.createCheckoutSession({ tier: 'Growth' }), /checkout URL/i);

        // 3. Valid portal custom domain accepted
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              portalUrl: 'https://portal.solsticecraft.com/p/session/bps_custom_1',
              provider: 'stripe',
            }),
            { status: 200 }
          )) as typeof fetch;

        const portal = await apiClient.createPortalSession();
        assert.equal(portal.portalUrl, 'https://portal.solsticecraft.com/p/session/bps_custom_1');

        // 4. Checkout-only custom domain rejected on Portal
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              portalUrl: 'https://pay.solsticecraft.com/p/session/bps_cross',
              provider: 'stripe',
            }),
            { status: 200 }
          )) as typeof fetch;
        await assert.rejects(() => apiClient.createPortalSession(), /portal URL/i);
      } finally {
        if (prevCheckoutDomains === undefined) delete process.env.VITE_STRIPE_CHECKOUT_DOMAINS;
        else process.env.VITE_STRIPE_CHECKOUT_DOMAINS = prevCheckoutDomains;
        if (prevPortalDomains === undefined) delete process.env.VITE_STRIPE_PORTAL_DOMAINS;
        else process.env.VITE_STRIPE_PORTAL_DOMAINS = prevPortalDomains;
      }
    });

    test('creates portal session and rejects missing, arbitrary HTTPS, lookalike, HTTP, or unsafe portalUrl', async () => {
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

      for (const badUrl of [
        '',
        'javascript:void(0)',
        'https://evil.example.com/billing',
        'https://billing.stripe.com.evil.com/p/session/bps_1',
        'https://checkout.stripe.com/c/pay/cs_1',
        'http://billing.stripe.com/p/session/bps_1',
        'https://user:secret@billing.stripe.com/p/session/bps_1',
      ]) {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              portalUrl: badUrl,
              provider: 'stripe',
            }),
            { status: 200 }
          )) as typeof fetch;
        await assert.rejects(() => apiClient.createPortalSession(), /portal URL/i);
      }
    });
  });

  describe('apiClient.connectShopify', () => {
    test('normalizes shop domain, sends authenticated cookie GET request, and validates Shopify authUrl', async () => {
      let calledUrl = '';
      let authHeader: string | undefined;
      let creds: RequestCredentials | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        authHeader = ((init?.headers || {}) as Record<string, string>)['Authorization'];
        creds = init?.credentials;
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
      assert.equal(authHeader, undefined);
      assert.equal(creds, 'include');
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

  describe('apiClient.verifyCheckoutSession & auth recovery methods', () => {
    test('sends checkout session verification and password recovery requests cleanly', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, body });
        if (url === '/api/billing/checkout-session/verify') {
          return new Response(
            JSON.stringify({
              success: true,
              verified: true,
              workspaceId: 'ws_1',
              subscription: { provider: 'sandbox', tier: 'Growth', status: 'active', cancelAtPeriodEnd: false },
              storeProfile: null,
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200 });
      }) as typeof fetch;

      const verifyRes = await apiClient.verifyCheckoutSession('cs_sandbox_123');
      assert.equal(verifyRes.verified, true);
      assert.equal(verifyRes.subscription.tier, 'Growth');

      await apiClient.forgotPassword('merchant@example.com');
      await apiClient.resetPassword('tok_reset_123', 'NewStrongPass123!');

      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0], { url: '/api/billing/checkout-session/verify', body: { sessionId: 'cs_sandbox_123' } });
      assert.deepEqual(calls[1], { url: '/api/auth/forgot-password', body: { email: 'merchant@example.com' } });
      assert.deepEqual(calls[2], { url: '/api/auth/reset-password', body: { token: 'tok_reset_123', newPassword: 'NewStrongPass123!' } });
    });
  });

  describe('End-to-End Backend Route Compatibility via Express App', () => {
    test('apiClient communicates cleanly with real /api/billing/* and /api/shopify/connect endpoints via HttpOnly cookies', async () => {
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

      // Lightweight Node fetch cookie jar simulating browser HttpOnly cookie persistence + Origin header
      const cookieJar = new Map<string, string>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
        const headers: Record<string, string> = {
          Origin: baseUrl,
          ...((init?.headers as Record<string, string>) || {}),
        };
        if (cookieJar.size > 0) {
          headers.Cookie = Array.from(cookieJar.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        }
        const res = await originalFetch(url, { ...init, headers });
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const raw of setCookies) {
          const pair = raw.split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) {
            const name = pair.slice(0, eq).trim();
            const val = pair.slice(eq + 1).trim();
            if (val) cookieJar.set(name, val);
            else cookieJar.delete(name);
          }
        }
        return res;
      }) as typeof fetch;

      try {
        const plans = await apiClient.getBillingPlans();
        assert.equal(plans.plans.length, 4);
        assert.ok(plans.plans.some(p => p.tier === 'Growth' && p.priceCents === 14900));

        const regRes = await apiClient.register({
          email: 'billing-client-e2e@example.com',
          password: 'Password123!',
          fullName: 'E2E Merchant',
          workspaceName: 'E2E Shop',
        });
        assert.equal((regRes as any).token, undefined, 'Register response JSON must not expose raw token');
        assert.ok(cookieJar.get('aixshop_session'), 'HttpOnly aixshop_session cookie must be set');

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
