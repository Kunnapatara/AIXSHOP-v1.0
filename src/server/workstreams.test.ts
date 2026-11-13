import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { encryptCredential } from './security/encryption';
import { fetchProductsPage } from './shopify/client';
import {
  mapShopifyProductNodeToDomain,
  syncShopifyCatalog,
  resumeShopifySync,
} from './shopify/syncService';
import { verifyShopifyWebhookSubscriptionsLive } from './shopify/webhookService';
import {
  evaluateDiscoveryReadiness,
  buildBusinessHubChecklist,
} from '../domain/aiDiscovery/discoveryEngine';
import {
  evaluateFeedReadiness,
  exportToCsv,
  mapProductToGmcRow,
  mapProductToSchemaOrgJsonLd,
} from '../domain/feed/feedValidationEngine';
import { executeCatalogAudit } from '../domain/audit/auditEngine';
import { Product } from '../types';

describe('AIXSHOP v1.0 — Comprehensive Workstream Regression Suite', () => {
  const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_API_KEY = 'test_ws_api_key';
  const TEST_API_SECRET = 'test_ws_api_secret';

  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;
  const originalEnv = { ...process.env };

  before(async () => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.SHOPIFY_API_KEY = TEST_API_KEY;
    process.env.SHOPIFY_API_SECRET = TEST_API_SECRET;

    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.SHOPIFY_APP_URL = baseUrl;
        resolve();
      });
    });
  });

  after(async () => {
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function registerUser(email: string, workspaceName: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        fullName: 'Merchant Admin',
        workspaceName,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    return { token: body.token as string, workspace: body.workspace };
  }

  describe('Workstream A: Shopify Gap Closure Hardening', () => {
    test('incomplete variant pagination (missing cursor while hasNextPage=true) forces partially_completed sync status', async () => {
      const tenant = await registerUser(`ws-a-var-${Date.now()}@test.com`, 'Variant Incomplete Store');
      const nowIso = new Date().toISOString();
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'variant-gap.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_valid'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: {
            products: {
              edges: [
                {
                  cursor: 'p_cur_1',
                  node: {
                    id: 'gid://shopify/Product/9001',
                    title: 'Multi Variant Item',
                    handle: 'multi-variant-item',
                    vendor: 'Test Brand',
                    productType: 'Apparel',
                    description: 'Detailed description for conversational shopping readiness.',
                    status: 'ACTIVE',
                    variants: {
                      edges: [
                        {
                          cursor: 'v_cur_1',
                          node: { id: 'gid://shopify/ProductVariant/1', sku: 'SKU-1', title: 'Small', barcode: '4006381333931', price: '29.00', inventoryQuantity: 5 },
                        },
                      ],
                      // hasNextPage is true, but endCursor is missing!
                      pageInfo: { hasNextPage: true, endCursor: null },
                    },
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/item.jpg' } }] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      });

      const result = await syncShopifyCatalog(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(result.status, 'partially_completed', 'Sync must NEVER be marked completed if variant pagination is incomplete');
      assert.equal(result.syncRun.variantCompletenessStatus, 'incomplete_missing_cursor');
    });

    test('webhook verification paginates across multiple GraphQL pages', async () => {
      const tenant = await registerUser(`ws-a-wh-${Date.now()}@test.com`, 'Paged Webhook Store');
      const nowIso = new Date().toISOString();
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'paged-wh.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_valid'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      let pageCalls = 0;
      const mockFetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        pageCalls++;
        if (!body.variables?.after) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                webhookSubscriptions: {
                  edges: [
                    { node: { id: '1', topic: 'PRODUCTS_CREATE', endpoint: { callbackUrl: `${baseUrl}/api/shopify/webhooks` } } },
                    { node: { id: '2', topic: 'PRODUCTS_UPDATE', endpoint: { callbackUrl: `${baseUrl}/api/shopify/webhooks` } } },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: 'wh_cursor_p2' },
                },
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              webhookSubscriptions: {
                edges: [
                  { node: { id: '3', topic: 'PRODUCTS_DELETE', endpoint: { callbackUrl: `${baseUrl}/api/shopify/webhooks` } } },
                  { node: { id: '4', topic: 'APP_UNINSTALLED', endpoint: { callbackUrl: `${baseUrl}/api/shopify/webhooks` } } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      };

      const verifyRes = await verifyShopifyWebhookSubscriptionsLive(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(pageCalls, 2);
      assert.equal(verifyRes.verified, true);
      assert.equal(verifyRes.status, 'active');
      assert.equal(verifyRes.activeTopics.length, 4);
    });

    test('resumeShopifySync scopes syncRunId to workspace and records parentSyncRunId + attemptNumber', async () => {
      const tenantA = await registerUser(`ws-a-resA-${Date.now()}@test.com`, 'Resume Store A');
      const tenantB = await registerUser(`ws-a-resB-${Date.now()}@test.com`, 'Resume Store B');
      const nowIso = new Date().toISOString();

      await repo.saveShopifyConnection({
        id: `conn_${tenantA.workspace.id}`,
        workspaceId: tenantA.workspace.id,
        shopDomain: 'resume-a.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_valid'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const failedRun = await repo.createShopifySyncRun({
        id: `sync_parent_${Date.now()}`,
        workspaceId: tenantA.workspace.id,
        shopDomain: 'resume-a.myshopify.com',
        status: 'partially_completed',
        productsDiscovered: 1,
        productsImported: 1,
        variantsImported: 1,
        excludedByPlan: 0,
        cursorResumed: 'cur_resume_page_2',
        attemptNumber: 1,
        startedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // Cross-workspace resume must fail cleanly
      await assert.rejects(async () => {
        await resumeShopifySync(repo, tenantB.workspace.id, { syncRunId: failedRun.id });
      }, /No sync run found/i);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: {
            products: {
              edges: [
                {
                  cursor: 'cur_p2_end',
                  node: {
                    id: 'gid://shopify/Product/9902',
                    title: 'Resumed Product',
                    handle: 'resumed-product',
                    vendor: 'Brand A',
                    productType: 'Home',
                    description: 'Detailed genuine product description over sixty characters long.',
                    status: 'ACTIVE',
                    variants: {
                      edges: [
                        { cursor: 'vc1', node: { id: 'gid://shopify/ProductVariant/99021', sku: 'RES-1', title: 'Default', barcode: '4006381333931', price: '45.00', inventoryQuantity: 10 } },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/res.jpg' } }] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      });

      const resumed = await resumeShopifySync(repo, tenantA.workspace.id, {
        syncRunId: failedRun.id,
        customFetch: mockFetch as any,
      });

      assert.equal(resumed.status, 'completed');
      assert.equal(resumed.syncRun.parentSyncRunId, failedRun.id);
      assert.equal(resumed.syncRun.attemptNumber, 2);

      // Verify GET /api/shopify/sync/runs lists lineage
      const runsHttp = await fetch(`${baseUrl}/api/shopify/sync/runs`, {
        headers: { Authorization: `Bearer ${tenantA.token}` },
      });
      assert.equal(runsHttp.status, 200);
      const runsBody = await runsHttp.json();
      assert.ok(Array.isArray(runsBody.syncRuns) && runsBody.syncRuns.length >= 2);
    });

    test('mapShopifyProductNodeToDomain uses verified canonical store domain instead of hardcoded myshopify.com', () => {
      const mapped = mapShopifyProductNodeToDomain(
        {
          id: 'gid://shopify/Product/101',
          title: 'Artisan Kettle',
          handle: 'artisan-kettle',
          vendor: 'Solstice',
          productType: 'Kitchen',
          description: 'Stainless steel kettle.',
          status: 'ACTIVE',
          variants: {
            edges: [{ cursor: 'c1', node: { id: 'gid://shopify/ProductVariant/201', sku: 'KTL-1', title: 'Standard', barcode: '4006381333931', price: '89.00', inventoryQuantity: 3 } }],
          },
          images: { edges: [{ node: { url: 'https://cdn.example.com/kettle.jpg' } }] },
        },
        'USD',
        'shop.solsticegoods.com'
      );

      assert.equal(mapped.offers[0].url, 'https://shop.solsticegoods.com/products/artisan-kettle');
      assert.equal(mapped.attributes.canonicalProductUrl, 'https://shop.solsticegoods.com/products/artisan-kettle');
      assert.equal(mapped.attributes.urlProvenance, 'verified_shopify_store_domain');
    });
  });

  describe('Workstream B & C: AI Discovery, Business Profile, Feed Readiness & Safe Audit', () => {
    const sampleProducts: Product[] = [
      {
        id: 'prod_complete',
        title: 'Solstice Ceramic Pour-Over Dripper',
        brand: 'Solstice Mercantile',
        category: 'Coffee Equipment',
        description: 'Hand-thrown stoneware pour-over coffee dripper engineered for thermal stability and clean extraction.',
        image: 'https://cdn.solsticegoods.com/dripper.jpg',
        status: 'active',
        completenessScore: 95,
        evidenceCoverageScore: 80,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: { material: 'Stoneware', capacity: '400ml', canonicalProductUrl: 'https://shop.solsticegoods.com/products/dripper' },
        variants: [{ id: 'v1', sku: 'SOL-DRIP-1', title: 'Matte Clay', barcode: '4006381333931', price: 42.0, inventoryCount: 12, attributes: {} }],
        offers: [{ id: 'o1', channel: 'Direct Storefront', price: 42.0, currency: 'USD', availability: 'in_stock', condition: 'new', url: 'https://shop.solsticegoods.com/products/dripper', merchantId: 'shopify', lastSync: new Date().toISOString() }],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      },
      {
        id: 'prod_incomplete',
        title: 'Mug',
        brand: '',
        category: '',
        description: '',
        image: '',
        status: 'active',
        completenessScore: 20,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'unindexed',
        attributes: {},
        variants: [{ id: 'v2', sku: '', title: 'Default', barcode: '1234567890123', price: 0, inventoryCount: 0, attributes: {} }],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      },
    ];

    test('evaluateDiscoveryReadiness scores deterministically and flags missing merchant inputs without fabricating data', () => {
      const result = evaluateDiscoveryReadiness(sampleProducts, 'shop.solsticegoods.com');
      assert.equal(result.totalProductsAssessed, 2);
      assert.ok(result.overallScore > 0 && result.overallScore < 100);
      assert.equal(Object.keys(result.dimensions).length, 8);
      assert.ok(result.findings.some((f) => f.productId === 'prod_incomplete' && f.needsMerchantInput === true));
    });

    test('executeCatalogAudit never generates fabricated default prices, descriptions, or 900W specs', () => {
      const audit = executeCatalogAudit(sampleProducts, {
        name: 'Test Store',
        domain: 'shop.solsticegoods.com',
        skuCount: 2,
        tier: 'Growth',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 50,
        truthBoundaryStrictness: 'standard',
      });

      const incompleteActions = audit.actionItems.filter((a) => a.productId === 'prod_incomplete');
      assert.ok(incompleteActions.length > 0);
      for (const act of incompleteActions) {
        assert.equal(act.needsMerchantInput, true, 'Missing field action must require merchant input');
        assert.notEqual(act.proposedChange.to, '0.00');
        assert.ok(!act.proposedChange.to.includes('900W'));
        assert.ok(!act.proposedChange.to.includes('/assets/products/placeholder.jpg'));
      }
    });

    test('feedValidationEngine validates GMC, Meta, Schema.org and exports CSV/JSON accurately', () => {
      const gmcReport = evaluateFeedReadiness(sampleProducts, 'google_merchant_center');
      assert.equal(gmcReport.totalProducts, 2);
      assert.equal(gmcReport.validProductsCount, 1);
      assert.equal(gmcReport.invalidProductsCount, 1);
      assert.equal(gmcReport.readinessScore, 50);

      const csv = exportToCsv([mapProductToGmcRow(sampleProducts[0], 'USD')]);
      assert.ok(csv.includes('Solstice Ceramic Pour-Over Dripper'));
      assert.ok(csv.includes('42.00 USD'));

      const jsonLd = mapProductToSchemaOrgJsonLd(sampleProducts[0], 'USD');
      assert.equal(jsonLd['@type'], 'Product');
      assert.equal(jsonLd.offers.priceCurrency, 'USD');
    });

    test('HTTP endpoints for Business Profile, Discovery Audit, and Feed Export respect workspace isolation', async () => {
      const tenant = await registerUser(`ws-bc-${Date.now()}@test.com`, 'Discovery & Feed Store');
      await repo.saveWorkspaceCatalog(tenant.workspace.id, {
        storeProfile: {
          name: 'Discovery & Feed Store',
          domain: 'shop.discoverytest.com',
          skuCount: 2,
          tier: 'Growth',
          currency: 'USD',
          connectors: [],
          catalogCompletenessAvg: 50,
          truthBoundaryStrictness: 'standard',
        },
        products: sampleProducts,
        variants: sampleProducts.flatMap((p) => p.variants),
        offers: sampleProducts.flatMap((p) => p.offers),
        findings: [],
        actions: [],
        evidence: [],
      });

      // Update business profile
      const putRes = await fetch(`${baseUrl}/api/business-profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tenant.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          legalBusinessName: 'Discovery Goods LLC',
          publicBrandName: 'Discovery Goods',
          officialWebsite: 'https://shop.discoverytest.com',
          contactEmail: 'support@discoverytest.com',
          privacyPolicyUrl: 'https://shop.discoverytest.com/privacy',
          returnPolicyUrl: 'https://shop.discoverytest.com/returns',
          shippingPolicyUrl: 'https://shop.discoverytest.com/shipping',
          verificationStatus: 'merchant_verified',
        }),
      });
      assert.equal(putRes.status, 200);
      const putData = await putRes.json();
      assert.equal(putData.profile.legalBusinessName, 'Discovery Goods LLC');

      // Audit discovery endpoint
      const discRes = await fetch(`${baseUrl}/api/discovery/audit`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(discRes.status, 200);
      const discData = await discRes.json();
      assert.equal(discData.readiness.totalProductsAssessed, 2);
      assert.ok(discData.hubChecklist.overallReadinessScore >= 70);

      // Export valid-only GMC CSV
      const expRes = await fetch(`${baseUrl}/api/feed/export?platform=google_merchant_center&filter=valid_only`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(expRes.status, 200);
      const csvText = await expRes.text();
      assert.ok(csvText.includes('prod_complete'));
      assert.ok(!csvText.includes('prod_incomplete'));
    });
  });

  describe('Workstream D & E: AI Visibility Monitoring & Billing Stale Claim Recovery', () => {
    test('visibility summary starts disconnected and deduplicates ingested CSV analytics', async () => {
      const tenant = await registerUser(`ws-d-vis-${Date.now()}@test.com`, 'Visibility Test Store');

      const emptyRes = await fetch(`${baseUrl}/api/visibility/summary`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(emptyRes.status, 200);
      const emptyData = await emptyRes.json();
      assert.equal(emptyData.summary.connected, false);
      assert.equal(emptyData.summary.status, 'DATA_SOURCE_NOT_CONNECTED');

      const csvContent = [
        'date,platform,brand_mentions,product_mentions,website_clicks,topic',
        '2026-11-05,ChatGPT Search,10,20,5,ceramic pour over',
        '2026-11-05,ChatGPT Search,2,3,1,ceramic pour over', // duplicate date+platform+topic should aggregate within same CSV
        '2026-11-06,Perplexity Shopping,4,8,2,linen apron',
      ].join('\n');

      const uploadRes = await fetch(`${baseUrl}/api/visibility/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenant.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ csvContent, filename: 'nov_metrics.csv' }),
      });
      assert.equal(uploadRes.status, 200);
      const uploadData = await uploadRes.json();
      assert.equal(uploadData.summary.connected, true);
      assert.equal(uploadData.summary.totalBrandMentions, 16);
      assert.equal(uploadData.summary.totalProductMentions, 31);
      assert.equal(uploadData.summary.totalWebsiteClicks, 8);
      assert.equal(uploadData.summary.recentObservations.length, 2);
    });

    test('claimBillingEvent recovers stale processing locks older than 5 minutes', async () => {
      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      await repo.saveBillingEvent({
        id: 'bevt_stale_1',
        provider: 'stripe',
        eventId: 'evt_stale_1',
        eventType: 'checkout.session.completed',
        idempotencyKey: 'evt_stale_1',
        payload: {},
        status: 'processing',
        processedAt: staleTime,
      });

      const claim = await repo.claimBillingEvent({
        id: 'bevt_stale_1',
        provider: 'stripe',
        eventId: 'evt_stale_1',
        eventType: 'checkout.session.completed',
        idempotencyKey: 'evt_stale_1',
        payload: {},
        status: 'processing',
        processedAt: new Date().toISOString(),
      });

      assert.equal(claim.claimed, true, 'Stale billing event stuck in processing > 5m must be reclaimable');
    });
  });
});
