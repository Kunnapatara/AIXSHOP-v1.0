import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { SandboxBillingProvider, StripeBillingProvider } from './billing/providerAdapter';
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

    test('1.3 Stripe provider creates formatted checkout session when API key is set', async () => {
      const stripeProvider = new StripeBillingProvider('sk_test_mock_stripe_key_123', 'whsec_test');
      const result = await stripeProvider.createCheckoutSession({
        workspaceId: 'ws_stripe_test',
        tier: 'Starter',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });
      assert.ok(result.sessionId.startsWith('cs_'));
      assert.ok(result.checkoutUrl.startsWith('https://checkout.stripe.com/'));
    });

    test('1.4 Stripe provider rejects checkout creation when secret key is missing', async () => {
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

      const { payload, signature } = sandboxProvider.generateSignedPayload(
        eventPayload,
        process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123'
      );

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

      const { payload, signature } = sandboxProvider.generateSignedPayload(
        eventPayload,
        process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123'
      );

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
      const { payload, signature } = sandboxProvider.generateSignedPayload(
        eventPayload,
        process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123'
      );

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
      const { payload, signature } = sandboxProvider.generateSignedPayload(
        eventPayload,
        process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123'
      );

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
      const { payload, signature } = sandboxProvider.generateSignedPayload(
        eventPayload,
        process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123'
      );

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
  });
});
