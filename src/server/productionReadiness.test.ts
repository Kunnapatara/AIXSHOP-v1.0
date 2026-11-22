import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { validateAndApplyProfileUpdate } from '../domain/settings/settingsService';
import { ingestAndAnalyzeStore } from '../domain/ingestion/storeIngestion';
import { handleShopifyCallback, disconnectShopify, initiateShopifyConnect } from './shopify/oauthService';

function extractCookie(res: Response, name = 'aixshop_session'): string | null {
  const raw = res.headers.get('set-cookie') || '';
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

describe('AIXSHOP Production Readiness: Domain Cleanup, Source Classification & Anti-Spoofing', () => {
  let repo: MemoryRepository;
  let server: http.Server;
  let baseUrl: string;
  const origShopifyEnv = {
    key: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    appUrl: process.env.SHOPIFY_APP_URL,
    encKey: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY,
  };

  beforeEach(async () => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SHOPIFY_API_KEY = 'test_shopify_key';
    process.env.SHOPIFY_API_SECRET = 'test_shopify_secret';
    process.env.SHOPIFY_APP_URL = 'https://app.aixshop-test.com';

    repo = new MemoryRepository();
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.SHOPIFY_API_KEY = origShopifyEnv.key;
    process.env.SHOPIFY_API_SECRET = origShopifyEnv.secret;
    process.env.SHOPIFY_APP_URL = origShopifyEnv.appUrl;
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = origShopifyEnv.encKey;
  });

  test('Task 1: Registration and workspace creation do not fabricate .myshopify.com domains or fake Shopify connections', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'realmerchant@artisanfoods.com',
        password: 'Password!12345',
        fullName: 'Real Merchant',
        workspaceName: 'Artisan Foods Co',
      }),
    });
    assert.equal(regRes.status, 201);
    const cookie = extractCookie(regRes);
    assert.ok(cookie);

    // Check store profile
    const storeRes = await fetch(`${baseUrl}/api/store/profile`, {
      headers: { Cookie: `aixshop_session=${cookie}` },
    });
    assert.equal(storeRes.status, 200);
    const store = await storeRes.json();
    assert.equal(store.domain, '');
    assert.equal(store.websiteUrl, '');
    assert.equal(store.sourceClassification, 'unconfigured');
    assert.equal(store.shopifyConnected, false);
    assert.equal(store.shopifyShopDomain, undefined);
    assert.equal(store.platform, undefined);
    assert.doesNotMatch(JSON.stringify(store), /myshopify\.com/);

    // Check catalog load on new workspace
    const catRes = await fetch(`${baseUrl}/api/catalog`, {
      headers: { Cookie: `aixshop_session=${cookie}` },
    });
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.equal(catData.catalog.storeProfile.domain, '');
    assert.equal(catData.catalog.storeProfile.sourceClassification, 'unconfigured');
    assert.equal(catData.catalog.storeProfile.shopifyConnected, false);

    const regData = await regRes.json();

    // Create secondary workspace directly via repository and verify no synthetic domain
    const { workspace: ws2 } = await repo.createWorkspace(
      { id: 'ws_secondary_test', name: 'European Roasters', slug: 'european-roasters' },
      regData.user.id
    );
    const wsStore = await repo.getStoreByWorkspace(ws2.id);
    assert.ok(wsStore);
    assert.equal(wsStore.domain, '');
    assert.equal(wsStore.websiteUrl, '');
    assert.equal(wsStore.sourceClassification, 'unconfigured');
    assert.equal(wsStore.shopifyConnected, false);
    assert.equal(wsStore.shopifyShopDomain, undefined);
    assert.doesNotMatch(JSON.stringify(wsStore), /myshopify\.com/);
  });

  test('Task 1 & Security: PUT /api/store/profile allows optional/custom domain and blocks spoofing Shopify OAuth & provenance fields', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'general@nonshopifybrand.com',
        password: 'Password!12345',
        fullName: 'General Brand',
        workspaceName: 'NonShopify Brand',
      }),
    });
    const cookie = extractCookie(regRes)!;

    // Attempt to update custom domain while trying to spoof shopifyConnected & sourceClassification
    const putRes = await fetch(`${baseUrl}/api/store/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `aixshop_session=${cookie}`,
      },
      body: JSON.stringify({
        name: 'NonShopify Brand Store',
        domain: 'https://www.nonshopifybrand.com/shop',
        shopifyConnected: true,
        shopifyShopDomain: 'spoofed.myshopify.com',
        sourceClassification: 'shopify_oauth',
        platform: 'Shopify Storefront API v2025-01',
      }),
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.store.domain, 'https://www.nonshopifybrand.com/shop');
    assert.equal(putData.store.websiteUrl, 'https://www.nonshopifybrand.com/shop');
    assert.equal(putData.store.shopifyConnected, false);
    assert.equal(putData.store.shopifyShopDomain, undefined);
    assert.equal(putData.store.sourceClassification, 'unconfigured');
    assert.equal(putData.store.platform, undefined);

    // Clearing domain back to empty succeeds for optional general website config
    const clearRes = await fetch(`${baseUrl}/api/store/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `aixshop_session=${cookie}`,
      },
      body: JSON.stringify({
        name: 'NonShopify Brand Store',
        domain: '',
      }),
    });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.store.domain, '');
    assert.equal(clearData.store.websiteUrl, '');
  });

  test('Security: PUT /api/catalog and POST /api/catalog/import reject forged shopify_oauth sourceClassification and acquisition methods', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'spoofer@example.com',
        password: 'Password!12345',
        fullName: 'Spoof Tester',
        workspaceName: 'Spoof Guard',
      }),
    });
    const cookie = extractCookie(regRes)!;

    // 1. Forged POST /api/catalog/import with shopify_oauth
    const importRes = await fetch(`${baseUrl}/api/catalog/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `aixshop_session=${cookie}`,
      },
      body: JSON.stringify({
        candidates: [
          {
            id: 'p_spoof_1',
            title: 'Forged Shopify Product',
            brand: 'FakeBrand',
            category: 'Coffee',
            description: 'Attempted provenance forgery',
            image: '',
            status: 'active',
            completenessScore: 90,
            evidenceCoverageScore: 0,
            externalDiscoveryStatus: 'not_observed',
            sourceClassification: 'shopify_oauth',
            acquisitionMethod: 'shopify_admin_graphql',
            attributes: {},
            variants: [{ id: 'v_spoof_1', sku: 'SP-1', title: 'Default', barcode: '', price: 19.99, inventoryCount: 10, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          },
        ],
      }),
    });
    assert.equal(importRes.status, 403);
    const importErr = await importRes.json();
    assert.equal(importErr.code, 'PROTECTED_VERIFICATION_FIELD');

    // 2. Forged PUT /api/catalog with shopify_oauth
    const putCatRes = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `aixshop_session=${cookie}`,
      },
      body: JSON.stringify({
        products: [
          {
            id: 'p_spoof_2',
            title: 'Forged PUT Product',
            brand: 'FakeBrand',
            category: 'Coffee',
            description: 'Attempted PUT provenance forgery',
            image: '',
            status: 'active',
            completenessScore: 90,
            evidenceCoverageScore: 0,
            externalDiscoveryStatus: 'not_observed',
            sourceClassification: 'shopify_oauth',
            acquisitionMethod: 'shopify_webhook',
            attributes: {},
            variants: [{ id: 'v_spoof_2', sku: 'SP-2', title: 'Default', barcode: '', price: 19.99, inventoryCount: 10, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          },
        ],
        actions: [],
        findings: [],
        variants: [],
        offers: [],
        evidence: [],
        storeProfile: {
          name: 'Spoof Guard Store',
          domain: 'custom-site.com',
          currency: 'USD',
          skuCount: 1,
          catalogCompletenessAvg: 90,
          truthBoundaryStrictness: 'standard',
          tier: 'Free Audit',
          connectors: [],
          sourceClassification: 'shopify_oauth',
          shopifyConnected: true,
        },
      }),
    });
    assert.equal(putCatRes.status, 403);
    const putErr = await putCatRes.json();
    assert.equal(putErr.code, 'PROTECTED_VERIFICATION_FIELD');
  });

  test('PostgresRepository: never returns hardcoded Shopify Storefront API v2025-01, 70, or fabricated lastAuditDate when columns are null', async () => {
    const mockPool: any = {
      query: async () => ({
        rows: [
          {
            id: 'store_ws1',
            workspace_id: 'ws1',
            name: 'Fresh Merchant',
            domain: '',
            website_url: '',
            platform: null,
            source_classification: 'unconfigured',
            source_metadata_json: null,
            shopify_connected: false,
            shopify_shop_domain: null,
            tier: 'Free Audit',
            sku_limit: 2500,
            sku_count: 0,
            catalog_completeness_avg: 0,
            evidence_coverage_avg: null,
            last_audit_date: null,
            currency: 'USD',
            truth_boundary_strictness: 'standard',
            connectors_json: [],
          },
        ],
      }),
    };
    const pgRepo = new PostgresRepository(mockPool);
    const store = await pgRepo.getStoreByWorkspace('ws1');
    assert.ok(store);
    assert.equal(store.platform, undefined);
    assert.equal(store.evidenceCoverageAvg, undefined);
    assert.equal(store.lastAuditDate, undefined);
    assert.equal(store.domain, '');
    assert.equal(store.sourceClassification, 'unconfigured');
    assert.equal(store.shopifyConnected, false);
  });

  test('Migration 016 SQL: adds source classification columns, cleans only unbacked synthetic domains, and preserves real custom domains & Shopify connections', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'src/server/db/migrations/016_source_classification_and_domain_cleanup.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.match(sql, /ALTER TABLE stores[\s\S]*ADD COLUMN IF NOT EXISTS source_classification/i);
    assert.match(sql, /ALTER TABLE stores[\s\S]*ADD COLUMN IF NOT EXISTS shopify_connected/i);
    assert.match(sql, /ALTER TABLE products[\s\S]*ADD COLUMN IF NOT EXISTS source_classification/i);
    assert.match(sql, /ALTER TABLE products[\s\S]*ADD COLUMN IF NOT EXISTS acquisition_method/i);
    assert.match(sql, /sc\.status = 'connected'/i);
    assert.match(sql, /w\.slug \|\| '\.myshopify\.com'/i);
    assert.match(sql, /store\.myshopify\.com/i);
  });

  test('OAuth Service: connect preserves existing custom merchant domain & updates shopify_primary connector; disconnect preserves domain and sets shopifyConnected=false', async () => {
    const { workspace } = await repo.registerUser({
      user: { id: 'u_oa', email: 'oa@example.com', passwordHash: 'h', fullName: 'OA' },
      workspace: { id: 'ws_oa', name: 'Artisan Coffee', slug: 'artisan-coffee' },
      session: {
        id: 's_oa',
        sessionTokenHash: 'th_oa',
        userId: 'u_oa',
        activeWorkspaceId: 'ws_oa',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const initialStore = await repo.getStoreByWorkspace(workspace.id);
    assert.ok(initialStore);
    await repo.saveStoreProfile(workspace.id, {
      ...initialStore,
      domain: 'artisancoffee.com',
      websiteUrl: 'artisancoffee.com',
      connectors: [
        {
          id: 'shopify_primary',
          name: 'Shopify Connector',
          type: 'shopify',
          status: 'not_configured',
          lastSync: 'Never',
          productCountSynced: 0,
          writeBackAuthorized: false,
        },
      ],
    });

    const init = await initiateShopifyConnect(repo, workspace.id, 'artisan-coffee-shop.myshopify.com');

    const callbackParams: Record<string, string> = {
      code: 'auth_code_123',
      shop: 'artisan-coffee-shop.myshopify.com',
      state: init.state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const msg = Object.keys(callbackParams)
      .sort()
      .map((k) => `${k}=${callbackParams[k]}`)
      .join('&');
    callbackParams.hmac = crypto.createHmac('sha256', 'test_shopify_secret').update(msg).digest('hex');

    const mockFetch: typeof fetch = async (input: any) => {
      const url = String(input);
      if (url.includes('/admin/oauth/access_token')) {
        return new Response(
          JSON.stringify({ access_token: 'shpat_live_123', scope: 'read_products' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            shop: {
              name: 'Artisan Coffee Shop',
              myshopifyDomain: 'artisan-coffee-shop.myshopify.com',
              currencyCode: 'USD',
              primaryDomain: { host: 'artisancoffee.com' },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await handleShopifyCallback(repo, callbackParams, { customFetch: mockFetch });
    assert.equal(res.shopDomain, 'artisan-coffee-shop.myshopify.com');

    const connectedStore = await repo.getStoreByWorkspace(workspace.id);
    assert.ok(connectedStore);
    assert.equal(connectedStore.domain, 'artisancoffee.com');
    assert.equal(connectedStore.shopifyConnected, true);
    assert.equal(connectedStore.shopifyShopDomain, 'artisan-coffee-shop.myshopify.com');
    assert.equal(connectedStore.sourceClassification, 'shopify_oauth');
    const connEntry = connectedStore.connectors.find((c: any) => c.id === 'shopify_primary');
    assert.ok(connEntry);
    assert.equal(connEntry.status, 'connected');

    // Disconnect preserves custom domain and sets shopifyConnected = false
    await disconnectShopify(repo, workspace.id);
    const disconnectedStore = await repo.getStoreByWorkspace(workspace.id);
    assert.ok(disconnectedStore);
    assert.equal(disconnectedStore.domain, 'artisancoffee.com');
    assert.equal(disconnectedStore.shopifyConnected, false);
    assert.equal(disconnectedStore.shopifyShopDomain, undefined);
    assert.equal(disconnectedStore.sourceClassification, 'unconfigured');
    const disConnEntry = disconnectedStore.connectors.find((c: any) => c.id === 'shopify_primary');
    assert.equal(disConnEntry?.status, 'disconnected');
  });

  test('Public Feed Ingestion & Settings Service: accurately classify 25-product public feed sample vs demo vs unsupported general website', async () => {
    // 1. Public feed 25-product sample
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          products: [
            {
              id: 101,
              title: 'Organic Matcha Tin',
              vendor: 'Kyoto Tea',
              product_type: 'Tea',
              handle: 'organic-matcha',
              body_html: '<p>Stone-ground ceremonial grade matcha.</p>',
              variants: [{ id: 201, sku: 'MT-01', title: '30g Tin', price: '28.00', barcode: '012345678905' }],
              images: [{ src: 'https://cdn.example.com/matcha.jpg' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as any;

    try {
      const publicCheck = await ingestAndAnalyzeStore('https://kyototea.example.com');
      assert.equal(publicCheck.scanStatus, 'real_scan');
      assert.equal(publicCheck.ingestionResult?.source.classification, 'public_feed');
      assert.equal(publicCheck.ingestionResult?.source.isPartialSample, true);
      assert.equal(publicCheck.ingestionResult?.candidateProducts[0]?.sourceClassification, 'public_feed');
      assert.equal(publicCheck.ingestionResult?.candidateProducts[0]?.acquisitionMethod, 'public_products_json_sample');
      assert.match(publicCheck.notice || '', /25-product sample|not a full website crawl/i);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 2. Demo fixture classification
    const demoCheck = await ingestAndAnalyzeStore('https://solsticecraftgoods.store');
    assert.equal(demoCheck.scanStatus, 'demo_fixture');
    assert.equal(demoCheck.ingestionResult?.source.classification, 'demo');
    assert.equal(demoCheck.ingestionResult?.candidateProducts[0]?.sourceClassification, 'demo');
    assert.equal(demoCheck.ingestionResult?.candidateProducts[0]?.acquisitionMethod, 'demo_fixture');

    // 3. Settings service allows empty domain & rejects invalid domain
    const emptySave = validateAndApplyProfileUpdate(
      {
        name: 'Test Store',
        domain: 'old.com',
        currency: 'USD',
        skuCount: 0,
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      },
      { domain: '' },
      false
    );
    assert.equal(emptySave.success, true);
    assert.equal(emptySave.nextProfile?.domain, '');
    assert.equal(emptySave.nextProfile?.websiteUrl, '');

    const badSave = validateAndApplyProfileUpdate(
      emptySave.nextProfile!,
      { domain: 'not a valid domain!' },
      false
    );
    assert.equal(badSave.success, false);
  });
});
