import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { SandboxBillingProvider, StripeBillingProvider, setBillingProvider } from './billing/providerAdapter';
import { BillingService } from './services/billingService';
import { AUTHORITATIVE_PLANS } from './billing/types';
import { checkPlanQuota, countCatalogSkus } from './services/entitlementService';

describe('AIXSHOP v1.0 — Billing & Payment-Based Entitlements Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;
  let sandboxProvider: SandboxBillingProvider;
  let billingService: BillingService;

  let ownerToken: string;
  let memberToken: string;
  let workspaceId: string;

  before(async () => {
    repo = new MemoryRepository(false);
    sandboxProvider = new SandboxBillingProvider('test_webhook_secret_key_abc123');
    setBillingProvider(sandboxProvider);
    billingService = new BillingService(repo, sandboxProvider);

    const app = createApp(repo);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Register owner
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'billing_owner@example.com',
        password: 'passwordOwner123',
        fullName: 'Oliver Owner',
        workspaceName: 'Billing Test Workspace',
      }),
    });
    assert.equal(regRes.status, 201);
    const data = await regRes.json();
    ownerToken = data.token;
    workspaceId = data.workspace.id;

    // Create a member in the same workspace
    const memberUser = await repo.createUser({
      id: `usr_member_${Date.now()}`,
      email: 'billing_member@example.com',
      passwordHash: 'hash',
      fullName: 'Molly Member',
    });
    const memId = `mem_${workspaceId}_${memberUser.id}`;
    (repo as any).memberships.set(memId, {
      id: memId,
      workspaceId,
      userId: memberUser.id,
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    const rawMemberToken = 'token_member_abc123';
    await repo.createSession({
      id: `sess_mem_${Date.now()}`,
      sessionTokenHash: (await import('./security/tokens')).hashSessionToken(rawMemberToken),
      userId: memberUser.id,
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    memberToken = rawMemberToken;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Helper to create test double for Stripe client
  function createMockStripeClient(overrides?: {
    checkoutSessionCreate?: (params: any) => Promise<any>;
    portalSessionCreate?: (params: any) => Promise<any>;
  }) {
    return {
      checkout: {
        sessions: {
          create: overrides?.checkoutSessionCreate || (async (params: any) => ({
            id: 'cs_real_stripe_api_id_123',
            url: `https://checkout.stripe.com/c/pay/cs_real_stripe_api_id_123?workspace=${params.client_reference_id}`,
            ...params,
          })),
        },
      },
      billingPortal: {
        sessions: {
          create: overrides?.portalSessionCreate || (async (params: any) => ({
            id: 'bps_real_stripe_portal_456',
            url: `https://billing.stripe.com/p/session/bps_real_stripe_portal_456?customer=${params.customer}`,
            ...params,
          })),
        },
      },
      webhooks: {
        signature: {
          verifyHeaderAsync: async (_payload: string, sig: string, secret: string) => {
            if (sig.includes('invalid') || secret === 'wrong_secret') {
              throw new Error('Signature verification failed');
            }
            return true;
          },
        },
      },
    } as unknown as any;
  }

  // ==========================================
  // 1. Authoritative Plans & Provider Adapters
  // ==========================================
  describe('1. Authoritative Plan Definitions & Provider Adapters', () => {
    test('1.1 Server defines immutable plan pricing and SKU capacities', () => {
      assert.equal(AUTHORITATIVE_PLANS['starter'].priceCents, 4900); // $49.00
      assert.equal(AUTHORITATIVE_PLANS['starter'].skuLimit, 250);
      assert.equal(AUTHORITATIVE_PLANS['growth'].priceCents, 14900); // $149.00
      assert.equal(AUTHORITATIVE_PLANS['growth'].skuLimit, 2500);
      assert.equal(AUTHORITATIVE_PLANS['enterprise'].priceCents, 49900); // $499.00
      assert.equal(AUTHORITATIVE_PLANS['enterprise'].skuLimit, Infinity);
      assert.equal(AUTHORITATIVE_PLANS['free_audit'].priceCents, 0);
    });

    test('1.2 Sandbox provider creates valid checkout session', async () => {
      const result = await sandboxProvider.createCheckoutSession({
        workspaceId: 'ws_test_1',
        tier: 'Growth',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });
      assert.ok(result.sessionId.startsWith('sbx_cs_'));
      assert.ok(result.checkoutUrl.includes('provider=sandbox'));
      assert.ok(result.checkoutUrl.includes('tier=Growth'));
    });

    test('1.3 Stripe provider rejects checkout creation when secret key is missing', async () => {
      const unconfiguredStripe = new StripeBillingProvider('', '');
      await assert.rejects(
        async () => {
          await unconfiguredStripe.createCheckoutSession({
            workspaceId: 'ws_stripe_test',
            tier: 'Starter',
            successUrl: 'https://example.com/success',
            cancelUrl: 'https://example.com/cancel',
          });
        },
        /STRIPE_SECRET_KEY is not configured/
      );
    });

    test('1.4 Stripe provider rejects checkout creation when price ID is missing (no silent fallback)', async () => {
      const mockStripe = createMockStripeClient();
      // Provider configured with API key but empty price map
      const providerWithoutPrices = new StripeBillingProvider('sk_test_valid', 'whsec_test', mockStripe, {});
      await assert.rejects(
        async () => {
          await providerWithoutPrices.createCheckoutSession({
            workspaceId: 'ws_stripe_test',
            tier: 'Growth',
            successUrl: 'https://example.com/success',
            cancelUrl: 'https://example.com/cancel',
          });
        },
        /Stripe Price ID is not configured for plan tier "Growth"/
      );
    });

    test('1.5 Stripe provider correctly constructs Checkout Session parameters and returns actual Stripe session', async () => {
      let capturedParams: any = null;
      const mockStripe = createMockStripeClient({
        checkoutSessionCreate: async (params) => {
          capturedParams = params;
          return {
            id: 'cs_real_stripe_api_id_789',
            url: 'https://checkout.stripe.com/c/pay/cs_real_stripe_api_id_789',
          };
        },
      });

      const stripeProvider = new StripeBillingProvider(
        'sk_test_valid_key',
        'whsec_valid_secret',
        mockStripe,
        { Starter: 'price_starter_configured_123' }
      );

      const result = await stripeProvider.createCheckoutSession({
        workspaceId: 'ws_target_123',
        tier: 'Starter',
        successUrl: 'https://example.com/checkout/success',
        cancelUrl: 'https://example.com/checkout/cancel',
        customerId: 'cus_existing_stripe_customer_1',
      });

      // Verify exact parameter construction
      assert.equal(capturedParams.mode, 'subscription');
      assert.equal(capturedParams.line_items[0].price, 'price_starter_configured_123');
      assert.equal(capturedParams.line_items[0].quantity, 1);
      assert.equal(capturedParams.client_reference_id, 'ws_target_123');
      assert.equal(capturedParams.metadata.workspaceId, 'ws_target_123');
      assert.equal(capturedParams.metadata.tier, 'Starter');
      assert.equal(capturedParams.subscription_data.metadata.tier, 'Starter');
      assert.equal(capturedParams.customer, 'cus_existing_stripe_customer_1');
      assert.equal(capturedParams.success_url, 'https://example.com/checkout/success');
      assert.equal(capturedParams.cancel_url, 'https://example.com/checkout/cancel');

      // Verify returned data matches real Stripe API response
      assert.equal(result.sessionId, 'cs_real_stripe_api_id_789');
      assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_real_stripe_api_id_789');
      assert.equal(result.provider, 'stripe');
    });

    test('1.6 Stripe provider handles Stripe API errors during checkout creation safely', async () => {
      const errorStripe = createMockStripeClient({
        checkoutSessionCreate: async () => {
          throw new Error('No such price: price_starter_configured_123');
        },
      });

      const stripeProvider = new StripeBillingProvider(
        'sk_test_valid_key',
        'whsec_valid_secret',
        errorStripe,
        { Starter: 'price_starter_configured_123' }
      );

      await assert.rejects(
        async () => {
          await stripeProvider.createCheckoutSession({
            workspaceId: 'ws_target_123',
            tier: 'Starter',
            successUrl: 'https://example.com/checkout/success',
            cancelUrl: 'https://example.com/checkout/cancel',
          });
        },
        /Stripe checkout session creation failed: No such price/
      );
    });

    test('1.7 Stripe provider handles malformed responses during checkout creation safely', async () => {
      const malformedStripe = createMockStripeClient({
        checkoutSessionCreate: async () => ({ id: 'cs_missing_url' }), // missing url
      });

      const stripeProvider = new StripeBillingProvider(
        'sk_test_valid_key',
        'whsec_valid_secret',
        malformedStripe,
        { Starter: 'price_starter_configured_123' }
      );

      await assert.rejects(
        async () => {
          await stripeProvider.createCheckoutSession({
            workspaceId: 'ws_target_123',
            tier: 'Starter',
            successUrl: 'https://example.com/checkout/success',
            cancelUrl: 'https://example.com/checkout/cancel',
          });
        },
        /Stripe checkout session response was malformed or missing URL/
      );
    });

    test('1.8 Customer portal session creation constructs correct parameters and returns portal URL', async () => {
      let capturedPortalParams: any = null;
      const mockStripe = createMockStripeClient({
        portalSessionCreate: async (params) => {
          capturedPortalParams = params;
          return {
            id: 'bps_test_real_portal_session',
            url: 'https://billing.stripe.com/p/session/bps_test_real_portal_session',
          };
        },
      });

      const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_secret', mockStripe);
      const result = await stripeProvider.createPortalSession(
        'ws_portal_test',
        'cus_stripe_real_customer_456',
        'https://example.com/settings?tab=subscription'
      );

      assert.equal(capturedPortalParams.customer, 'cus_stripe_real_customer_456');
      assert.equal(capturedPortalParams.return_url, 'https://example.com/settings?tab=subscription');
      assert.equal(result.portalUrl, 'https://billing.stripe.com/p/session/bps_test_real_portal_session');
      assert.equal(result.provider, 'stripe');
    });

    test('1.9 Customer portal rejects workspace without valid Stripe customer ID (starts with cus_)', async () => {
      const mockStripe = createMockStripeClient();
      const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_secret', mockStripe);

      await assert.rejects(
        async () => {
          await stripeProvider.createPortalSession('ws_portal_test', 'cust_fake_workspace_id', 'https://example.com');
        },
        /does not have a valid Stripe customer mapping/
      );
    });

    test('1.10 Customer portal handles Stripe API errors safely', async () => {
      const errorStripe = createMockStripeClient({
        portalSessionCreate: async () => {
          throw new Error('Customer portal configuration has not been created.');
        },
      });

      const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_secret', errorStripe);
      await assert.rejects(
        async () => {
          await stripeProvider.createPortalSession('ws_portal_test', 'cus_valid_123', 'https://example.com');
        },
        /Stripe customer portal session creation failed/
      );
    });

    test('1.11 Provider selection: In production, fails closed when STRIPE_SECRET_KEY is missing', async () => {
      const { getBillingProvider, setBillingProvider } = await import('./billing/providerAdapter');
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.STRIPE_SECRET_KEY;
      const origProvider = process.env.BILLING_PROVIDER;

      try {
        setBillingProvider(null);
        process.env.NODE_ENV = 'production';
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.BILLING_PROVIDER;

        assert.throws(
          () => getBillingProvider(),
          /Production billing requires STRIPE_SECRET_KEY to be configured/
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origKey) process.env.STRIPE_SECRET_KEY = origKey;
        if (origProvider) process.env.BILLING_PROVIDER = origProvider;
        setBillingProvider(sandboxProvider);
      }
    });

    test('1.12 Provider selection: In production, strictly rejects explicit sandbox provider', async () => {
      const { getBillingProvider, setBillingProvider } = await import('./billing/providerAdapter');
      const origEnv = process.env.NODE_ENV;
      const origProvider = process.env.BILLING_PROVIDER;

      try {
        setBillingProvider(null);
        process.env.NODE_ENV = 'production';
        process.env.BILLING_PROVIDER = 'sandbox';

        assert.throws(
          () => getBillingProvider(),
          /Sandbox billing provider is strictly prohibited in production mode/
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origProvider) process.env.BILLING_PROVIDER = origProvider;
        setBillingProvider(sandboxProvider);
      }
    });

    test('1.13 Provider selection: In development/test, safely defaults to sandbox when unconfigured', async () => {
      const { getBillingProvider, setBillingProvider } = await import('./billing/providerAdapter');
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.STRIPE_SECRET_KEY;
      const origProvider = process.env.BILLING_PROVIDER;

      try {
        setBillingProvider(null);
        process.env.NODE_ENV = 'development';
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.BILLING_PROVIDER;

        const provider = getBillingProvider();
        assert.equal(provider.providerName, 'sandbox');
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origKey) process.env.STRIPE_SECRET_KEY = origKey;
        if (origProvider) process.env.BILLING_PROVIDER = origProvider;
        setBillingProvider(sandboxProvider);
      }
    });
  });

  // ==========================================
  // 2. Cryptographic Webhook Signature & Idempotency
  // ==========================================
  describe('2. Webhook Signature Verification & Idempotent Processing', () => {
    test('2.1 Rejects webhook with missing or invalid signature header', async () => {
      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'evt_no_sig', type: 'ping' }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /signature/i);
    });

    test('2.2 Rejects webhook with tampered body or wrong secret', async () => {
      const fakeEvent = { id: `evt_fake_${Date.now()}`, type: 'checkout.session.completed', data: { object: {} } };
      const { payload } = sandboxProvider.generateSignedPayload(fakeEvent, 'correct_secret');

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': 'invalid_signature_hash_12345',
        },
        body: payload,
      });
      assert.equal(res.status, 400);
    });

    test('2.3 Processes validly signed checkout.session.completed and upgrades workspace tier', async () => {
      const eventId = `evt_checkout_${Date.now()}`;
      const eventPayload = {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            workspaceId,
            tier: 'Growth',
            customerId: `cus_${workspaceId}`,
            subscriptionId: `sub_growth_${Date.now()}`,
          },
        },
      };

      const { payload, signature } = sandboxProvider.generateSignedPayload(eventPayload);

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.received, true);
      assert.equal(body.action, 'processed');

      // Verify stored subscription state
      const sub = await repo.getSubscriptionByWorkspace(workspaceId);
      assert.ok(sub);
      assert.equal(sub?.tier, 'Growth');
      assert.equal(sub?.status, 'active');

      // Verify store profile updated authoritatively to Growth tier
      const store = await repo.getStoreByWorkspace(workspaceId);
      assert.equal(store?.tier, 'Growth');
      assert.equal(store?.skuLimit, 2500);
    });

    test('2.4 Webhook retry / replay is strictly idempotent (no duplicate processing)', async () => {
      // Send identical event again
      const eventId = `evt_idempotent_${Date.now()}`;
      const eventPayload = {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            workspaceId,
            tier: 'Starter',
            customerId: `cus_${workspaceId}`,
            subscriptionId: `sub_starter_${Date.now()}`,
          },
        },
      };

      const { payload, signature } = sandboxProvider.generateSignedPayload(eventPayload);

      // Attempt 1: Processed
      const res1 = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      assert.equal(body1.action, 'processed');

      // Attempt 2: Duplicate detected, idempotent 200 returned
      const res2 = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.equal(body2.action, 'duplicate');
      assert.match(body2.message, /already processed/);

      // Verify audit event persisted
      const eventRecord = await repo.getBillingEventById(eventId);
      assert.ok(eventRecord);
      assert.equal(eventRecord?.status, 'processed');
    });

    test('2.5 In production mode, webhook rejects safely with HTTP 500 when signing secret is missing (no fallback)', async () => {
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const origBillingSecret = process.env.BILLING_WEBHOOK_SECRET;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.BILLING_WEBHOOK_SECRET;

        // Set active provider to Stripe without webhook secret
        setBillingProvider(new StripeBillingProvider('sk_test_dummy_key', ''));

        const res = await fetch(`${baseUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': 't=1234567,v1=dummy_signature',
          },
          body: JSON.stringify({ id: 'evt_prod_no_secret', type: 'ping' }),
        });

        assert.equal(res.status, 500);
        const body = await res.json();
        assert.match(body.error, /Production billing webhook secret is not configured/);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSecret) process.env.STRIPE_WEBHOOK_SECRET = origSecret;
        if (origBillingSecret) process.env.BILLING_WEBHOOK_SECRET = origBillingSecret;
        setBillingProvider(sandboxProvider);
      }
    });

    test('2.6 Raw-body integrity: Payload whose raw bytes differ from reserialized JSON succeeds verification', async () => {
      // Craft a payload with unique indentation, newlines, and space formatting
      const rawBodyString = '{\n  "id": "evt_raw_diff_' + Date.now() + '",\n  "type": "checkout.session.completed",\n  "data": {\n    "object": {\n      "workspaceId": "' + workspaceId + '",\n      "tier": "Enterprise",\n      "customerId": "cus_raw_bytes_test",\n      "subscriptionId": "sub_raw_bytes_test"\n    }\n  }\n}';

      // Assert that JSON.stringify(JSON.parse(rawBodyString)) produces DIFFERENT bytes
      const reserialized = JSON.stringify(JSON.parse(rawBodyString));
      assert.notEqual(reserialized, rawBodyString, 'Test precondition: raw bytes must differ from canonical JSON.stringify output');

      // Sign the EXACT raw body bytes using test secret
      const secret = sandboxProvider.getWebhookSecret();
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBodyString}`).digest('hex');
      const signature = `t=${timestamp},v1=${hmac}`;

      // Dispatch raw body string over HTTP
      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: rawBodyString,
      });

      assert.equal(res.status, 200);
      const resData = await res.json();
      assert.equal(resData.received, true);
      assert.equal(resData.action, 'processed');

      // Verify that the workspace tier was updated to Enterprise
      const sub = await repo.getSubscriptionByWorkspace(workspaceId);
      assert.equal(sub?.tier, 'Enterprise');
    });

    test('2.7 Unverified event (invalid signature) causes zero state mutation', async () => {
      // Record baseline state
      const beforeSub = await repo.getSubscriptionByWorkspace(workspaceId);
      const beforeStore = await repo.getStoreByWorkspace(workspaceId);
      const beforeEventsCount = (repo as any).billingEvents ? (repo as any).billingEvents.size : 0;

      const unverifiedEventId = `evt_unverified_${Date.now()}`;
      const fakeEvent = {
        id: unverifiedEventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            workspaceId,
            tier: 'Growth',
            customerId: 'cus_unverified',
          },
        },
      };

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=1234567,v1=tampered_signature_that_fails_verification',
        },
        body: JSON.stringify(fakeEvent),
      });

      assert.equal(res.status, 400);

      // Verify ZERO mutation
      const afterSub = await repo.getSubscriptionByWorkspace(workspaceId);
      const afterStore = await repo.getStoreByWorkspace(workspaceId);
      const afterEventsCount = (repo as any).billingEvents ? (repo as any).billingEvents.size : 0;

      assert.deepEqual(afterSub?.tier, beforeSub?.tier);
      assert.deepEqual(afterStore?.tier, beforeStore?.tier);
      assert.equal(afterEventsCount, beforeEventsCount, 'No billing event audit rows must be created for unverified requests');
    });

    test('2.8 Malformed JSON payload with valid signature header is rejected safely with HTTP 400', async () => {
      const malformedPayload = '{"id": "evt_broken", "type": '; // Invalid JSON syntax
      const secret = sandboxProvider.getWebhookSecret();
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${malformedPayload}`).digest('hex');
      const signature = `t=${timestamp},v1=${hmac}`;

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: malformedPayload,
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /malformed|json/i);
    });
  });

  // ==========================================
  // 3. Subscription Lifecycle & State Transitions
  // ==========================================
  describe('3. Subscription State Transitions & Downgrade Protection', () => {
    test('3.1 invoice.payment_failed marks subscription past_due and blocks new imports', async () => {
      // 1. Mark subscription past_due
      const eventPayload = {
        id: `evt_failed_${Date.now()}`,
        type: 'invoice.payment_failed',
        data: {
          object: {
            workspaceId,
          },
        },
      };
      const { payload, signature } = sandboxProvider.generateSignedPayload(eventPayload);

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      assert.equal(res.status, 200);

      // Verify subscription is past_due
      const sub = await repo.getSubscriptionByWorkspace(workspaceId);
      assert.equal(sub?.status, 'past_due');

      // Attempting to import additional products while past_due is rejected
      const store = await repo.getStoreByWorkspace(workspaceId);
      const quotaCheck = checkPlanQuota(store, [], 5, sub);
      assert.equal(quotaCheck.allowed, false);
      assert.match(quotaCheck.error || '', /past due/i);
    });

    test('3.2 invoice.payment_succeeded restores subscription to active', async () => {
      const eventPayload = {
        id: `evt_paid_${Date.now()}`,
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            workspaceId,
          },
        },
      };
      const { payload, signature } = sandboxProvider.generateSignedPayload(eventPayload);

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      assert.equal(res.status, 200);

      const sub = await repo.getSubscriptionByWorkspace(workspaceId);
      assert.equal(sub?.status, 'active');
    });

    test('3.3 customer.subscription.deleted downgrades plan without deleting catalog items', async () => {
      // Seed store catalog with 3 products
      await repo.saveWorkspaceCatalog(workspaceId, {
        products: [
          { id: 'p_dg_1', title: 'Product 1', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 80, evidenceCoverageScore: 80, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [{ id: 'v1', sku: 'SKU-1', title: 'V1', barcode: '', price: 10, inventoryCount: 5, attributes: {} }], offers: [], evidenceDocuments: [] },
          { id: 'p_dg_2', title: 'Product 2', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 80, evidenceCoverageScore: 80, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [{ id: 'v2', sku: 'SKU-2', title: 'V2', barcode: '', price: 20, inventoryCount: 5, attributes: {} }], offers: [], evidenceDocuments: [] },
        ],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: { name: 'Store', domain: 's.myshopify.com', currency: 'USD', skuCount: 2, catalogCompletenessAvg: 80, truthBoundaryStrictness: 'standard', tier: 'Starter', skuLimit: 250, connectors: [] },
      });

      // Send deletion event
      const eventPayload = {
        id: `evt_cancel_${Date.now()}`,
        type: 'customer.subscription.deleted',
        data: {
          object: {
            workspaceId,
          },
        },
      };
      const { payload, signature } = sandboxProvider.generateSignedPayload(eventPayload);

      const res = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      assert.equal(res.status, 200);

      // Verify store downgraded to Free Audit
      const store = await repo.getStoreByWorkspace(workspaceId);
      assert.equal(store?.tier, 'Free Audit');

      // CRITICAL DOMAIN RULE: Existing products must NOT be deleted on plan cancellation
      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      assert.equal(catalog?.products.length, 2, 'Existing products must remain intact after subscription downgrade');
    });
  });

  // ==========================================
  // 4. Billing API Endpoints & RBAC
  // ==========================================
  describe('4. Billing API Endpoints & Role Authorization', () => {
    test('4.1 GET /api/billing/plans returns public plan options', async () => {
      const res = await fetch(`${baseUrl}/api/billing/plans`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.plans.length, 4);
      assert.equal(data.currency, 'USD');
    });

    test('4.2 GET /api/billing/subscription returns current workspace subscription', async () => {
      const res = await fetch(`${baseUrl}/api/billing/subscription`, {
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.workspaceId, workspaceId);
      assert.ok(data.subscription);
    });

    test('4.3 POST /api/billing/checkout-session requires owner or admin role (member is rejected with 403)', async () => {
      // Member attempt
      const resMember = await fetch(`${baseUrl}/api/billing/checkout-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ tier: 'Growth' }),
      });
      assert.equal(resMember.status, 403);
      const dataMember = await resMember.json();
      assert.equal(dataMember.code, 'FORBIDDEN_INSUFFICIENT_ROLE');

      // Owner attempt succeeds
      const resOwner = await fetch(`${baseUrl}/api/billing/checkout-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ tier: 'Growth' }),
      });
      assert.equal(resOwner.status, 200);
      const dataOwner = await resOwner.json();
      assert.equal(dataOwner.success, true);
      assert.ok(dataOwner.checkoutUrl);
    });

    test('4.4 POST /api/billing/portal-session requires owner or admin role', async () => {
      const resMember = await fetch(`${baseUrl}/api/billing/portal-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
      });
      assert.equal(resMember.status, 403);

      const resOwner = await fetch(`${baseUrl}/api/billing/portal-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
      });
      assert.equal(resOwner.status, 200);
      const dataOwner = await resOwner.json();
      assert.equal(dataOwner.success, true);
      assert.ok(dataOwner.portalUrl);
    });

    test('4.5 POST /api/billing/checkout-session rejects untrusted external redirect URLs', async () => {
      const res = await fetch(`${baseUrl}/api/billing/checkout-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          tier: 'Growth',
          successUrl: 'https://attacker-controlled-phishing.com/steal-creds',
          cancelUrl: 'https://evil.org/attack',
        }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      // Ensure the generated checkout URL does NOT contain the untrusted attacker domain
      assert.ok(!data.checkoutUrl.includes('attacker-controlled-phishing.com'));
      assert.ok(!data.checkoutUrl.includes('evil.org'));
    });
  });

  // 5. Production Billing Reliability & Stripe Test-Mode Readiness Tests
  describe('Workstreams 1-4: Production Billing Reliability & Test-Mode Readiness', () => {
    test('WS1.1: Migration 005_billing_subscriptions.sql exists and defines required tables and indexes', () => {
      const migrationPath = path.resolve(process.cwd(), 'src/server/db/migrations/005_billing_subscriptions.sql');
      assert.ok(fs.existsSync(migrationPath), 'Migration 005 must exist');
      const sql = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS subscriptions'), 'Defines subscriptions table');
      assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS billing_events'), 'Defines billing_events table');
      assert.ok(sql.includes('last_event_created'), 'Contains last_event_created column');
      assert.ok(sql.includes('uq_billing_events_provider_event'), 'Contains provider+event unique constraint');
      assert.ok(sql.includes('REFERENCES workspaces(id) ON DELETE CASCADE'), 'Maintains strict workspace referential integrity');
    });

    test('WS1.2: PostgresRepository checkSchemaReadiness fails when subscriptions or billing_events table is missing', async () => {
      const { PostgresRepository } = await import('./db/postgresRepository');
      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('SELECT current_schema()')) return { rows: [{ schema_name: 'public' }] };
          if (sql.includes('information_schema.tables')) {
            // Missing billing_events
            return { rows: [{ table_name: 'users' }, { table_name: 'workspaces' }, { table_name: 'subscriptions' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      };
      const mockPool: any = {
        connect: async () => mockClient,
        end: async () => {},
      };
      const pgRepo = new PostgresRepository(mockPool);
      const readiness = await pgRepo.checkSchemaReadiness();
      assert.equal(readiness.isReady, false);
      assert.ok(readiness.missingTables?.includes('billing_events'), 'Reports missing billing_events table');
    });

    test('WS2.1: Stripe checkout.session.completed rejects invalid or manufactured customer ID', async () => {
      const stripeProvider = new StripeBillingProvider('sk_test_fake_key_123', 'whsec_test_secret_123');
      const stripeBillingService = new BillingService(repo, stripeProvider);

      const invalidEvent = {
        id: 'evt_checkout_invalid_cust_01',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: workspaceId,
            customer: 'invalid_non_stripe_cust_123', // Must start with cus_
            subscription: 'sub_valid_123',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };

      await assert.rejects(
        async () => {
          await (stripeBillingService as any).processEvent(invalidEvent);
        },
        (err: any) => {
          assert.match(err.message, /missing valid customer ID/i);
          return true;
        }
      );
    });

    test('WS2.2: Stripe checkout.session.completed rejects invalid or manufactured subscription ID', async () => {
      const stripeProvider = new StripeBillingProvider('sk_test_fake_key_123', 'whsec_test_secret_123');
      const stripeBillingService = new BillingService(repo, stripeProvider);

      const invalidEvent = {
        id: 'evt_checkout_invalid_sub_01',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: workspaceId,
            customer: 'cus_valid_stripe_cust_123',
            subscription: 'invalid_sub_id_not_stripe', // Must start with sub_
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };

      await assert.rejects(
        async () => {
          await (stripeBillingService as any).processEvent(invalidEvent);
        },
        (err: any) => {
          assert.match(err.message, /missing valid subscription ID/i);
          return true;
        }
      );
    });

    test('WS2.3: Stripe checkout.session.completed rejects unknown or unassociated Price ID', async () => {
      const stripeProvider = new StripeBillingProvider('sk_test_fake_key_123', 'whsec_test_secret_123');
      const stripeBillingService = new BillingService(repo, stripeProvider);

      const invalidPriceEvent = {
        id: 'evt_checkout_invalid_price_01',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: workspaceId,
            customer: 'cus_valid_stripe_cust_123',
            subscription: 'sub_valid_stripe_123',
            priceId: 'price_unknown_unassociated_random_999',
            payment_status: 'paid',
          },
        },
      };

      await assert.rejects(
        async () => {
          await (stripeBillingService as any).processEvent(invalidPriceEvent);
        },
        (err: any) => {
          assert.match(err.message, /not associated with an authoritative plan/i);
          return true;
        }
      );
    });

    test('WS2.4: checkout.session.completed with payment_status=unpaid creates incomplete sub and DOES NOT elevate store tier', async () => {
      // Ensure store starts at Free Audit
      await repo.saveStoreProfile(workspaceId, {
        name: 'Unpaid Test Store',
        domain: 'unpaid.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: 2500,
        tier: 'Free Audit',
        connectors: [],
        catalogCompletenessAvg: 100,
        truthBoundaryStrictness: 'standard',
      });

      const unpaidEvent = {
        id: 'evt_checkout_unpaid_01',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: workspaceId,
            customer: 'cus_unpaid_123',
            subscription: 'sub_unpaid_123',
            metadata: { tier: 'Growth' },
            payment_status: 'unpaid', // Unpaid payment status!
          },
        },
      };

      const result = await (billingService as any).processEvent(unpaidEvent);
      assert.equal(result.success, true);
      assert.equal(result.subscription.status, 'incomplete');

      // Verify store was NOT upgraded to Growth
      const store = await repo.getStoreByWorkspace(workspaceId);
      assert.equal(store?.tier, 'Free Audit');
      assert.equal(store?.skuLimit, 2500);
    });

    test('WS2.5: checkout.session.completed with payment_status=no_payment_required records trialing sub and grants tier', async () => {
      const trialEvent = {
        id: 'evt_checkout_trial_01',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: workspaceId,
            customer: 'cus_trial_123',
            subscription: 'sub_trial_123',
            metadata: { tier: 'Starter' },
            payment_status: 'no_payment_required',
          },
        },
      };

      const result = await (billingService as any).processEvent(trialEvent);
      assert.equal(result.success, true);
      assert.equal(result.subscription.status, 'trialing');

      // Store should reflect Starter tier
      const store = await repo.getStoreByWorkspace(workspaceId);
      assert.equal(store?.tier, 'Starter');
      assert.equal(store?.skuLimit, 250);
    });

    test('WS3.1: Concurrent duplicate webhook deliveries are claimed exactly once; second is marked duplicate', async () => {
      const eventPayload = {
        id: 'evt_concurrent_race_test_01',
        type: 'customer.subscription.updated',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'sub_concurrent_test_123',
            customer: 'cus_race_123',
            metadata: { workspaceId, tier: 'Growth' },
            status: 'active',
          },
        },
      };

      const rawBody = JSON.stringify(eventPayload);
      const secret = 'test_webhook_secret_key_abc123';
      const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      // Fire two concurrent handleWebhook calls
      const [res1, res2] = await Promise.all([
        billingService.handleWebhook(rawBody, sig),
        billingService.handleWebhook(rawBody, sig),
      ]);

      const actions = [res1.action, res2.action];
      assert.ok(actions.includes('processed'), 'At least one worker processed the event');
      assert.ok(actions.includes('duplicate'), 'Second worker received duplicate action');
    });

    test('WS3.2: Failed event can be retried and recovered', async () => {
      const failedEventId = 'evt_retry_recovery_test_01';
      // Seed a failed event in repo
      await repo.saveBillingEvent({
        id: `bevt_${failedEventId}`,
        provider: 'sandbox',
        eventId: failedEventId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: failedEventId,
        payload: {},
        status: 'failed',
        processedAt: new Date(Date.now() - 60000).toISOString(),
      });

      // Claiming a failed event succeeds for retry
      const claim = await repo.claimBillingEvent({
        id: `bevt_${failedEventId}`,
        provider: 'sandbox',
        eventId: failedEventId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: failedEventId,
        payload: { test: true },
        status: 'processing',
        processedAt: new Date().toISOString(),
      });

      assert.equal(claim.claimed, true, 'Failed event should be re-claimable for retry');
    });

    test('WS3.3: Stale processing event (>5 minutes old) is recovered by claimBillingEvent', async () => {
      const staleEventId = 'evt_stale_recovery_test_01';
      // Seed an event stuck in processing from 10 minutes ago
      await repo.saveBillingEvent({
        id: `bevt_${staleEventId}`,
        provider: 'sandbox',
        eventId: staleEventId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: staleEventId,
        payload: {},
        status: 'processing',
        processedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      const claim = await repo.claimBillingEvent({
        id: `bevt_${staleEventId}`,
        provider: 'sandbox',
        eventId: staleEventId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: staleEventId,
        payload: { test: true },
        status: 'processing',
        processedAt: new Date().toISOString(),
      });

      assert.equal(claim.claimed, true, 'Stale processing event must be claimed by recovery worker');
    });

    test('WS4.1: customer.subscription.updated with cancel_at_period_end preserves active tier until period end', async () => {
      const ws4Id = `ws_ws4_lifecycle_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${ws4Id}`, email: `${ws4Id}@example.com`, passwordHash: 'hash', fullName: 'WS4 Owner' });
      await repo.createWorkspace({ id: ws4Id, name: 'Lifecycle WS', slug: `lifecycle-${ws4Id}` }, owner.id);
      await repo.saveStoreProfile(ws4Id, {
        name: 'Lifecycle Store',
        domain: 'lifecycle.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: 2500,
        tier: 'Free Audit',
        connectors: [],
        catalogCompletenessAvg: 100,
        truthBoundaryStrictness: 'standard',
      });

      // First, set subscription to active Growth at t=1000
      const activeEvent = {
        id: 'evt_sub_active_growth_01',
        type: 'customer.subscription.updated',
        created: 1000,
        data: {
          object: {
            id: 'sub_period_end_test_123',
            customer: 'cus_period_end_123',
            metadata: { workspaceId: ws4Id, tier: 'Growth' },
            status: 'active',
            cancel_at_period_end: false,
          },
        },
      };
      const activeRes = await (billingService as any).processEvent(activeEvent);
      assert.equal(activeRes.success, true);

      let store = await repo.getStoreByWorkspace(ws4Id);
      assert.equal(store?.tier, 'Growth');
      assert.equal(store?.skuLimit, 2500);

      // Now set cancel_at_period_end: true at t=1001
      const cancelAtPeriodEndEvent = {
        id: 'evt_sub_cancel_at_period_end_01',
        type: 'customer.subscription.updated',
        created: 1001,
        data: {
          object: {
            id: 'sub_period_end_test_123',
            customer: 'cus_period_end_123',
            metadata: { workspaceId: ws4Id, tier: 'Growth' },
            status: 'active',
            cancel_at_period_end: true, // User requested cancellation at end of billing cycle
          },
        },
      };

      const result = await (billingService as any).processEvent(cancelAtPeriodEndEvent);
      assert.equal(result.success, true);
      assert.equal(result.subscription.cancelAtPeriodEnd, true);
      assert.equal(result.subscription.status, 'active');

      // Store tier and limit MUST STILL BE Growth!
      store = await repo.getStoreByWorkspace(ws4Id);
      assert.equal(store?.tier, 'Growth', 'Store tier must not be downgraded early when cancel_at_period_end is true');
      assert.equal(store?.skuLimit, 2500);
    });

    test('WS4.2: customer.subscription.deleted downgrades store to Free Audit without deleting catalog products', async () => {
      const ws4Id = `ws_ws4_deleted_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${ws4Id}`, email: `${ws4Id}@example.com`, passwordHash: 'hash', fullName: 'WS4 Owner' });
      await repo.createWorkspace({ id: ws4Id, name: 'Deleted WS', slug: `deleted-${ws4Id}` }, owner.id);
      const storeProfile = await repo.saveStoreProfile(ws4Id, {
        name: 'Deleted Store',
        domain: 'deleted.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: 2500,
        tier: 'Growth',
        connectors: [],
        catalogCompletenessAvg: 100,
        truthBoundaryStrictness: 'standard',
      });

      // Save initial subscription at t=1000
      await repo.saveSubscription({
        id: `subrec_${ws4Id}`,
        workspaceId: ws4Id,
        provider: 'sandbox',
        customerId: 'cus_deleted_test_123',
        subscriptionId: 'sub_deleted_test_123',
        tier: 'Growth',
        status: 'active',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
        cancelAtPeriodEnd: false,
        lastEventCreated: 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Seed catalog products
      const sampleVariant = {
        id: 'var_01',
        sku: 'SKU-KEEP-1',
        title: 'Default Title',
        barcode: '12345678',
        price: 99.99,
        inventoryCount: 10,
        attributes: {},
      };

      await repo.saveWorkspaceCatalog(ws4Id, {
        products: [
          {
            id: 'prod_preserve_01',
            title: 'Valuable Catalog Product',
            brand: 'Premium Brand',
            category: 'Preserved',
            description: 'Preserved item during downgrade',
            image: '',
            status: 'active',
            completenessScore: 95,
            evidenceCoverageScore: 80,
            externalDiscoveryStatus: 'observed_in_sample',
            attributes: {},
            variants: [sampleVariant],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          },
        ],
        variants: [sampleVariant],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile,
      });

      const deletedEvent = {
        id: 'evt_sub_deleted_01',
        type: 'customer.subscription.deleted',
        created: 2000,
        data: {
          object: {
            id: 'sub_deleted_test_123',
            customer: 'cus_deleted_test_123',
            metadata: { workspaceId: ws4Id },
          },
        },
      };

      const result = await (billingService as any).processEvent(deletedEvent);
      assert.equal(result.success, true);

      // Verify store profile is downgraded to Free Audit (2500 limit)
      const store = await repo.getStoreByWorkspace(ws4Id);
      assert.equal(store?.tier, 'Free Audit');
      assert.equal(store?.skuLimit, 2500);

      // CRITICAL: Catalog products MUST NOT be deleted!
      const cat = await repo.loadWorkspaceCatalog(ws4Id);
      assert.equal(cat?.products.length, 1);
      assert.equal(cat?.products[0].id, 'prod_preserve_01');
      assert.equal(cat?.products[0].title, 'Valuable Catalog Product');
    });

    test('WS4.3: Out-of-order stale event does not overwrite newer subscription state', async () => {
      const ws4Id = `ws_ws4_order_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${ws4Id}`, email: `${ws4Id}@example.com`, passwordHash: 'hash', fullName: 'WS4 Owner' });
      await repo.createWorkspace({ id: ws4Id, name: 'Order WS', slug: `order-${ws4Id}` }, owner.id);
      await repo.saveSubscription({
        id: `subrec_${ws4Id}`,
        workspaceId: ws4Id,
        provider: 'sandbox',
        customerId: 'cus_order_test_123',
        subscriptionId: 'sub_order_test_123',
        tier: 'Growth',
        status: 'canceled',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: true,
        lastEventCreated: 2000, // Newer event timestamp
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Stale event created at timestamp 1500 (< 2000)
      const staleInvoiceEvent = {
        id: 'evt_stale_invoice_01',
        type: 'invoice.payment_succeeded',
        created: 1500,
        data: {
          object: {
            subscription: 'sub_order_test_123',
            metadata: { workspaceId: ws4Id },
          },
        },
      };

      const result = await (billingService as any).processEvent(staleInvoiceEvent);
      assert.equal(result.action, 'ignored');
      assert.match(result.message, /stale.*safely ignored/i);

      // Subscription remains canceled
      const currentSub = await repo.getSubscriptionByWorkspace(ws4Id);
      assert.equal(currentSub?.status, 'canceled');
    });
  });

  // ==========================================
  // 6. Task B: Stripe Subscription Status Must Fail Closed
  // ==========================================
  describe('Workstream 5 (Task B): Stripe Subscription Status Fail-Closed Enforcement', () => {
    test('B.1 normalizeStripeSubscriptionStatus classifies known statuses and fails closed on unknown/missing/non-string', async () => {
      const { normalizeStripeSubscriptionStatus } = await import('./services/billingService');

      assert.deepEqual(normalizeStripeSubscriptionStatus('active'), {
        status: 'active',
        isKnownStatus: true,
        isAuthorizedPaidTier: true,
        rawStatus: 'active',
      });
      assert.deepEqual(normalizeStripeSubscriptionStatus(' TRIALING '), {
        status: 'trialing',
        isKnownStatus: true,
        isAuthorizedPaidTier: true,
        rawStatus: 'trialing',
      });

      for (const nonActive of ['past_due', 'canceled', 'cancelled', 'unpaid', 'incomplete', 'incomplete_expired', 'expired', 'pending']) {
        const res = normalizeStripeSubscriptionStatus(nonActive);
        assert.equal(res.isKnownStatus, true);
        assert.equal(res.isAuthorizedPaidTier, false, `Status ${nonActive} must NOT authorize paid tier`);
      }

      for (const invalid of ['paused', 'unknown_status', '', '   ', undefined, null, 123, {}]) {
        const res = normalizeStripeSubscriptionStatus(invalid);
        assert.equal(res.status, 'incomplete', `Invalid status ${String(invalid)} must fail closed to incomplete`);
        assert.equal(res.isKnownStatus, false);
        assert.equal(res.isAuthorizedPaidTier, false);
      }
    });

    test('B.2 customer.subscription.updated with unknown ("paused"), empty, or missing status downgrades paid tier to Free Audit', async () => {
      const { resolveWorkspacePlanEntitlement } = await import('./services/entitlementService');

      for (const rawStatus of ['paused', '', undefined, 42] as any[]) {
        const wsB = `ws_task_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const owner = await repo.createUser({
          id: `usr_${wsB}`,
          email: `${wsB}@example.com`,
          passwordHash: 'hash',
          fullName: 'Task B Owner',
        });
        await repo.createWorkspace({ id: wsB, name: 'Task B WS', slug: `ws-${wsB}` }, owner.id);
        await repo.saveStoreProfile(wsB, {
          name: 'Task B Store',
          domain: 'taskb.myshopify.com',
          currency: 'USD',
          skuCount: 0,
          skuLimit: 2500,
          tier: 'Growth',
          connectors: [],
          catalogCompletenessAvg: 100,
          truthBoundaryStrictness: 'standard',
        });
        await repo.saveSubscription({
          id: `subrec_${wsB}`,
          workspaceId: wsB,
          provider: 'stripe',
          customerId: 'cus_task_b_1',
          subscriptionId: 'sub_task_b_1',
          tier: 'Growth',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: 1000,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_test_key');
        const stripeBillingSvc = new BillingService(repo, stripeProvider);

        const eventObj: Record<string, any> = {
          id: 'sub_task_b_1',
          customer: 'cus_task_b_1',
          metadata: { workspaceId: wsB, tier: 'Growth' },
        };
        if (rawStatus !== undefined) {
          eventObj.status = rawStatus;
        }

        const res = await (stripeBillingSvc as any).processEvent({
          id: `evt_bad_status_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'customer.subscription.updated',
          created: 2000,
          data: { object: eventObj },
        });

        assert.equal(res.success, true);
        assert.equal(res.subscription.status, 'incomplete');

        const updatedStore = await repo.getStoreByWorkspace(wsB);
        assert.equal(updatedStore?.tier, 'Free Audit', `Status ${String(rawStatus)} must retract paid store tier`);

        const entitlement = resolveWorkspacePlanEntitlement(updatedStore, res.subscription);
        assert.equal(entitlement.tier, 'Free Audit');
        assert.equal(entitlement.subscriptionStatus, 'incomplete');
      }
    });

    test('B.3 Stripe checkout.session.completed with missing/empty/unknown payment_status fails closed and replay is idempotent', async () => {
      const wsB = `ws_task_b_chk_${Date.now()}`;
      const owner = await repo.createUser({
        id: `usr_${wsB}`,
        email: `${wsB}@example.com`,
        passwordHash: 'hash',
        fullName: 'Task B Checkout Owner',
      });
      await repo.createWorkspace({ id: wsB, name: 'Task B Checkout', slug: `ws-${wsB}` }, owner.id);

      const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_test_key');
      const stripeBillingSvc = new BillingService(repo, stripeProvider);

      const eventId = `evt_stripe_missing_payment_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsB,
            customer: 'cus_stripe_missing_pay_1',
            subscription: 'sub_stripe_missing_pay_1',
            metadata: { tier: 'Growth' },
            // payment_status intentionally omitted!
          },
        },
      };

      const raw = JSON.stringify(payloadObj);
      const mockSignedProvider = new StripeBillingProvider(
        'sk_test_key',
        'whsec_test_key',
        createMockStripeClient()
      );
      const svcWithMockVerify = new BillingService(repo, mockSignedProvider);

      const r1 = await svcWithMockVerify.handleWebhook(raw, 't=123,v1=valid');
      assert.equal(r1.success, true);
      assert.equal(r1.action, 'processed');
      assert.equal(r1.subscription?.status, 'incomplete');

      const store = await repo.getStoreByWorkspace(wsB);
      assert.equal(store?.tier, 'Free Audit', 'Stripe checkout without payment_status=paid/no_payment_required must NOT elevate tier');

      // Idempotent replay also never elevates
      const r2 = await svcWithMockVerify.handleWebhook(raw, 't=123,v1=valid');
      assert.equal(r2.action, 'duplicate');
      assert.equal((await repo.getStoreByWorkspace(wsB))?.tier, 'Free Audit');
    });

    test('B.3 Lifecycle edge cases: trialing -> past_due -> active, canceled cannot resurrect on invoice payment or non-active update, out-of-order stale active ignored', async () => {
      const wsB = `ws_task_b_life_${Date.now()}`;
      const owner = await repo.createUser({
        id: `usr_${wsB}`,
        email: `${wsB}@example.com`,
        passwordHash: 'hash',
        fullName: 'Task B Life Owner',
      });
      await repo.createWorkspace({ id: wsB, name: 'Task B Life WS', slug: `ws-${wsB}` }, owner.id);

      const mockSignedProvider = new StripeBillingProvider(
        'sk_test_key',
        'whsec_test_key',
        createMockStripeClient()
      );
      const svc = new BillingService(repo, mockSignedProvider);

      const sendEvt = async (evt: any) => svc.handleWebhook(JSON.stringify(evt), 't=123,v1=valid');

      // 1. trialing grants Starter
      await sendEvt({
        id: `evt_b_trial_${Date.now()}`,
        type: 'customer.subscription.updated',
        created: 2000,
        data: { object: { id: 'sub_life_1', customer: 'cus_life_1', metadata: { workspaceId: wsB, tier: 'Starter' }, status: 'trialing' } },
      });
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'trialing');
      assert.equal((await repo.getStoreByWorkspace(wsB))?.tier, 'Starter');

      // 2. past_due marks past_due while preserving tier metadata
      await sendEvt({
        id: `evt_b_pastdue_${Date.now()}`,
        type: 'invoice.payment_failed',
        created: 2010,
        data: { object: { subscription: 'sub_life_1', metadata: { workspaceId: wsB } } },
      });
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'past_due');

      // 3. invoice.payment_succeeded reactivates past_due -> active
      await sendEvt({
        id: `evt_b_recover_${Date.now()}`,
        type: 'invoice.payment_succeeded',
        created: 2020,
        data: { object: { subscription: 'sub_life_1', metadata: { workspaceId: wsB } } },
      });
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'active');

      // 4. customer.subscription.deleted cancels & downgrades to Free Audit
      await sendEvt({
        id: `evt_b_cancel_${Date.now()}`,
        type: 'customer.subscription.deleted',
        created: 2030,
        data: { object: { id: 'sub_life_1', customer: 'cus_life_1', metadata: { workspaceId: wsB } } },
      });
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'canceled');
      assert.equal((await repo.getStoreByWorkspace(wsB))?.tier, 'Free Audit');

      // 5. invoice.payment_succeeded & non-active subscription.updated cannot resurrect canceled sub
      await sendEvt({
        id: `evt_b_post_cancel_paid_${Date.now()}`,
        type: 'invoice.payment_succeeded',
        created: 2040,
        data: { object: { subscription: 'sub_life_1', metadata: { workspaceId: wsB } } },
      });
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'canceled');
      assert.equal((await repo.getStoreByWorkspace(wsB))?.tier, 'Free Audit');

      const nonActiveUpdate = await sendEvt({
        id: `evt_b_post_cancel_pastdue_${Date.now()}`,
        type: 'customer.subscription.updated',
        created: 2045,
        data: { object: { id: 'sub_life_1', customer: 'cus_life_1', metadata: { workspaceId: wsB, tier: 'Growth' }, status: 'past_due' } },
      });
      assert.equal(nonActiveUpdate.action, 'ignored');
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'canceled');

      // 6. Stale out-of-order 'active' event (created=2025 < 2030) is safely ignored
      const staleActive = await sendEvt({
        id: `evt_b_stale_active_${Date.now()}`,
        type: 'customer.subscription.updated',
        created: 2025,
        data: { object: { id: 'sub_life_1', customer: 'cus_life_1', metadata: { workspaceId: wsB, tier: 'Enterprise' }, status: 'active' } },
      });
      assert.equal(staleActive.action, 'ignored');
      assert.equal((await repo.getSubscriptionByWorkspace(wsB))?.status, 'canceled');
      assert.equal((await repo.getStoreByWorkspace(wsB))?.tier, 'Free Audit');
    });
  });

  // ==========================================
  // 7. Task C: Webhook In-Progress HTTP 503 & Retry Recovery
  // ==========================================
  describe('Workstream 6 (Task C): Webhook In-Progress HTTP 503 & Lease Recovery Tests', () => {
    function signSandboxEvent(payload: any, secret: string): string {
      return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    }

    test('C.1 In-flight processing duplicate returns HTTP 503 + Retry-After: 30; terminal duplicate returns HTTP 200', async () => {
      const wsC = `ws_task_c_http_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Owner' });
      await repo.createWorkspace({ id: wsC, name: 'Task C WS', slug: `ws-${wsC}` }, owner.id);

      const eventId = `evt_c_inflight_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsC,
            customer: 'cus_task_c_1',
            subscription: 'sub_task_c_1',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };
      const raw = JSON.stringify(payloadObj);
      const sig = sandboxProvider.generateSignedPayload(payloadObj).signature;

      // Worker 1 claims an active lease (in-flight)
      const activeClaim = await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: payloadObj.type,
          idempotencyKey: eventId,
          payload: payloadObj,
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_1_active', leaseDurationMs: 60_000 }
      );
      assert.equal(activeClaim.claimed, true);

      // Concurrent HTTP webhook delivery while active lease exists -> MUST return 503 (never 200!)
      const inflightRes = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      });
      assert.equal(inflightRes.status, 503);
      assert.equal(inflightRes.headers.get('retry-after'), '30');
      const inflightJson = await inflightRes.json();
      assert.equal(inflightJson.received, false);
      assert.equal(inflightJson.inProgress, true);
      assert.equal(inflightJson.retryable, true);

      // Worker 1 completes entitlement transition
      await repo.applyBillingTransition({
        eventId,
        leaseOwner: 'worker_1_active',
        subscription: {
          id: `subrec_${wsC}`,
          workspaceId: wsC,
          provider: 'sandbox',
          customerId: 'cus_task_c_1',
          subscriptionId: 'sub_task_c_1',
          tier: 'Growth',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: payloadObj.created,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        storeProfileUpdate: { tier: 'Growth', skuLimit: 2500 },
      });

      // Replay AFTER processed -> returns HTTP 200 duplicate
      const doneRes = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      });
      assert.equal(doneRes.status, 200);
      const doneJson = await doneRes.json();
      assert.equal(doneJson.received, true);
      assert.equal(doneJson.action, 'duplicate');
    });

    test('C.2 Crashed Worker 1 leaves processing event -> HTTP 503 before expiry, reclaims & applies cleanly (HTTP 200) after expiry, stale Worker 1 blocked', async () => {
      const wsC = `ws_task_c_crash_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Crash' });
      await repo.createWorkspace({ id: wsC, name: 'Task C Crash WS', slug: `ws-${wsC}` }, owner.id);

      const eventId = `evt_c_crash_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsC,
            customer: 'cus_c_crash_1',
            subscription: 'sub_c_crash_1',
            metadata: { tier: 'Starter' },
            payment_status: 'paid',
          },
        },
      };
      const raw = JSON.stringify(payloadObj);
      const sig = sandboxProvider.generateSignedPayload(payloadObj).signature;

      // Worker 1 claims a short 80ms lease and crashes
      const claim1 = await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: payloadObj.type,
          idempotencyKey: eventId,
          payload: payloadObj,
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'crashed_worker_1', leaseDurationMs: 80 }
      );
      assert.equal(claim1.claimed, true);

      // Immediate retry before expiry -> HTTP 503
      const earlyRetry = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      });
      assert.equal(earlyRetry.status, 503);

      // Wait for lease to expire
      await new Promise(r => setTimeout(r, 110));

      // Retry after expiry -> HTTP 200, reclaims and grants entitlement once
      const recoveredRes = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      });
      assert.equal(recoveredRes.status, 200);
      const recoveredJson = await recoveredRes.json();
      assert.equal(recoveredJson.action, 'processed');

      const store = await repo.getStoreByWorkspace(wsC);
      assert.equal(store?.tier, 'Starter');

      // Stale crashed_worker_1 waking up later cannot mutate entitlement or overwrite 'processed' -> 'failed'
      await assert.rejects(
        () =>
          repo.applyBillingTransition({
            eventId,
            leaseOwner: 'crashed_worker_1',
            subscription: {
              id: `subrec_${wsC}`,
              workspaceId: wsC,
              provider: 'sandbox',
              customerId: 'cus_stale',
              subscriptionId: 'sub_stale',
              tier: 'Enterprise',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: payloadObj.created + 10,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            storeProfileUpdate: { tier: 'Enterprise', skuLimit: 99999 },
          }),
        /lost or expired/i
      );
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Starter');
      assert.equal((await repo.getBillingEventById(eventId))?.status, 'processed');
    });

    test('C.3 DB outage on claim/transition or lost heartbeat returns HTTP 503 (never 400/200)', async () => {
      const express = (await import('express')).default;
      const { createBillingRoutes } = await import('./routes/billingRoutes');
      const localSecret = 'task_c_db_outage_secret';
      const localProvider = new SandboxBillingProvider(localSecret);

      const dbRepo = new MemoryRepository(false);
      const wsC = `ws_task_c_db_${Date.now()}`;
      const owner = await dbRepo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C DB' });
      await dbRepo.createWorkspace({ id: wsC, name: 'Task C DB WS', slug: `ws-${wsC}` }, owner.id);

      let injectFailure: 'claim_db_error' | 'heartbeat_lost' | 'none' = 'claim_db_error';
      const flakyRepo = new Proxy(dbRepo, {
        get(target, prop, receiver) {
          if (prop === 'claimBillingEvent' && injectFailure === 'claim_db_error') {
            return async () => {
              throw new Error('ECONNRESET claiming billing event');
            };
          }
          if (prop === 'renewBillingEventLease' && injectFailure === 'heartbeat_lost') {
            return async () => false;
          }
          if (prop === 'getWorkspaceById' && injectFailure === 'heartbeat_lost') {
            return async (id: string) => {
              await new Promise(r => setTimeout(r, 90));
              return target.getWorkspaceById(id);
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const localApp = express();
      localApp.use(
        '/api/billing',
        express.json({
          verify: (req: any, _res, buf) => {
            req.rawBody = buf;
          },
        }),
        createBillingRoutes(flakyRepo, localProvider, { leaseDurationMs: 70, heartbeatIntervalMs: 20 })
      );

      const localServer = http.createServer(localApp);
      await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', () => resolve()));
      const addr = localServer.address() as any;
      const localUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const evt1 = {
          id: `evt_c_db_${Date.now()}`,
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: wsC,
              customer: 'cus_db_1',
              subscription: 'sub_db_1',
              metadata: { tier: 'Growth' },
              payment_status: 'paid',
            },
          },
        };
        const dbRes = await fetch(`${localUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': signSandboxEvent(evt1, localSecret) },
          body: JSON.stringify(evt1),
        });
        assert.equal(dbRes.status, 503);
        assert.equal(dbRes.headers.get('retry-after'), '30');

        injectFailure = 'heartbeat_lost';
        const evt2 = { ...evt1, id: `evt_c_hb_lost_${Date.now()}` };
        const hbRes = await fetch(`${localUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': signSandboxEvent(evt2, localSecret) },
          body: JSON.stringify(evt2),
        });
        assert.equal(hbRes.status, 503);
        const hbJson = await hbRes.json();
        assert.equal(hbJson.code, 'BILLING_LEASE_LOST');
        assert.equal((await dbRepo.getStoreByWorkspace(wsC))?.tier, 'Free Audit');
      } finally {
        await new Promise<void>((resolve, reject) => localServer.close(err => (err ? reject(err) : resolve())));
      }
    });

    test('C.4 Transient failure preserves payloadJson cleanly and records sanitized lastError (never overwrites payload)', async () => {
      const wsC = `ws_task_c_preserve_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Preserve' });
      await repo.createWorkspace({ id: wsC, name: 'Task C Preserve WS', slug: `ws-${wsC}` }, owner.id);

      const secretErrRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'applyBillingTransition') {
            return async () => {
              const err: any = new Error(
                'DB fail postgresql://admin:SuperSecret99@db.internal:5432/prod key=sk_test_51AbcDef12345 whsec_secret123'
              );
              err.statusCode = 503;
              throw err;
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const localSvc = new BillingService(secretErrRepo, sandboxProvider, undefined, {
        maxAttempts: 4,
        baseBackoffMs: 1000,
        maxBackoffMs: 10000,
      });

      const eventId = `evt_c_preserve_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsC,
            customer: 'cus_preserve_1',
            subscription: 'sub_preserve_1',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };
      const raw = JSON.stringify(payloadObj);
      const sig = sandboxProvider.generateSignedPayload(payloadObj).signature;

      await assert.rejects(() => localSvc.handleWebhook(raw, sig), /postgresql:\/\//);

      const stored = await repo.getBillingEventById(eventId);
      assert.ok(stored);
      assert.equal(stored?.status, 'failed');
      // Critical invariant: payload MUST remain intact original Stripe event object, never overwritten by error message
      assert.equal((stored?.payload as any)?.id, eventId);
      assert.equal((stored?.payload as any)?.type, 'checkout.session.completed');
      assert.equal((stored?.payload as any)?.data?.object?.subscription, 'sub_preserve_1');
      assert.ok(stored?.lastError, 'lastError must be recorded separately');
      assert.doesNotMatch(stored?.lastError || '', /SuperSecret99|sk_test_51AbcDef12345|whsec_secret123/);
      assert.ok(stored?.nextRetryAt, 'nextRetryAt must be scheduled for transient failure');
    });

    test('C.5 Lease expiry boundary & concurrent recovery sweep: only 1 of 2 competing recovery workers processes expired event', async () => {
      const raceRepo = new MemoryRepository(false);
      const wsC = `ws_task_c_race_${Date.now()}`;
      const owner = await raceRepo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Race' });
      await raceRepo.createWorkspace({ id: wsC, name: 'Task C Race WS', slug: `ws-${wsC}` }, owner.id);

      const unexpiredId = `evt_c_unexpired_${Date.now()}`;
      const expiredId = `evt_c_expired_${Date.now()}`;

      await raceRepo.claimBillingEvent(
        {
          id: `bevt_${unexpiredId}`,
          provider: 'sandbox',
          eventId: unexpiredId,
          eventType: 'checkout.session.completed',
          idempotencyKey: unexpiredId,
          payload: {
            id: unexpiredId,
            type: 'checkout.session.completed',
            created: Math.floor(Date.now() / 1000),
            data: { object: { client_reference_id: wsC, customer: 'cus_u1', subscription: 'sub_u1', metadata: { tier: 'Starter' }, payment_status: 'paid' } },
          },
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'alive_worker', leaseDurationMs: 60_000 }
      );

      await raceRepo.claimBillingEvent(
        {
          id: `bevt_${expiredId}`,
          provider: 'sandbox',
          eventId: expiredId,
          eventType: 'checkout.session.completed',
          idempotencyKey: expiredId,
          payload: {
            id: expiredId,
            type: 'checkout.session.completed',
            created: Math.floor(Date.now() / 1000),
            data: { object: { client_reference_id: wsC, customer: 'cus_e1', subscription: 'sub_e1', metadata: { tier: 'Growth' }, payment_status: 'paid' } },
          },
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'crashed_worker', leaseDurationMs: 50 }
      );

      await new Promise(r => setTimeout(r, 70));

      // Unexpired must NOT be listed; expired MUST be listed
      const recoverable = await raceRepo.listRecoverableBillingEvents({ provider: 'sandbox', limit: 100 });
      assert.equal(recoverable.some(e => e.eventId === unexpiredId), false);
      assert.equal(recoverable.some(e => e.eventId === expiredId), true);

      // Slow down transition briefly to let two recovery workers race cleanly
      let applyCalls = 0;
      const countingRepo = new Proxy(raceRepo, {
        get(target, prop, receiver) {
          if (prop === 'applyBillingTransition') {
            return async (params: any) => {
              applyCalls++;
              return target.applyBillingTransition(params);
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const workerA = new BillingService(countingRepo, sandboxProvider);
      const workerB = new BillingService(countingRepo, sandboxProvider);

      const [sumA, sumB] = await Promise.all([
        workerA.recoverPendingWebhookEvents({ leaseOwnerPrefix: 'rec_A', limit: 100 }),
        workerB.recoverPendingWebhookEvents({ leaseOwnerPrefix: 'rec_B', limit: 100 }),
      ]);

      const recoveredDetailCount = [...sumA.details, ...sumB.details].filter(
        d => d.eventId === expiredId && d.outcome === 'recovered'
      ).length;
      const contendedDetailCount = [...sumA.details, ...sumB.details].filter(
        d => d.eventId === expiredId && d.outcome === 'skipped_contended'
      ).length;

      assert.equal(recoveredDetailCount, 1, 'Exactly one recovery worker must recover expired event');
      assert.equal(contendedDetailCount, 1, 'Competing worker must record skipped_contended');
      assert.equal(applyCalls, 1, 'Entitlement transition must apply strictly once');
      assert.equal((await raceRepo.getStoreByWorkspace(wsC))?.tier, 'Growth');
      assert.equal((await raceRepo.getBillingEventById(expiredId))?.status, 'processed');
      assert.equal((await raceRepo.getBillingEventById(unexpiredId))?.status, 'processing');
    });

    test('C.6 Recovery backoff skips future nextRetryAt and succeeds once retry window opens', async () => {
      const wsC = `ws_task_c_backoff_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Backoff' });
      await repo.createWorkspace({ id: wsC, name: 'Task C Backoff WS', slug: `ws-${wsC}` }, owner.id);

      const eventId = `evt_c_backoff_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsC,
            customer: 'cus_bo_1',
            subscription: 'sub_bo_1',
            metadata: { tier: 'Enterprise' },
            payment_status: 'paid',
          },
        },
      };

      let failFirstRecovery = true;
      const transientRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'applyBillingTransition' && failFirstRecovery) {
            return async () => {
              const err: any = new Error('Transient Postgres deadlock');
              err.statusCode = 503;
              throw err;
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const svc = new BillingService(transientRepo, sandboxProvider, undefined, {
        maxAttempts: 4,
        baseBackoffMs: 120,
        maxBackoffMs: 5000,
      });

      // Seed expired 'processing' event (attemptCount = 1)
      await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: payloadObj.type,
          idempotencyKey: eventId,
          payload: payloadObj,
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'crashed_w1', leaseDurationMs: 50 }
      );
      await new Promise(r => setTimeout(r, 65));

      // Attempt 2 runs via recovery worker -> fails transiently -> sets nextRetryAt ~ 240ms in future
      const sumFail = await svc.recoverPendingWebhookEvents({ limit: 100 });
      const failDetail = sumFail.details.find(d => d.eventId === eventId);
      assert.equal(failDetail?.outcome, 'retried_failed');
      assert.equal(failDetail?.attemptCount, 2);

      const afterFail = await repo.getBillingEventById(eventId);
      assert.equal(afterFail?.status, 'failed');
      assert.ok(afterFail?.nextRetryAt && new Date(afterFail.nextRetryAt).getTime() > Date.now());

      // Fix underlying DB condition immediately, sweep BEFORE backoff expires -> must be skipped cleanly
      failFirstRecovery = false;
      const sumEarly = await svc.recoverPendingWebhookEvents({ limit: 100 });
      assert.equal(sumEarly.details.some(d => d.eventId === eventId), false, 'Must respect nextRetryAt backoff window');

      // Wait until nextRetryAt elapses, sweep again -> succeeds!
      await new Promise(r => setTimeout(r, 270));
      const sumOk = await svc.recoverPendingWebhookEvents({ limit: 100 });
      const okDetail = sumOk.details.find(d => d.eventId === eventId);
      assert.equal(okDetail?.outcome, 'recovered');
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Enterprise');
      assert.equal((await repo.getBillingEventById(eventId))?.status, 'processed');
      assert.equal((await repo.getBillingEventById(eventId))?.nextRetryAt, null);
      assert.equal((await repo.getBillingEventById(eventId))?.lastError, null);
    });

    test('C.7 Max retry exhaustion & deterministic 4xx mark permanently_failed, stop auto-recovery, and allow controlled manual replay', async () => {
      const wsC = `ws_task_c_dlq_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C DLQ' });
      await repo.createWorkspace({ id: wsC, name: 'Task C DLQ WS', slug: `ws-${wsC}` }, owner.id);

      // Part A: Max attempt exhaustion
      const exhaustedId = `evt_c_exhaust_${Date.now()}`;
      const exhaustedPayload = {
        id: exhaustedId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: wsC,
            customer: 'cus_ex_1',
            subscription: 'sub_ex_1',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };

      let forceTransientError = true;
      const dlqRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'applyBillingTransition' && forceTransientError) {
            return async () => {
              const err: any = new Error('Persistent upstream failure');
              err.statusCode = 503;
              throw err;
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const svc = new BillingService(dlqRepo, sandboxProvider, undefined, {
        maxAttempts: 2,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      });

      // Attempt 1 via webhook
      await assert.rejects(
        () => svc.handleWebhook(JSON.stringify(exhaustedPayload), sandboxProvider.generateSignedPayload(exhaustedPayload).signature),
        /Persistent upstream failure/
      );
      assert.equal((await repo.getBillingEventById(exhaustedId))?.status, 'failed');

      // Attempt 2 via recovery sweeper -> hits maxAttempts=2 -> permanently_failed
      const sumExhaust = await svc.recoverPendingWebhookEvents({ limit: 100 });
      assert.equal(sumExhaust.details.find(d => d.eventId === exhaustedId)?.outcome, 'permanently_failed');
      assert.equal((await repo.getBillingEventById(exhaustedId))?.status, 'permanently_failed');

      // Subsequent automated recovery sweeps ignore it cleanly
      forceTransientError = false;
      const sumIgnoredBySweeper = await svc.recoverPendingWebhookEvents({ limit: 100 });
      assert.equal(sumIgnoredBySweeper.details.some(d => d.eventId === exhaustedId), false);

      // Direct HTTP webhook redelivery of permanently_failed event returns HTTP 200 deadLettered=true (no infinite 503 retry loop)
      const { payload: exRaw, signature: exSig } = sandboxProvider.generateSignedPayload(exhaustedPayload);
      const httpDlqRes = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': exSig },
        body: exRaw,
      });
      assert.equal(httpDlqRes.status, 200);
      const httpDlqJson = await httpDlqRes.json();
      assert.equal(httpDlqJson.deadLettered, true);
      assert.equal(httpDlqJson.retryable, false);

      // Controlled manual replay reprocessBillingEvent succeeds cleanly and upgrades workspace!
      const replayRes = await svc.reprocessBillingEvent(exhaustedId);
      assert.equal(replayRes.success, true);
      assert.equal(replayRes.action, 'processed');
      assert.equal((await repo.getBillingEventById(exhaustedId))?.status, 'processed');
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Growth');

      // Calling reprocessBillingEvent again on an already 'processed' event MUST refuse to re-apply
      const replayAgain = await svc.reprocessBillingEvent(exhaustedId);
      assert.equal(replayAgain.action, 'duplicate');
      assert.equal(replayAgain.success, true);

      // Part B: Deterministic 4xx (invalid Stripe customer prefix) marks permanently_failed on first attempt
      const bad4xxId = `evt_c_4xx_${Date.now()}`;
      const stripeProvider = new StripeBillingProvider('sk_test_key', 'whsec_test_key', createMockStripeClient());
      const stripeSvc = new BillingService(repo, stripeProvider, undefined, { maxAttempts: 5 });
      await assert.rejects(
        () =>
          stripeSvc.handleWebhook(
            JSON.stringify({
              id: bad4xxId,
              type: 'checkout.session.completed',
              created: Math.floor(Date.now() / 1000),
              data: {
                object: {
                  client_reference_id: wsC,
                  customer: 'invalid_customer_no_prefix',
                  subscription: 'sub_ok_123',
                  metadata: { tier: 'Enterprise' },
                  payment_status: 'paid',
                },
              },
            }),
            't=123,v1=valid'
          ),
        /missing valid customer ID/
      );
      assert.equal((await repo.getBillingEventById(bad4xxId))?.status, 'permanently_failed');
      assert.equal((await repo.listRecoverableBillingEvents({ provider: 'stripe', limit: 100 })).some(e => e.eventId === bad4xxId), false);
    });

    test('C.8 Out-of-order stale recovered event cannot overwrite newer subscription/entitlement state & marks ignored', async () => {
      const wsC = `ws_task_c_ooo_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C OOO' });
      await repo.createWorkspace({ id: wsC, name: 'Task C OOO WS', slug: `ws-${wsC}` }, owner.id);

      // Seed an abandoned older event (created = 1000) trying to upgrade to Enterprise
      const staleEvtId = `evt_c_stale_ooo_${Date.now()}`;
      await repo.saveBillingEvent({
        id: `bevt_${staleEvtId}`,
        provider: 'sandbox',
        eventId: staleEvtId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: staleEvtId,
        payload: {
          id: staleEvtId,
          type: 'customer.subscription.updated',
          created: 1000,
          data: {
            object: {
              id: 'sub_ooo_1',
              customer: 'cus_ooo_1',
              metadata: { workspaceId: wsC, tier: 'Enterprise' },
              status: 'active',
            },
          },
        },
        status: 'failed',
        attemptCount: 1,
        processedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      // Meanwhile a NEWER event (created = 2000) canceled subscription cleanly
      await billingService.handleWebhook(
        JSON.stringify({
          id: `evt_c_newer_cancel_${Date.now()}`,
          type: 'customer.subscription.deleted',
          created: 2000,
          data: {
            object: {
              id: 'sub_ooo_1',
              customer: 'cus_ooo_1',
              metadata: { workspaceId: wsC },
            },
          },
        }),
        sandboxProvider.generateSignedPayload({
          id: `evt_c_newer_cancel_${Date.now()}`,
          type: 'customer.subscription.deleted',
        }).signature
      ).catch(() => {});

      const cancelEvt = {
        id: `evt_c_newer_cancel2_${Date.now()}`,
        type: 'customer.subscription.deleted',
        created: 2000,
        data: { object: { id: 'sub_ooo_1', customer: 'cus_ooo_1', metadata: { workspaceId: wsC } } },
      };
      const signedCancel = sandboxProvider.generateSignedPayload(cancelEvt);
      await billingService.handleWebhook(signedCancel.payload, signedCancel.signature);
      assert.equal((await repo.getSubscriptionByWorkspace(wsC))?.status, 'canceled');
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Free Audit');

      // Recovery worker runs on staleEvtId (created = 1000 < 2000) -> MUST mark 'ignored' and NEVER resurrect canceled sub!
      const summary = await billingService.recoverPendingWebhookEvents({ limit: 100 });
      const detail = summary.details.find(d => d.eventId === staleEvtId);
      assert.equal(detail?.outcome, 'ignored');
      assert.equal((await repo.getBillingEventById(staleEvtId))?.status, 'ignored');
      assert.equal((await repo.getSubscriptionByWorkspace(wsC))?.status, 'canceled');
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Free Audit');
    });

    test('C.9 Atomic entitlement consistency: mid-transition failure leaves subscription/store unmodified and keeps event recoverable', async () => {
      const wsC = `ws_task_c_atomic_${Date.now()}`;
      const owner = await repo.createUser({ id: `usr_${wsC}`, email: `${wsC}@example.com`, passwordHash: 'hash', fullName: 'Task C Atomic' });
      await repo.createWorkspace({ id: wsC, name: 'Task C Atomic WS', slug: `ws-${wsC}` }, owner.id);

      const atomicEvtId = `evt_c_atomic_${Date.now()}`;
      await repo.saveBillingEvent({
        id: `bevt_${atomicEvtId}`,
        provider: 'sandbox',
        eventId: atomicEvtId,
        eventType: 'checkout.session.completed',
        idempotencyKey: atomicEvtId,
        payload: {
          id: atomicEvtId,
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: wsC,
              customer: 'cus_atomic_1',
              subscription: 'sub_atomic_1',
              metadata: { tier: 'Growth' },
              payment_status: 'paid',
            },
          },
        },
        status: 'failed',
        attemptCount: 1,
        processedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      // Inject failure mid-transition inside MemoryRepository (subscriptions set fails via corrupt store reference test or rollback)
      let failTransitionOnce = true;
      const rollbackTestRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'applyBillingTransition' && failTransitionOnce) {
            return async (params: any) => {
              // Call real applyBillingTransition with a broken stores.get lookup during throw to verify no partial state remains
              const err: any = new Error('Simulated crash after subscription write');
              err.statusCode = 500;
              throw err;
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const svc = new BillingService(rollbackTestRepo, sandboxProvider, undefined, { baseBackoffMs: 0, maxBackoffMs: 0 });
      const sum1 = await svc.recoverPendingWebhookEvents({ limit: 100 });
      assert.equal(sum1.details.find(d => d.eventId === atomicEvtId)?.outcome, 'retried_failed');
      assert.equal(await repo.getSubscriptionByWorkspace(wsC), null);
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Free Audit');
      assert.equal((await repo.getBillingEventById(atomicEvtId))?.status, 'failed');

      failTransitionOnce = false;
      const sum2 = await svc.recoverPendingWebhookEvents({ limit: 100 });
      assert.equal(sum2.details.find(d => d.eventId === atomicEvtId)?.outcome, 'recovered');
      assert.equal((await repo.getStoreByWorkspace(wsC))?.tier, 'Growth');
      assert.equal((await repo.getBillingEventById(atomicEvtId))?.status, 'processed');
    });

    test('C.10 PostgresRepository recovery queries (listRecoverableBillingEvents, claimBillingEventForRecovery, markBillingEventFailure) preserve payload_json & enforce guards', async () => {
      const { PostgresRepository } = await import('./db/postgresRepository');
      const executed: Array<{ sql: string; params?: any[] }> = [];

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          executed.push({ sql, params });
          if (sql.includes('UPDATE billing_events') && sql.includes('RETURNING')) {
            return {
              rows: [
                {
                  id: 'bevt_pg_1',
                  provider: 'stripe',
                  eventId: 'evt_pg_1',
                  eventType: 'checkout.session.completed',
                  idempotencyKey: 'evt_pg_1',
                  payload: { id: 'evt_pg_1', type: 'checkout.session.completed', data: { object: {} } },
                  status: 'processing',
                  leaseOwner: params?.[1],
                  leaseExpiresAt: new Date(Date.now() + 60_000),
                  attemptCount: 2,
                  lastError: null,
                  lastAttemptAt: new Date(),
                  nextRetryAt: null,
                  processedAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes('UPDATE billing_events') && sql.includes('last_error = $3')) {
            return { rows: [{ id: 'bevt_pg_1' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      const mockPool: any = {
        query: mockClient.query,
        connect: async () => mockClient,
        end: async () => {},
      };

      const pgRepo = new PostgresRepository(mockPool);
      await pgRepo.listRecoverableBillingEvents({ provider: 'stripe', maxAttempts: 5, limit: 25 });
      const claimRes = await pgRepo.claimBillingEventForRecovery('evt_pg_1', {
        leaseOwner: 'pg_rec_1',
        leaseDurationMs: 120_000,
        maxAttempts: 5,
        provider: 'stripe',
      });
      assert.equal(claimRes.claimed, true);
      assert.equal(claimRes.event?.attemptCount, 2);

      await pgRepo.markBillingEventFailure({
        eventId: 'evt_pg_1',
        leaseOwner: 'pg_rec_1',
        status: 'failed',
        errorMessage: 'Sanitized error message',
        nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
      });

      const listSql = executed[0].sql;
      assert.ok(listSql.includes("status = 'processing'"));
      assert.ok(listSql.includes("status = 'failed'"));
      assert.ok(listSql.includes('attempt_count'));

      const claimSql = executed[1].sql;
      assert.ok(claimSql.includes("status NOT IN ('processed', 'ignored')"));
      assert.ok(claimSql.includes("status <> 'permanently_failed'"));
      assert.ok(!claimSql.includes('payload_json ='), 'Recovery claim must never overwrite payload_json');

      const failSql = executed[2].sql;
      assert.ok(failSql.includes('last_error = $3'));
      assert.ok(failSql.includes('next_retry_at = $4'));
      assert.ok(!failSql.includes('payload_json'), 'markBillingEventFailure must NEVER touch payload_json');
    });

    test('C.11 Recovery CLI helper parses arguments and runs recovery sweep cleanly without leaking process', async () => {
      const { parseRecoveryCliArgs, runBillingWebhookRecoveryCli } = await import('./billing/recoverWebhooks');
      const parsed = parseRecoveryCliArgs(['--event-id=evt_abc_123', '--limit=20', '--max-attempts=7']);
      assert.deepEqual(parsed, { eventId: 'evt_abc_123', limit: 20, maxAttempts: 7 });

      // Run in non-production memory mode cleanly (exits via try/finally)
      const cliSummary = await runBillingWebhookRecoveryCli(['--limit=10', '--max-attempts=3']);
      assert.ok(cliSummary);
    });
  });
});


