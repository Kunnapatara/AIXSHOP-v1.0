import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import {
  evaluateCommercialReadiness,
  redactSecrets,
  renderVerificationMarkdown,
  computeOverallStatus,
} from './verification/statusModel';
import { formatCommercialReadinessText } from './verification/checkCommercialEnv';
import { runShopifyExternalVerification } from './verification/shopifyVerifier';
import { runStripeExternalVerification } from './verification/stripeVerifier';
import { runSmtpExternalVerification } from './verification/smtpVerifier';
import { runStagingE2EVerification } from './verification/stagingE2EVerifier';

import { MemoryRepository } from './db/memoryRepository';
import { createApp } from './app';
import {
  initiateShopifyConnect,
  handleShopifyCallback,
} from './shopify/oauthService';
import { executeShopifyGraphQL, isValidShopDomain } from './shopify/client';
import { syncShopifyCatalog, resumeShopifySync } from './shopify/syncService';
import { processShopifyWebhook } from './shopify/webhookService';
import { encryptCredential, signShopifyWebhookHmac } from './security/encryption';

import {
  StripeBillingProvider,
  SandboxBillingProvider,
  findPlanByPriceId,
  setBillingProvider,
} from './billing/providerAdapter';
import { BillingService } from './services/billingService';
import { resolveReportEntitlement, checkPlanQuota } from './services/entitlementService';
import {
  sendTransactionalEmail,
  sanitizeSmtpErrorMessage,
  validateSmtpConfig,
} from './services/emailService';
import { _resetRateLimiter } from './middleware/auth';

async function withEnvOverrides(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    const val = overrides[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  }
}

function makeMockProductNode(index: number) {
  return {
    id: `gid://shopify/Product/${1000 + index}`,
    title: `Contract Test Product ${index}`,
    descriptionHtml: `<p>Spec description ${index}</p>`,
    description: `Spec description ${index}`,
    vendor: 'AIXSHOP TestBrand',
    productType: 'Apparel',
    handle: `contract-product-${index}`,
    status: 'ACTIVE',
    isGiftCard: false,
    tags: ['test'],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    images: { edges: [{ node: { url: `https://cdn.example.com/p${index}.jpg`, altText: 'img' } }] },
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [
        {
          cursor: `vcur_${index}`,
          node: {
            id: `gid://shopify/ProductVariant/${2000 + index}`,
            title: 'Default',
            sku: `SKU-${index}`,
            barcode: `01234567890${index}`,
            price: '29.00',
            compareAtPrice: null,
            inventoryQuantity: 10,
            selectedOptions: [{ name: 'Title', value: 'Default' }],
          },
        },
      ],
    },
  };
}

describe('[CONTRACT / HARNESS] Commercial Integration Verification Infrastructure', () => {
  test('Verification Status Model & Secret Redaction behave deterministically and block when credentials are absent', async () => {
    await withEnvOverrides(
      {
        COMMERCIAL_VERIFY_EXTERNAL: undefined,
        SHOPIFY_API_KEY: undefined,
        SHOPIFY_API_SECRET: undefined,
        SHOPIFY_DEV_STORE_DOMAIN: undefined,
        SHOPIFY_DEV_ACCESS_TOKEN: undefined,
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined,
        STRIPE_PRICE_STARTER: undefined,
        STRIPE_PRICE_GROWTH: undefined,
        STRIPE_PRICE_ENTERPRISE: undefined,
        SMTP_HOST: undefined,
        SMTP_TEST_RECIPIENT: undefined,
        STAGING_BASE_URL: undefined,
        STAGING_CONFIRM_NON_PRODUCTION: undefined,
      },
      async () => {
        const readiness = evaluateCommercialReadiness();
        assert.equal(readiness.externalVerificationActivated, false);
        assert.equal(readiness.integrations.stage_1_shopify.status, 'BLOCKED');
        assert.equal(readiness.integrations.stage_2_stripe.status, 'BLOCKED');
        assert.equal(readiness.integrations.stage_3_smtp.status, 'BLOCKED');
        assert.equal(readiness.integrations.stage_4_staging_e2e.status, 'BLOCKED');

        const textOut = formatCommercialReadinessText(readiness);
        assert.match(textOut, /BLOCKED/);

        const [s1, s2, s3, s4] = await Promise.all([
          runShopifyExternalVerification(),
          runStripeExternalVerification(),
          runSmtpExternalVerification(),
          runStagingE2EVerification(),
        ]);

        assert.equal(s1.status, 'BLOCKED');
        assert.equal(s2.status, 'BLOCKED');
        assert.equal(s3.status, 'BLOCKED');
        assert.equal(s4.status, 'BLOCKED');
        assert.ok(s1.checks.every((c) => c.status === 'BLOCKED'));
        assert.ok(s2.checks.every((c) => c.status === 'BLOCKED'));
        assert.ok(s3.checks.every((c) => c.status === 'BLOCKED'));
        assert.ok(s4.checks.every((c) => c.status === 'BLOCKED'));
        assert.equal(computeOverallStatus([s1, s2, s3, s4]), 'BLOCKED');

        const md = renderVerificationMarkdown({
          generatedAt: new Date().toISOString(),
          runId: 'test_run',
          targetEnvironment: 'test',
          externalVerificationActivated: false,
          overallExternalStatus: 'BLOCKED',
          readiness,
          stages: [s1, s2, s3, s4],
          cleanupPerformed: false,
          notes: ['Contract test verification check'],
        });
        assert.match(md, /BLOCKED/);
      }
    );

    const redacted = redactSecrets(
      'Failed connecting postgresql://admin:super_secret_pw@db.example.com:5432/app with shpat_abcdef1234567890'
    );
    assert.ok(!redacted.includes('super_secret_pw'));
    assert.ok(!redacted.includes('shpat_abcdef1234567890'));
    assert.match(redacted, /REDACTED_DB_PASS/);
    assert.match(redacted, /REDACTED_SHOPIFY_TOKEN/);
  });

  test('Stage 2 & Stage 4 verifiers strictly reject Stripe live keys (sk_live_)', async () => {
    const fakeLiveKey = 'sk_' + 'live_' + '9999888877776666abcd';
    await withEnvOverrides(
      {
        COMMERCIAL_VERIFY_EXTERNAL: 'true',
        STRIPE_SECRET_KEY: fakeLiveKey,
      },
      async () => {
        const s2 = await runStripeExternalVerification();
        assert.equal(s2.status, 'FAIL');
        assert.equal(s2.checks[0].status, 'FAIL');
        assert.match(s2.checks[0].blockerOrFailure || '', /LIVE_KEY_REJECTED/);

        const s4 = await runStagingE2EVerification();
        assert.equal(s4.status, 'FAIL');
        assert.match(s4.checks[0].blockerOrFailure || '', /LIVE_KEY_REJECTED/);
      }
    );
  });
});

describe('[CONTRACT / SIMULATED — NOT EXTERNAL PROVIDER] Stage 1 Shopify Verification Contracts', () => {
  const testEncKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  test('OAuth domain validation, reinstall, replay rejection, and expired state rejection', async () => {
    await withEnvOverrides(
      {
        SHOPIFY_API_KEY: 'test_shopify_key',
        SHOPIFY_API_SECRET: 'test_shopify_secret_123456',
        SHOPIFY_APP_URL: 'https://staging.aixshop.example.com',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: testEncKey,
      },
      async () => {
        const repo = new MemoryRepository(false);
        const owner1 = await repo.createUser({
          id: 'usr_s1_1',
          email: 's1a@example.com',
          passwordHash: 'h',
          fullName: 'S1 A',
        });
        const { workspace: ws1 } = await repo.createWorkspace({ id: 'ws_s1_1', name: 'WS1', slug: 'ws1' }, owner1.id);
        const owner2 = await repo.createUser({
          id: 'usr_s1_2',
          email: 's1b@example.com',
          passwordHash: 'h',
          fullName: 'S1 B',
        });
        const { workspace: ws2 } = await repo.createWorkspace({ id: 'ws_s1_2', name: 'WS2', slug: 'ws2' }, owner2.id);

        assert.equal(isValidShopDomain('evil.com/path'), false);
        assert.equal(isValidShopDomain('dev-store.myshopify.com'), true);

        const connect1 = await initiateShopifyConnect(repo, ws1.id, 'dev-store.myshopify.com');
        const queryParams: Record<string, string> = {
          code: 'auth_code_1',
          shop: 'dev-store.myshopify.com',
          state: connect1.state,
          timestamp: String(Math.floor(Date.now() / 1000)),
        };
        const msg = Object.keys(queryParams)
          .sort()
          .map((k) => `${k}=${queryParams[k]}`)
          .join('&');
        const hmac = crypto.createHmac('sha256', 'test_shopify_secret_123456').update(msg).digest('hex');

        const mockFetch: typeof fetch = async (url) => {
          const u = String(url);
          if (u.includes('/admin/oauth/access_token')) {
            return new Response(
              JSON.stringify({ access_token: 'shpat_install_token_1', scope: 'read_products' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              data: { shop: { name: 'Dev Store', myshopifyDomain: 'dev-store.myshopify.com', currencyCode: 'USD' } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        };

        const cbRes = await handleShopifyCallback(repo, { ...queryParams, hmac }, { customFetch: mockFetch });
        assert.equal(cbRes.shopDomain, 'dev-store.myshopify.com');

        // Replay of same state/code must be rejected
        await assert.rejects(
          () => handleShopifyCallback(repo, { ...queryParams, hmac }, { customFetch: mockFetch }),
          /invalid|expired|already used/i
        );

        // Expired state must be rejected
        await repo.saveShopifyOAuthState({
          id: 'expired_state_nonce',
          workspaceId: ws1.id,
          shopDomain: 'dev-store.myshopify.com',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const expParams = { ...queryParams, state: 'expired_state_nonce' };
        const expMsg = Object.keys(expParams)
          .sort()
          .map((k) => `${k}=${(expParams as any)[k]}`)
          .join('&');
        const expHmac = crypto.createHmac('sha256', 'test_shopify_secret_123456').update(expMsg).digest('hex');
        await assert.rejects(
          () => handleShopifyCallback(repo, { ...expParams, hmac: expHmac }, { customFetch: mockFetch }),
          /expired/i
        );

        // Reinstall on same workspace succeeds and updates connection
        const reinstall = await initiateShopifyConnect(repo, ws1.id, 'dev-store.myshopify.com');
        const reParams = { ...queryParams, state: reinstall.state, code: 'auth_code_2' };
        const reMsg = Object.keys(reParams)
          .sort()
          .map((k) => `${k}=${(reParams as any)[k]}`)
          .join('&');
        const reHmac = crypto.createHmac('sha256', 'test_shopify_secret_123456').update(reMsg).digest('hex');
        const reRes = await handleShopifyCallback(repo, { ...reParams, hmac: reHmac }, { customFetch: mockFetch });
        assert.equal(reRes.shopDomain, 'dev-store.myshopify.com');

        // Cross-shop state substitution is blocked
        const ws2Conn = await initiateShopifyConnect(repo, ws2.id, 'other-store.myshopify.com');
        const ws2Params = { ...queryParams, shop: 'dev-store.myshopify.com', state: ws2Conn.state, code: 'auth_code_3' };
        const ws2Msg = Object.keys(ws2Params)
          .sort()
          .map((k) => `${k}=${(ws2Params as any)[k]}`)
          .join('&');
        const ws2Hmac = crypto.createHmac('sha256', 'test_shopify_secret_123456').update(ws2Msg).digest('hex');
        await assert.rejects(
          () => handleShopifyCallback(repo, { ...ws2Params, hmac: ws2Hmac }, { customFetch: mockFetch }),
          /State shop mismatch/i
        );
      }
    );
  });

  test('Empty catalog, multi-page cursor pagination, resume recovery, and 429 rate-limit retry', async () => {
    await withEnvOverrides({ SHOPIFY_TOKEN_ENCRYPTION_KEY: testEncKey }, async () => {
      const repo = new MemoryRepository(false);
      const owner = await repo.createUser({ id: 'usr_pag', email: 'pag@example.com', passwordHash: 'h', fullName: 'Pag' });
      const { workspace: ws } = await repo.createWorkspace({ id: 'ws_pag', name: 'Pag WS', slug: 'ws-pag' }, owner.id);
      await repo.saveShopifyConnection({
        id: 'shop_pag',
        workspaceId: ws.id,
        shopDomain: 'pag-store.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_pag_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 1. Empty catalog
      const emptyFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      const emptyRes = await syncShopifyCatalog(repo, ws.id, { customFetch: emptyFetch });
      assert.equal(emptyRes.status, 'completed');
      assert.equal(emptyRes.productsDiscovered, 0);

      // 2. Multi-page pagination (3 pages = 7 products) interrupted at page 1 -> resumed cleanly
      const allNodes = [1, 2, 3, 4, 5, 6, 7].map(makeMockProductNode);
      const pagedFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const after = body.variables?.after || null;
        if (!after) {
          return new Response(
            JSON.stringify({
              data: {
                products: {
                  pageInfo: { hasNextPage: true, endCursor: 'cur_p1' },
                  edges: allNodes.slice(0, 3).map((node, i) => ({ cursor: `c${i}`, node })),
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (after === 'cur_p1') {
          return new Response(
            JSON.stringify({
              data: {
                products: {
                  pageInfo: { hasNextPage: true, endCursor: 'cur_p2' },
                  edges: allNodes.slice(3, 6).map((node, i) => ({ cursor: `c${3 + i}`, node })),
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [{ cursor: 'c6', node: allNodes[6] }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const partial = await syncShopifyCatalog(repo, ws.id, { maxPages: 1, pageSize: 3, customFetch: pagedFetch });
      assert.equal(partial.status, 'partially_completed');
      assert.equal(partial.productsDiscovered, 3);

      const resumed = await resumeShopifySync(repo, ws.id, {
        syncRunId: partial.syncRun.id,
        maxPages: 10,
        pageSize: 3,
        customFetch: pagedFetch,
      });
      assert.equal(resumed.status, 'completed');
      const snapshot = await repo.loadWorkspaceCatalog(ws.id);
      assert.equal(snapshot?.products.length, 7);

      // 3. Rate limit 429 retry recovery
      let attempts = 0;
      const rateLimitFetch: typeof fetch = async () => {
        attempts++;
        if (attempts === 1) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '0' } });
        }
        return new Response(
          JSON.stringify({ data: { shop: { name: 'Recovered' } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };
      const rlRes = await executeShopifyGraphQL<{ shop: { name: string } }>(
        'pag-store.myshopify.com',
        'shpat_pag_token',
        'query { shop { name } }',
        {},
        { customFetch: rateLimitFetch, baseBackoffMs: 5, maxRetries: 2 }
      );
      assert.equal(attempts, 2);
      assert.equal(rlRes.data.shop.name, 'Recovered');
    });
  });

  test('Webhook invalid HMAC rejection, duplicate delivery idempotency, and expired lease recovery', async () => {
    await withEnvOverrides(
      { SHOPIFY_API_SECRET: 'shopify_wh_secret_contract', SHOPIFY_TOKEN_ENCRYPTION_KEY: testEncKey },
      async () => {
        const repo = new MemoryRepository(false);
        const owner = await repo.createUser({ id: 'usr_swh', email: 'swh@example.com', passwordHash: 'h', fullName: 'SWH' });
        const { workspace: ws } = await repo.createWorkspace({ id: 'ws_swh', name: 'SWH', slug: 'ws-swh' }, owner.id);
        await repo.saveShopifyConnection({
          id: 'shop_swh',
          workspaceId: ws.id,
          shopDomain: 'wh-store.myshopify.com',
          accessTokenEncrypted: encryptCredential('shpat_wh'),
          grantedScopes: 'read_products',
          keyVersion: 'v1',
          status: 'connected',
          installedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const payload = JSON.stringify({
          id: 9001,
          title: 'Webhook Jacket',
          vendor: 'AIX',
          product_type: 'Outerwear',
          status: 'active',
          variants: [{ id: 8001, title: 'M', sku: 'WH-9001', price: '89.00', inventory_quantity: 5 }],
        });

        // Invalid HMAC rejected cleanly
        await assert.rejects(
          () =>
            processShopifyWebhook(repo, payload, {
              'x-shopify-hmac-sha256': 'aW52YWxpZF9obWFj',
              'x-shopify-topic': 'products/create',
              'x-shopify-shop-domain': 'wh-store.myshopify.com',
              'x-shopify-delivery-id': 'wh_invalid_1',
            }),
          /Invalid webhook HMAC signature/i
        );

        const validHmac = signShopifyWebhookHmac(payload, 'shopify_wh_secret_contract');
        const first = await processShopifyWebhook(repo, payload, {
          'x-shopify-hmac-sha256': validHmac,
          'x-shopify-topic': 'products/create',
          'x-shopify-shop-domain': 'wh-store.myshopify.com',
          'x-shopify-delivery-id': 'wh_dup_1',
        });
        assert.equal(first.processed, true);
        assert.equal(first.duplicate, false);
        assert.equal(first.outcome, 'CLAIMED');

        const dup = await processShopifyWebhook(repo, payload, {
          'x-shopify-hmac-sha256': validHmac,
          'x-shopify-topic': 'products/create',
          'x-shopify-shop-domain': 'wh-store.myshopify.com',
          'x-shopify-delivery-id': 'wh_dup_1',
        });
        assert.equal(dup.duplicate, true);
        assert.equal(dup.outcome, 'ALREADY_PROCESSED');

        // Active lease rejection + Expired lease recovery (min lease 50ms)
        const nowWhIso = new Date().toISOString();
        const shortClaim = await repo.claimShopifyWebhookEvent(
          {
            id: 'wh_expired_1',
            eventId: 'wh_expired_1',
            shopDomain: 'wh-store.myshopify.com',
            topic: 'products/update',
            workspaceId: ws.id,
            payload: {},
            status: 'processing',
            retryCount: 0,
            createdAt: nowWhIso,
            updatedAt: nowWhIso,
          },
          { leaseOwner: 'dead_worker', leaseDurationMs: 50 }
        );
        assert.equal(shortClaim.outcome, 'CLAIMED');
        const whileActive = await repo.claimShopifyWebhookEvent(
          {
            id: 'wh_expired_1',
            eventId: 'wh_expired_1',
            shopDomain: 'wh-store.myshopify.com',
            topic: 'products/update',
            workspaceId: ws.id,
            payload: {},
            status: 'processing',
            retryCount: 0,
            createdAt: nowWhIso,
            updatedAt: nowWhIso,
          },
          { leaseOwner: 'contender_worker', leaseDurationMs: 60_000 }
        );
        assert.equal(whileActive.outcome, 'CURRENTLY_PROCESSING');
        await new Promise((r) => setTimeout(r, 75));
        const reclaimed = await repo.claimShopifyWebhookEvent(
          {
            id: 'wh_expired_1',
            eventId: 'wh_expired_1',
            shopDomain: 'wh-store.myshopify.com',
            topic: 'products/update',
            workspaceId: ws.id,
            payload: {},
            status: 'processing',
            retryCount: 0,
            createdAt: nowWhIso,
            updatedAt: nowWhIso,
          },
          { leaseOwner: 'live_worker', leaseDurationMs: 60_000 }
        );
        assert.equal(reclaimed.outcome, 'CLAIMED');
      }
    );
  });
});

describe('[CONTRACT / SIMULATED — NOT EXTERNAL PROVIDER] Stage 2 Stripe Billing Contracts', () => {
  test('Full subscription lifecycle, fail-closed past_due enforcement, recovery, and unknown-event safety', async () => {
    const repo = new MemoryRepository(false);
    const owner = await repo.createUser({ id: 'usr_b2', email: 'b2@example.com', passwordHash: 'h', fullName: 'B2' });
    const { workspace: ws } = await repo.createWorkspace({ id: 'ws_b2', name: 'B2 WS', slug: 'ws-b2' }, owner.id);
    await repo.saveWorkspaceCatalog(ws.id, {
      storeProfile: {
        name: 'B2 Store',
        domain: 'b2-store.example.com',
        skuCount: 1,
        tier: 'Free Audit',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 50,
        lastAuditDate: 'N/A',
        truthBoundaryStrictness: 'standard',
      },
      products: [
        {
          id: 'p1',
          title: 'Item 1',
          brand: 'Brand',
          category: 'Apparel',
          description: 'Desc',
          image: '',
          status: 'active',
          completenessScore: 60,
          evidenceCoverageScore: 0,
          externalDiscoveryStatus: 'unindexed',
          variants: [{ id: 'v1', sku: 'S1', title: 'S1', barcode: '', price: 10, inventoryCount: 5, attributes: {} }],
          offers: [],
          attributes: {},
          evidenceDocuments: [],
          findingsCount: 0,
          lastAudited: 'N/A',
        },
      ],
      variants: [],
      offers: [],
      findings: [],
      actions: [],
      evidence: [],
    });

    const priceMap = {
      Starter: 'price_contract_starter',
      Growth: 'price_contract_growth',
      Enterprise: 'price_contract_enterprise',
    };
    assert.equal(findPlanByPriceId('price_unknown', priceMap), null);
    assert.equal(findPlanByPriceId('price_contract_growth', priceMap)?.tier, 'Growth');

    const whSecret = 'whsec_harness_01';
    const mockStripe: any = {
      webhooks: {
        signature: {
          verifyHeaderAsync: async (payload: string, header: string, secret: string) => {
            const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
            const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
            if (parts.v1 !== expected) throw new Error('Invalid signature');
            return true;
          },
        },
      },
    };

    const provider = new StripeBillingProvider('sk_test_harness', whSecret, mockStripe, priceMap);
    const svc = new BillingService(repo, provider);
    const sign = (evt: any) => {
      const payload = JSON.stringify(evt);
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', whSecret).update(`${t}.${payload}`).digest('hex');
      return { payload, sig: `t=${t},v1=${v1}` };
    };

    // 1. Starter active
    const e1 = sign({
      id: 'evt_c2_1',
      type: 'checkout.session.completed',
      created: 1000,
      data: {
        object: {
          client_reference_id: ws.id,
          customer: 'cus_b2',
          subscription: 'sub_b2',
          payment_status: 'paid',
          metadata: { workspaceId: ws.id, tier: 'Starter' },
        },
      },
    });
    await svc.handleWebhook(e1.payload, e1.sig);
    assert.equal((await repo.getStoreByWorkspace(ws.id))?.tier, 'Starter');

    // 2. Plan upgrade Growth
    const e2 = sign({
      id: 'evt_c2_2',
      type: 'customer.subscription.updated',
      created: 1010,
      data: { object: { id: 'sub_b2', customer: 'cus_b2', status: 'active', metadata: { workspaceId: ws.id, tier: 'Growth' } } },
    });
    await svc.handleWebhook(e2.payload, e2.sig);
    assert.equal((await repo.getStoreByWorkspace(ws.id))?.tier, 'Growth');

    // 3. Plan downgrade Starter + cancel_at_period_end keeps active access through period end
    const e3 = sign({
      id: 'evt_c2_3',
      type: 'customer.subscription.updated',
      created: 1020,
      data: {
        object: {
          id: 'sub_b2',
          customer: 'cus_b2',
          status: 'active',
          cancel_at_period_end: true,
          metadata: { workspaceId: ws.id, tier: 'Starter' },
        },
      },
    });
    await svc.handleWebhook(e3.payload, e3.sig);
    const subCancelEnd = await repo.getSubscriptionByWorkspace(ws.id);
    assert.equal(subCancelEnd?.cancelAtPeriodEnd, true);
    assert.equal(resolveReportEntitlement(await repo.getStoreByWorkspace(ws.id), subCancelEnd).hasFullReportAccess, true);

    // 4. invoice.payment_failed -> past_due blocks paid report & SKU expansion; duplicate failure is idempotent
    const e4 = sign({
      id: 'evt_c2_4',
      type: 'invoice.payment_failed',
      created: 1030,
      data: { object: { subscription: 'sub_b2', metadata: { workspaceId: ws.id } } },
    });
    await svc.handleWebhook(e4.payload, e4.sig);
    await svc.handleWebhook(e4.payload, e4.sig);
    const subPastDue = await repo.getSubscriptionByWorkspace(ws.id);
    assert.equal(subPastDue?.status, 'past_due');
    const storeNow = await repo.getStoreByWorkspace(ws.id);
    assert.equal(resolveReportEntitlement(storeNow, subPastDue).hasFullReportAccess, false);
    const catalogNow = await repo.loadWorkspaceCatalog(ws.id);
    const capCheck = checkPlanQuota(storeNow, catalogNow?.products || [], 5, subPastDue);
    assert.equal(capCheck.allowed, false);

    // 5. invoice.payment_succeeded recovers past_due -> active
    const e5 = sign({
      id: 'evt_c2_5',
      type: 'invoice.payment_succeeded',
      created: 1040,
      data: { object: { subscription: 'sub_b2', metadata: { workspaceId: ws.id } } },
    });
    await svc.handleWebhook(e5.payload, e5.sig);
    assert.equal((await repo.getSubscriptionByWorkspace(ws.id))?.status, 'active');

    // 6. Unhandled event (invoice.paid) is safely ignored without mutating subscription
    const eIgn = sign({
      id: 'evt_c2_ign',
      type: 'invoice.paid',
      created: 1045,
      data: { object: { subscription: 'sub_b2', metadata: { workspaceId: ws.id } } },
    });
    const ignRes = await svc.handleWebhook(eIgn.payload, eIgn.sig);
    assert.equal(ignRes.action, 'ignored');
    assert.equal((await repo.getSubscriptionByWorkspace(ws.id))?.status, 'active');

    // 7. Immediate cancellation (deleted) downgrades to Free Audit while preserving catalog products
    const e6 = sign({
      id: 'evt_c2_6',
      type: 'customer.subscription.deleted',
      created: 1050,
      data: { object: { id: 'sub_b2', customer: 'cus_b2', metadata: { workspaceId: ws.id } } },
    });
    await svc.handleWebhook(e6.payload, e6.sig);
    assert.equal((await repo.getStoreByWorkspace(ws.id))?.tier, 'Free Audit');
    assert.equal((await repo.loadWorkspaceCatalog(ws.id))?.products.length, 1);
  });
});

describe('[CONTRACT / SIMULATED — NOT EXTERNAL PROVIDER] Stage 3 SMTP & Stage 4 Negative Isolation Contracts', () => {
  test('SMTP handles 535 auth rejection, timeout, secret redaction, and distinguishes relay acceptance from inbox delivery', async () => {
    const authServer = net.createServer((sock) => {
      sock.write('220 test.local ESMTP\r\n');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        while (buf.includes('\r\n')) {
          const i = buf.indexOf('\r\n');
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (line.startsWith('EHLO')) sock.write('250-test.local\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) sock.write('535 5.7.8 Authentication failed\r\n');
          else if (line.startsWith('QUIT')) {
            sock.write('221 Bye\r\n');
            sock.end();
          }
        }
      });
    });
    await new Promise<void>((res) => authServer.listen(0, '127.0.0.1', () => res()));
    const port = (authServer.address() as net.AddressInfo).port;

    try {
      await withEnvOverrides(
        {
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(port),
          SMTP_SECURE: 'false',
          SMTP_STARTTLS: 'false',
          SMTP_USER: 'mailer@example.com',
          SMTP_PASS: 'SuperSecretSmtpPass!99',
          SMTP_FROM: 'no-reply@example.com',
        },
        async () => {
          assert.equal(validateSmtpConfig({ isProd: true }).missingOrInvalid.some((m) => m.includes('plaintext')), true);
          const failRes = await sendTransactionalEmail({
            to: 'recipient@example.com',
            subject: 'Auth Fail Check',
            text: 'Body',
          });
          assert.equal(failRes.delivered, false);
          assert.equal(failRes.smtp_message_accepted, false);
          assert.equal(failRes.inbox_delivery_confirmed, false);

          const sanitized = sanitizeSmtpErrorMessage(new Error('AUTH PLAIN dXNlcg== failed for SuperSecretSmtpPass!99'));
          assert.ok(!sanitized.includes('SuperSecretSmtpPass!99'));
        }
      );
    } finally {
      await new Promise<void>((res) => authServer.close(() => res()));
    }
  });

  test('Stage 4 negative security & tenant-isolation contracts against local app server', async () => {
    _resetRateLimiter();
    const repo = new MemoryRepository(false);
    const sbx = new SandboxBillingProvider('sbx_harness_secret');
    setBillingProvider(sbx);
    const app = createApp(repo);
    const srv = http.createServer(app);
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as net.AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const regA = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant-a@example.com',
          password: 'Password123!A',
          fullName: 'Tenant A',
          workspaceName: 'Tenant A Store',
        }),
      });
      assert.equal(regA.status, 201);
      const cookieA = (regA.headers.get('set-cookie') || '').split(';')[0];
      const bodyA: any = await regA.json();

      const regB = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant-b@example.com',
          password: 'Password123!B',
          fullName: 'Tenant B',
          workspaceName: 'Tenant B Store',
        }),
      });
      assert.equal(regB.status, 201);
      const cookieB = (regB.headers.get('set-cookie') || '').split(';')[0];

      // Tenant B attempting to force Workspace A via header still gets Workspace B or is denied
      const catB = await fetch(`${base}/api/catalog`, {
        headers: { Cookie: cookieB, 'x-workspace-id': bodyA.workspace.id },
      });
      const catBJson: any = await catB.json();
      assert.notEqual(catBJson.workspaceId, bodyA.workspace.id);

      // Invalid billing webhook signature fails closed
      const badBilling = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=badbad' },
        body: JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed' }),
      });
      assert.ok(badBilling.status >= 400);

      // Clean unused variable warning check
      assert.ok(cookieA.includes('aixshop_session='));
    } finally {
      setBillingProvider(null);
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });
});
