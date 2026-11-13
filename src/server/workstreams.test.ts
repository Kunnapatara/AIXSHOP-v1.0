import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
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
  mapProductToMetaRow,
  mapProductToSchemaOrgJsonLd,
} from '../domain/feed/feedValidationEngine';
import { executeCatalogAudit } from '../domain/audit/auditEngine';
import { recordIndependentBusinessVerification } from './routes/businessProfileRoutes';
import { BillingService } from './services/billingService';
import { SandboxBillingProvider } from './billing/providerAdapter';
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
      assert.equal(jsonLd.offers?.priceCurrency, 'USD');
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

    test('billing lease renewal, stale worker ownership rejection, and full vs partial charge.refunded', async () => {
      const tenant = await registerUser(`ws-e-lease-${Date.now()}@test.com`, 'Billing Lease Store');
      const wsId = tenant.workspace.id;
      const sandbox = new SandboxBillingProvider('whsec_lease_test_secret_123');
      const billingService = new BillingService(repo, sandbox);

      // Seed active Growth subscription and 1 catalog product
      await repo.saveStoreProfile(wsId, {
        name: 'Billing Lease Store',
        domain: 'lease-store.myshopify.com',
        currency: 'USD',
        skuCount: 1,
        skuLimit: 2500,
        tier: 'Growth',
        connectors: [],
        catalogCompletenessAvg: 90,
        truthBoundaryStrictness: 'standard',
      });
      await repo.saveWorkspaceCatalog(wsId, {
        storeProfile: {
          name: 'Billing Lease Store',
          domain: 'lease-store.myshopify.com',
          currency: 'USD',
          skuCount: 1,
          skuLimit: 2500,
          tier: 'Growth',
          connectors: [],
          catalogCompletenessAvg: 90,
          truthBoundaryStrictness: 'standard',
        },
        products: [
          {
            id: 'prod_keep_refund',
            title: 'Preserved Product',
            brand: 'Brand',
            category: 'Cat',
            description: 'Desc',
            image: '',
            status: 'active',
            completenessScore: 80,
            evidenceCoverageScore: 0,
            externalDiscoveryStatus: 'unindexed',
            attributes: {},
            variants: [{ id: 'v_keep', sku: 'KEEP-1', title: 'Default', barcode: '', price: 25, inventoryCount: 3, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          },
        ],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
      });

      const eventId = `evt_lease_race_${Date.now()}`;
      const baseEvent = {
        id: `bevt_${eventId}`,
        provider: 'sandbox',
        eventId,
        eventType: 'customer.subscription.updated',
        idempotencyKey: eventId,
        payload: {},
        status: 'processing' as const,
        processedAt: new Date().toISOString(),
      };

      // Worker A claims lease
      const claimA = await repo.claimBillingEvent(baseEvent, { leaseOwner: 'worker_A', leaseDurationMs: 2000 });
      assert.equal(claimA.claimed, true);
      assert.equal(claimA.leaseOwner, 'worker_A');
      assert.equal(claimA.event?.attemptCount, 1);

      // Worker B cannot steal active lease
      const claimBBlocked = await repo.claimBillingEvent(baseEvent, { leaseOwner: 'worker_B' });
      assert.equal(claimBBlocked.claimed, false);

      // Lease renewal succeeds for Worker A, fails for Worker B
      assert.equal(await billingService.renewEventLease(eventId, 'worker_A', 5000), true);
      assert.equal(await billingService.renewEventLease(eventId, 'worker_B', 5000), false);

      // Simulate lease expiration on Worker A so Worker B legitimately steals ownership
      const storedEvt = await repo.getBillingEventById(eventId);
      assert.ok(storedEvt);
      await repo.saveBillingEvent({
        ...storedEvt,
        leaseExpiresAt: new Date(Date.now() - 5000).toISOString(),
      });

      const claimB = await repo.claimBillingEvent(baseEvent, { leaseOwner: 'worker_B', leaseDurationMs: 60000 });
      assert.equal(claimB.claimed, true);
      assert.equal(claimB.leaseOwner, 'worker_B');
      assert.equal(claimB.event?.attemptCount, 2);

      // Stale Worker A MUST be rejected when attempting to apply transition or update status
      await assert.rejects(
        async () => {
          await repo.applyBillingTransition({
            eventId,
            subscription: {
              id: `subrec_${wsId}`,
              workspaceId: wsId,
              provider: 'sandbox',
              customerId: 'cus_stale',
              subscriptionId: 'sub_stale',
              tier: 'Starter',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date().toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: 100,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            leaseOwner: 'worker_A',
          });
        },
        /lease ownership lost/i
      );

      await assert.rejects(
        async () => {
          await repo.updateBillingEventStatus(eventId, 'failed', 'stale failure', 'worker_A');
        },
        /lease ownership lost/i
      );

      // Worker B completes transition cleanly
      await repo.applyBillingTransition({
        eventId,
        subscription: {
          id: `subrec_${wsId}`,
          workspaceId: wsId,
          provider: 'sandbox',
          customerId: 'cus_worker_b',
          subscriptionId: 'sub_worker_b',
          tier: 'Growth',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: 200,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        storeProfileUpdate: { tier: 'Growth', skuLimit: 2500 },
        markProcessed: true,
        leaseOwner: 'worker_B',
      });

      // Partial refund preserves Growth plan
      const partialRefundPayload = JSON.stringify({
        id: `evt_partial_refund_${Date.now()}`,
        type: 'charge.refunded',
        created: 250,
        data: {
          object: {
            subscription: 'sub_worker_b',
            refunded: false,
            amount: 14900,
            amount_refunded: 5000,
            metadata: { workspaceId: wsId },
          },
        },
      });
      const partialSig = crypto.createHmac('sha256', 'whsec_lease_test_secret_123').update(partialRefundPayload).digest('hex');
      const partialRes = await billingService.handleWebhook(partialRefundPayload, partialSig);
      assert.equal(partialRes.action, 'processed');
      assert.equal((await repo.getStoreByWorkspace(wsId))?.tier, 'Growth');

      // Full refund downgrades to Free Audit without deleting catalog products
      const fullRefundPayload = JSON.stringify({
        id: `evt_full_refund_${Date.now()}`,
        type: 'charge.refunded',
        created: 300,
        data: {
          object: {
            subscription: 'sub_worker_b',
            refunded: true,
            amount: 14900,
            amount_refunded: 14900,
            metadata: { workspaceId: wsId },
          },
        },
      });
      const fullSig = crypto.createHmac('sha256', 'whsec_lease_test_secret_123').update(fullRefundPayload).digest('hex');
      const fullRes = await billingService.handleWebhook(fullRefundPayload, fullSig);
      assert.equal(fullRes.action, 'processed');
      assert.equal((await repo.getStoreByWorkspace(wsId))?.tier, 'Free Audit');
      assert.equal((await repo.getSubscriptionByWorkspace(wsId))?.status, 'canceled');
      assert.equal((await repo.loadWorkspaceCatalog(wsId))?.products.length, 1);
    });

    test('strict CSV visibility validation rejects malformed inputs atomically, handles RFC-4180 quotes/newlines, enforces 413 size limit, and isolates workspaces', async () => {
      const tenantA = await registerUser(`ws-d-strictA-${Date.now()}@test.com`, 'Vis Tenant A');
      const tenantB = await registerUser(`ws-d-strictB-${Date.now()}@test.com`, 'Vis Tenant B');

      // Seed valid RFC-4180 CSV with quoted comma, escaped quotes, and embedded newline
      const validCsv = [
        'date,platform,brand_mentions,product_mentions,website_clicks,topic',
        '2026-11-01,ChatGPT Search,5,10,3,"ceramic, ""matte""\npour over"',
      ].join('\n');

      const okRes = await fetch(`${baseUrl}/api/visibility/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ csvContent: validCsv, filename: 'rfc4180.csv' }),
      });
      assert.equal(okRes.status, 200);
      const okBody = await okRes.json();
      assert.equal(okBody.acceptedRowCount, 1);
      assert.equal(okBody.summary.totalBrandMentions, 5);

      // Invalid rows (bad calendar date, negative count, decimal count, unsupported platform) must reject atomically without wiping Tenant A's existing metrics
      const invalidCsv = [
        'date,platform,brand_mentions,product_mentions,website_clicks,topic',
        '2026-11-02,ChatGPT Search,10,10,5,valid row that must roll back',
        '2026-02-30,UnknownEngine,-1,2.5,0,bad row',
      ].join('\n');

      const badRes = await fetch(`${baseUrl}/api/visibility/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ csvContent: invalidCsv, filename: 'bad.csv' }),
      });
      assert.equal(badRes.status, 400);
      const badBody = await badRes.json();
      assert.equal(badBody.status, 'failed');
      assert.equal(badBody.acceptedRowCount, 0);
      assert.ok(Array.isArray(badBody.errors) && badBody.errors.length >= 3);

      // Tenant A's prior metric totals must remain unchanged
      const afterSumA = await fetch(`${baseUrl}/api/visibility/summary`, {
        headers: { Authorization: `Bearer ${tenantA.token}` },
      });
      const sumDataA = await afterSumA.json();
      assert.equal(sumDataA.summary.totalBrandMentions, 5);

      // Tenant B remains isolated and disconnected
      const sumB = await fetch(`${baseUrl}/api/visibility/summary`, {
        headers: { Authorization: `Bearer ${tenantB.token}` },
      });
      const sumDataB = await sumB.json();
      assert.equal(sumDataB.summary.connected, false);
      assert.equal(sumDataB.summary.status, 'DATA_SOURCE_NOT_CONNECTED');

      // Oversized payload > 1MB returns 413
      const hugeCsv = 'date,platform,brand_mentions,product_mentions,website_clicks\n' + 'x'.repeat(1_049_000);
      const hugeRes = await fetch(`${baseUrl}/api/visibility/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ csvContent: hugeCsv, filename: 'huge.csv' }),
      });
      assert.equal(hugeRes.status, 413);
    });
  });

  describe('Additional Remediation Edge Cases (Pagination, Tampering, Feed Safety, Postgres SQL)', () => {
    test('product pagination incomplete cursor/non-advancing cursor forces partially_completed and concurrent/superseded resume is blocked', async () => {
      const tenant = await registerUser(`ws-a-prodpage-${Date.now()}@test.com`, 'Prod Page Store');
      const nowIso = new Date().toISOString();
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'prod-page.myshopify.com',
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

      const missingCursorFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: {
            products: {
              edges: [
                {
                  cursor: 'p1',
                  node: {
                    id: 'gid://shopify/Product/7001',
                    title: 'Product Page Item',
                    handle: 'product-page-item',
                    status: 'ACTIVE',
                    variants: { edges: [{ cursor: 'v1', node: { id: 'gid://shopify/ProductVariant/70011', sku: 'PP-1', price: '15.00' } }], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
      });

      const syncRes = await syncShopifyCatalog(repo, tenant.workspace.id, { customFetch: missingCursorFetch as any });
      assert.equal(syncRes.status, 'partially_completed');
      assert.equal(syncRes.syncRun.paginationMetadata?.productCompletenessStatus, 'incomplete_missing_cursor');

      // Seed a superseded parent run + running run and assert resumeShopifySync rejects
      const parentRun = await repo.createShopifySyncRun({
        id: `sync_p_${Date.now()}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'prod-page.myshopify.com',
        status: 'partially_completed',
        productsDiscovered: 1,
        productsImported: 1,
        variantsImported: 1,
        excludedByPlan: 0,
        cursorResumed: 'cur_x',
        attemptNumber: 1,
        startedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await repo.createShopifySyncRun({
        id: `sync_c_${Date.now()}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'prod-page.myshopify.com',
        status: 'completed',
        productsDiscovered: 1,
        productsImported: 1,
        variantsImported: 1,
        excludedByPlan: 0,
        parentSyncRunId: parentRun.id,
        attemptNumber: 2,
        startedAt: nowIso,
        createdAt: new Date(Date.now() + 10).toISOString(),
        updatedAt: new Date(Date.now() + 10).toISOString(),
      });

      await assert.rejects(
        async () => resumeShopifySync(repo, tenant.workspace.id, { syncRunId: parentRun.id }),
        /superseded/i
      );
    });

    test('webhook status distinguishes cached unverified from live verification and preserves webhookLastVerifiedAt on unavailability', async () => {
      const tenant = await registerUser(`ws-a-whcache-${Date.now()}@test.com`, 'WH Cache Store');
      const nowIso = new Date().toISOString();
      const priorVerifiedAt = '2026-11-10T10:00:00.000Z';

      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'wh-cache.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_valid'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        webhookSubscriptions: [{ id: '1', topic: 'PRODUCTS_CREATE', callbackUrl: `${baseUrl}/api/shopify/webhooks`, active: true, status: 'verified' }],
        webhookVerificationStatus: 'active',
        webhookLastVerifiedAt: priorVerifiedAt,
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // Cached GET /api/shopify/status must NEVER claim live verification
      const cachedHttp = await fetch(`${baseUrl}/api/shopify/status`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(cachedHttp.status, 200);
      const cachedData = await cachedHttp.json();
      assert.equal(cachedData.webhookDetails.verificationMode, 'cached');
      assert.equal(cachedData.webhookDetails.isLiveVerified, false);
      assert.equal(cachedData.webhookStatus, 'registered_unverified');
      assert.equal(cachedData.webhookDetails.webhookLastVerifiedAt, priorVerifiedAt);

      // Live verification failure (503) returns verification_unavailable without overwriting prior webhookLastVerifiedAt
      const failFetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });
      const liveFail = await verifyShopifyWebhookSubscriptionsLive(repo, tenant.workspace.id, {
        customFetch: failFetch as any,
      });
      assert.equal(liveFail.verified, false);
      assert.equal(liveFail.status, 'verification_unavailable');
      assert.equal(liveFail.webhookLastVerifiedAt, priorVerifiedAt);
    });

    test('Business Profile rejects self-declared independent verification with 403 and empty catalog scores 0', async () => {
      const tenant = await registerUser(`ws-b-tamper-${Date.now()}@test.com`, 'BP Tamper Store');

      // Empty catalog discovery readiness must score 0 (never 100%)
      const emptyDiscovery = evaluateDiscoveryReadiness([], 'empty-store.myshopify.com');
      assert.equal(emptyDiscovery.overallScore, 0);
      assert.equal(emptyDiscovery.totalProductsAssessed, 0);

      // Attempt to tamper with verificationStatus='independently_verified'
      const spoofRes = await fetch(`${baseUrl}/api/business-profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tenant.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          legalBusinessName: 'Spoof Corp',
          verificationStatus: 'independently_verified',
        }),
      });
      assert.equal(spoofRes.status, 403);
      const spoofBody = await spoofRes.json();
      assert.equal(spoofBody.code, 'PROTECTED_VERIFICATION_FIELD');

      // Create valid merchant self-declared profile, then verify via trusted server helper
      await fetch(`${baseUrl}/api/business-profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tenant.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          legalBusinessName: 'Verified Goods LLC',
          primaryDomain: 'verifiedgoods.com',
          officialWebsite: 'https://verifiedgoods.com',
        }),
      });
      const verified = await recordIndependentBusinessVerification(repo, tenant.workspace.id, 'dns_txt_proof', { record: 'aixshop-verify=123' });
      assert.equal(verified.verificationStatus, 'independently_verified');
      assert.equal(verified.verificationSource, 'dns_txt_proof');

      const hub = buildBusinessHubChecklist(verified, 1, 80);
      assert.equal(hub.checklistType, 'merchant_preparation_checklist');
      assert.equal(hub.officialIntegrationConnected, false);
    });

    test('Feed engine rejects missing SKU/price/availability/bad GTIN/Meta brand without fabrication and sanitizes CSV formulas', async () => {
      const badProduct: Product = {
        id: 'prod_nofab_1',
        title: '=cmd|"/C calc"!A0',
        brand: '',
        category: '',
        description: '',
        image: '',
        status: 'active',
        completenessScore: 10,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'unindexed',
        attributes: {},
        variants: [{ id: 'v_nofab', sku: '', title: 'Default', barcode: '4006381333939', price: 0, inventoryCount: undefined as any, attributes: {} }],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      };

      const gmcRow = mapProductToGmcRow(badProduct, 'USD');
      assert.equal(gmcRow.price, '');
      assert.equal(gmcRow.availability, '');
      assert.equal(gmcRow.mpn, undefined); // Must NOT fall back to product.id

      const metaRow = mapProductToMetaRow(badProduct, 'USD');
      assert.equal(metaRow.price, '');
      assert.equal(metaRow.availability, '');
      assert.equal(metaRow.condition, '');

      const metaReport = evaluateFeedReadiness([badProduct], 'meta_commerce', 'USD');
      assert.equal(metaReport.validationScope, 'local_structural_check_only');
      assert.equal(metaReport.externalPlatformAccepted, false);
      assert.equal(metaReport.invalidProductsCount, 1);
      const errFields = metaReport.evaluations[0].errors.map((e) => e.field);
      assert.ok(errFields.includes('sku'));
      assert.ok(errFields.includes('price'));
      assert.ok(errFields.includes('availability'));
      assert.ok(errFields.includes('gtin'));
      assert.ok(errFields.includes('brand'));

      const safeCsv = exportToCsv([gmcRow]);
      assert.ok(!safeCsv.includes('\n=cmd') && safeCsv.includes("'=cmd"), 'CSV formula injection must be neutralized');
    });

    test('PostgresRepository SQL verification (mock pool): workspace-scoped sync run update & atomic visibility rollback', async () => {
      const queries: Array<{ sql: string; params: any[] }> = [];
      let shouldFailMetricInsert = false;
      const mockClient = {
        query: async (sql: string, params: any[] = []) => {
          queries.push({ sql, params });
          if (shouldFailMetricInsert && sql.includes('INSERT INTO ai_visibility_metrics')) {
            throw new Error('simulated constraint failure');
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
      const mockPool: any = {
        connect: async () => mockClient,
        query: async (sql: string, params: any[] = []) => {
          queries.push({ sql, params });
          if (sql.includes('UPDATE shopify_sync_runs')) {
            return { rows: [], rowCount: 0 }; // Simulate wrong workspaceId -> 0 rows updated
          }
          return { rows: [], rowCount: 0 };
        },
      };

      const pgRepo = new PostgresRepository(mockPool);

      // 1. updateShopifySyncRun enforces WHERE id = $1 AND workspace_id = $2
      await assert.rejects(
        async () => pgRepo.updateShopifySyncRun('sync_1', 'ws_wrong', { status: 'completed' }),
        /not found for workspace ws_wrong/
      );
      const updateCall = queries.find((q) => q.sql.includes('UPDATE shopify_sync_runs'));
      assert.ok(updateCall?.sql.includes('WHERE id = $1 AND workspace_id = $2'));

      // 2. saveVisibilityImportAtomic issues BEGIN and ROLLBACK on metric error
      shouldFailMetricInsert = true;
      await assert.rejects(async () => {
        await pgRepo.saveVisibilityImportAtomic(
          {
            id: 'vimp_pg_1',
            workspaceId: 'ws_1',
            filename: 'f.csv',
            rowCount: 1,
            rejectedRowCount: 0,
            status: 'completed',
            errors: [],
            reportingPeriodStart: '2026-11-01',
            reportingPeriodEnd: '2026-11-01',
            sourcePlatform: 'merchant_csv_upload',
            createdAt: new Date().toISOString(),
          },
          [
            {
              id: 'vm_1',
              workspaceId: 'ws_1',
              importId: 'vimp_pg_1',
              observationDate: '2026-11-01',
              platform: 'ChatGPT Search',
              brandMentions: 1,
              productMentions: 2,
              websiteClicks: 1,
              discoveryTopic: 'coffee',
              evidenceSource: 'f.csv',
              createdAt: new Date().toISOString(),
            },
          ]
        );
      }, /simulated constraint failure/);
      assert.ok(queries.some((q) => q.sql === 'BEGIN'));
      assert.ok(queries.some((q) => q.sql === 'ROLLBACK'));
    });
  });
});
