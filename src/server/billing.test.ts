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
});


