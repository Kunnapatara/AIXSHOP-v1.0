import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { encryptCredential } from './security/encryption';
import { syncShopifyCatalog } from './shopify/syncService';
import { processShopifyWebhook } from './shopify/webhookService';
import { getPostgresPoolConfig } from './db/index';

describe('AIXSHOP v1.0 — Workstream 6: Shopify Catalog + Provenance Atomicity & Durable Recovery', () => {
  const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_API_KEY = 'ws6_shopify_api_key';
  const TEST_API_SECRET = 'ws6_shopify_api_secret';
  const TEST_SHOP = 'ws6-artisan.myshopify.com';
  const originalEnv = { ...process.env };

  before(() => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.SHOPIFY_API_KEY = TEST_API_KEY;
    process.env.SHOPIFY_API_SECRET = TEST_API_SECRET;
    process.env.SHOPIFY_APP_URL = 'https://ws6-app.example.com';
  });

  after(() => {
    process.env = originalEnv;
  });

  async function seedWorkspaceWithShopify(
    repo: MemoryRepository,
    suffix: string,
    shopDomain = TEST_SHOP,
    tier: 'Free Audit' | 'Growth' = 'Growth'
  ) {
    const userId = `u_ws6_${suffix}`;
    const workspaceId = `ws_ws6_${suffix}`;
    await repo.createUser({
      id: userId,
      email: `ws6_${suffix}@example.com`,
      passwordHash: 'hash_unused',
      fullName: 'WS6 Merchant',
    });
    await repo.createWorkspace(
      { id: workspaceId, name: `WS6 Store ${suffix}`, slug: `ws6-store-${suffix}` },
      userId
    );
    await repo.saveStoreProfile(workspaceId, {
      name: `WS6 Store ${suffix}`,
      domain: shopDomain,
      websiteUrl: `https://${shopDomain}`,
      platform: 'Shopify Admin GraphQL API (2026-10)',
      sourceClassification: 'shopify_oauth',
      shopifyConnected: true,
      shopifyShopDomain: shopDomain,
      currency: 'USD',
      skuCount: 0,
      skuLimit: tier === 'Growth' ? 2500 : 2500,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier,
      connectors: [],
    });
    const nowIso = new Date().toISOString();
    await repo.saveShopifyConnection({
      id: `conn_${workspaceId}`,
      workspaceId,
      shopDomain,
      accessTokenEncrypted: encryptCredential('shpat_ws6_valid_token'),
      refreshTokenEncrypted: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: null,
      lastRefreshedAt: null,
      webhookSubscriptions: [],
      grantedScopes: 'read_products',
      keyVersion: 'v1',
      status: 'connected',
      installedAt: nowIso,
      lastVerifiedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { userId, workspaceId };
  }

  function signWebhook(rawPayload: Buffer): string {
    return crypto.createHmac('sha256', TEST_API_SECRET).update(rawPayload).digest('base64');
  }

  function makeGraphQLFetch(products: Array<{
    numericId: string;
    title: string;
    isGiftCard: boolean;
    sku: string;
    price: string;
    updatedAt?: string;
  }>, options: { hasNextPage?: boolean; endCursor?: string | null } = {}) {
    return async (_url: any, init: any): Promise<any> => {
      const body = JSON.parse(init.body);
      if (body.query.includes('getProducts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              products: {
                pageInfo: {
                  hasNextPage: options.hasNextPage ?? false,
                  endCursor: options.endCursor ?? null,
                },
                edges: products.map((p, idx) => ({
                  cursor: `cur_${idx + 1}`,
                  node: {
                    id: `gid://shopify/Product/${p.numericId}`,
                    title: p.title,
                    handle: `prod-${p.numericId}`,
                    vendor: 'WS6 Brand',
                    productType: p.isGiftCard ? 'Gift Cards' : 'Coffee',
                    description: `Description for ${p.title}`,
                    status: 'ACTIVE',
                    isGiftCard: p.isGiftCard,
                    updatedAt: p.updatedAt || '2026-11-20T10:00:00Z',
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/test.jpg' } }] },
                    variants: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          cursor: 'v_cur_1',
                          node: {
                            id: `gid://shopify/ProductVariant/${p.numericId}01`,
                            title: 'Default',
                            sku: p.sku,
                            barcode: '012345678905',
                            price: p.price,
                            inventoryQuantity: 10,
                          },
                        },
                      ],
                    },
                  },
                })),
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected GraphQL query: ${body.query}`);
    };
  }

  test('1. syncShopifyCatalog rolls back catalog, store SKU count, catalogVersion, and prior provenance when provenance upsert fails mid-batch, then recovers cleanly', async () => {
    const repo = new MemoryRepository(false);
    const { workspaceId } = await seedWorkspaceWithShopify(repo, 'sync_prov_fail');

    const initialCatalog = await repo.loadWorkspaceCatalog(workspaceId);
    const initialVersion = initialCatalog?.catalogVersion || 1;

    const origUpsert = repo.upsertShopifyProductProvenance.bind(repo);
    let upsertAttempts = 0;
    let injectFail = true;
    repo.upsertShopifyProductProvenance = async (record) => {
      upsertAttempts++;
      if (injectFail && upsertAttempts === 2) {
        throw new Error('simulated provenance upsert constraint failure');
      }
      return origUpsert(record);
    };

    const customFetch = makeGraphQLFetch([
      { numericId: '1001', title: 'Espresso Roast', isGiftCard: false, sku: 'ESP-1', price: '18.00' },
      { numericId: '1002', title: 'Holiday Gift Card', isGiftCard: true, sku: 'GC-2', price: '50.00' },
    ]);

    await assert.rejects(
      () => syncShopifyCatalog(repo, workspaceId, { customFetch: customFetch as any }),
      /simulated provenance upsert constraint failure/
    );

    // Verify complete atomic rollback: ZERO products persisted, ZERO provenance rows (including 1st row!), version unchanged
    const catalogAfterFailure = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catalogAfterFailure?.products.length, 0, 'Catalog products must roll back on provenance failure');
    assert.equal(catalogAfterFailure?.storeProfile.skuCount, 0, 'Store SKU count must roll back on provenance failure');
    assert.equal(
      catalogAfterFailure?.catalogVersion ?? 1,
      initialVersion,
      'Catalog version must not advance on rollback'
    );

    const provAfterFailure = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(provAfterFailure.length, 0, 'Earlier provenance row in batch must also roll back');

    const failedRun = await repo.getLatestShopifySyncRun(workspaceId);
    assert.ok(failedRun, 'Failed syncRun must be recorded for recovery');
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.errorMessage || '', /simulated provenance upsert constraint failure/);

    // Now clear failure injection and retry sync -> commits atomically
    injectFail = false;
    const recoveryResult = await syncShopifyCatalog(repo, workspaceId, { customFetch: customFetch as any });
    assert.equal(recoveryResult.status, 'completed');
    assert.equal(recoveryResult.productsImported, 2);

    const catalogAfterRecovery = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catalogAfterRecovery?.products.length, 2);
    assert.equal(catalogAfterRecovery?.storeProfile.skuCount, 2);
    const provAfterRecovery = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(provAfterRecovery.length, 2);
    const gcProv = provAfterRecovery.find((p) => p.productId === 'p_shopify_1002');
    assert.equal(gcProv?.isGiftCard, true);
    assert.equal(gcProv?.sourceType, 'shopify_graphql_admin_api');
  });

  test('2. syncShopifyCatalog rolls back catalog and provenance if final updateShopifySyncRun commit fails inside transaction', async () => {
    const repo = new MemoryRepository(false);
    const { workspaceId } = await seedWorkspaceWithShopify(repo, 'sync_run_fail');

    const origUpdateSyncRun = repo.updateShopifySyncRun.bind(repo);
    repo.updateShopifySyncRun = async (id, wsId, updates) => {
      if (updates.status === 'completed') {
        throw new Error('simulated sync_runs write failure');
      }
      return origUpdateSyncRun(id, wsId, updates);
    };

    const customFetch = makeGraphQLFetch([
      { numericId: '2001', title: 'Single Origin Beans', isGiftCard: false, sku: 'SO-2001', price: '22.00' },
    ]);

    await assert.rejects(
      () => syncShopifyCatalog(repo, workspaceId, { customFetch: customFetch as any }),
      /simulated sync_runs write failure/
    );

    const catalog = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catalog?.products.length, 0, 'Catalog must roll back if syncRun completion update fails');
    const prov = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(prov.length, 0, 'Provenance must roll back if syncRun completion update fails');
    const latestRun = await repo.getLatestShopifySyncRun(workspaceId);
    assert.equal(latestRun?.status, 'failed');
  });

  test('3. Webhook products/create and products/update provenance failure rolls back catalog + preserves prior gift_card provenance, and retry recovers cleanly', async () => {
    const repo = new MemoryRepository(false);
    const { workspaceId } = await seedWorkspaceWithShopify(repo, 'wh_create_update');

    // Step A: Initial products/create (gift_card = true) fails at provenance upsert
    const origUpsert = repo.upsertShopifyProductProvenance.bind(repo);
    let failProvenance = true;
    repo.upsertShopifyProductProvenance = async (record) => {
      if (failProvenance) {
        throw new Error('simulated webhook provenance DB error');
      }
      return origUpsert(record);
    };

    const createPayload = {
      id: 3001,
      title: 'Store Gift Card',
      vendor: 'WS6 Brand',
      product_type: 'Gift Cards',
      handle: 'store-gift-card',
      gift_card: true,
      updated_at: '2026-11-20T10:00:00Z',
      variants: [{ id: 300101, title: '50 USD', sku: 'GC-50', barcode: '', price: '50.00', inventory_quantity: 100 }],
    };
    const rawCreate = Buffer.from(JSON.stringify(createPayload));
    const createHeaders = {
      'x-shopify-topic': 'products/create',
      'x-shopify-shop-domain': TEST_SHOP,
      'x-shopify-delivery-id': 'deliv_create_3001',
      'x-shopify-hmac-sha256': signWebhook(rawCreate),
    };

    await assert.rejects(
      () => processShopifyWebhook(repo, rawCreate, createHeaders),
      /simulated webhook provenance DB error/
    );

    const catAfterFailedCreate = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterFailedCreate?.products.length, 0, 'Product creation must roll back when provenance fails');
    assert.equal(catAfterFailedCreate?.storeProfile.skuCount, 0);
    assert.equal((await repo.getShopifyProductProvenance(workspaceId)).length, 0);

    // Step B: Retry same delivery ID after transient failure clears -> succeeds atomically
    failProvenance = false;
    const retryCreateRes = await processShopifyWebhook(repo, rawCreate, createHeaders);
    assert.equal(retryCreateRes.processed, true);
    assert.equal(retryCreateRes.outcome, 'RETRYABLE_FAILED');

    const catAfterCreate = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterCreate?.products.length, 1);
    assert.equal(catAfterCreate?.products[0].attributes.shopifyIsGiftCard, 'true');
    const provAfterCreate = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(provAfterCreate.length, 1);
    assert.equal(provAfterCreate[0].isGiftCard, true);
    assert.equal(provAfterCreate[0].sourceType, 'shopify_webhook');

    // Step C: products/update flipping gift_card true -> false fails at provenance -> old price, updated_at & old isGiftCard=true MUST remain intact!
    failProvenance = true;
    const updatePayload = {
      id: 3001,
      title: 'Store Gift Card',
      vendor: 'WS6 Brand',
      product_type: 'Gift Cards',
      handle: 'store-gift-card',
      gift_card: false,
      updated_at: '2026-11-21T10:00:00Z',
      variants: [{ id: 300101, title: 'Default', sku: 'GC-50', barcode: '', price: '75.00', inventory_quantity: 100 }],
    };
    const rawUpdate = Buffer.from(JSON.stringify(updatePayload));
    const updateHeaders = {
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': TEST_SHOP,
      'x-shopify-delivery-id': 'deliv_update_3001',
      'x-shopify-hmac-sha256': signWebhook(rawUpdate),
    };

    await assert.rejects(
      () => processShopifyWebhook(repo, rawUpdate, updateHeaders),
      /simulated webhook provenance DB error/
    );

    const catAfterFailedUpdate = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterFailedUpdate?.products.length, 1);
    assert.equal(catAfterFailedUpdate?.products[0].variants[0].price, 50, 'Old variant price must remain on rollback');
    assert.equal(catAfterFailedUpdate?.products[0].attributes.shopifyUpdatedAt, '2026-11-20T10:00:00Z');
    assert.equal(catAfterFailedUpdate?.products[0].attributes.shopifyIsGiftCard, 'true');
    const provAfterFailedUpdate = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(provAfterFailedUpdate[0].isGiftCard, true, 'Prior gift_card=true provenance must remain intact on rollback');

    // Step D: Retry update delivery -> both catalog & provenance flip to gift_card=false atomically
    failProvenance = false;
    const retryUpdateRes = await processShopifyWebhook(repo, rawUpdate, updateHeaders);
    assert.equal(retryUpdateRes.processed, true);
    const catAfterUpdate = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterUpdate?.products[0].variants[0].price, 75);
    assert.equal(catAfterUpdate?.products[0].attributes.shopifyUpdatedAt, '2026-11-21T10:00:00Z');
    assert.equal(catAfterUpdate?.products[0].attributes.shopifyIsGiftCard, undefined);
    const provAfterUpdate = await repo.getShopifyProductProvenance(workspaceId);
    assert.equal(provAfterUpdate[0].isGiftCard, false);

    // Duplicate delivery of completed webhook is idempotently ignored
    const dupUpdateRes = await processShopifyWebhook(repo, rawUpdate, updateHeaders);
    assert.equal(dupUpdateRes.duplicate, true);
    assert.equal(dupUpdateRes.outcome, 'ALREADY_PROCESSED');
  });

  test('4. Webhook products/delete rolls back deletion if provenance delete fails, then recovers on retry; stale out-of-order events are ignored cleanly', async () => {
    const repo = new MemoryRepository(false);
    const { workspaceId } = await seedWorkspaceWithShopify(repo, 'wh_delete_fail');

    const createPayload = {
      id: 4001,
      title: 'Ceramic Pour-Over',
      vendor: 'WS6 Brand',
      product_type: 'Coffee Gear',
      handle: 'ceramic-pour-over',
      gift_card: false,
      updated_at: '2026-11-22T12:00:00Z',
      variants: [{ id: 400101, title: 'Matte Black', sku: 'PO-4001', barcode: '012345678905', price: '42.00', inventory_quantity: 5 }],
    };
    const rawCreate = Buffer.from(JSON.stringify(createPayload));
    await processShopifyWebhook(repo, rawCreate, {
      'x-shopify-topic': 'products/create',
      'x-shopify-shop-domain': TEST_SHOP,
      'x-shopify-delivery-id': 'deliv_4001_create',
      'x-shopify-hmac-sha256': signWebhook(rawCreate),
    });

    // Stale out-of-order update must be ignored without corrupting catalog or provenance
    const staleUpdate = { ...createPayload, title: 'Old Title', gift_card: true, updated_at: '2026-11-20T08:00:00Z' };
    const rawStale = Buffer.from(JSON.stringify(staleUpdate));
    const staleRes = await processShopifyWebhook(repo, rawStale, {
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': TEST_SHOP,
      'x-shopify-delivery-id': 'deliv_4001_stale',
      'x-shopify-hmac-sha256': signWebhook(rawStale),
    });
    assert.equal(staleRes.processed, false);
    assert.equal((await repo.loadWorkspaceCatalog(workspaceId))?.products[0].title, 'Ceramic Pour-Over');
    assert.equal((await repo.getShopifyProductProvenance(workspaceId))[0].isGiftCard, false);

    // Inject failure on provenance delete during products/delete
    const origDelete = repo.deleteShopifyProductProvenance.bind(repo);
    let failDelete = true;
    repo.deleteShopifyProductProvenance = async (wsId, pid) => {
      if (failDelete) {
        throw new Error('simulated provenance delete constraint failure');
      }
      return origDelete(wsId, pid);
    };

    const rawDelete = Buffer.from(JSON.stringify({ id: 4001 }));
    const deleteHeaders = {
      'x-shopify-topic': 'products/delete',
      'x-shopify-shop-domain': TEST_SHOP,
      'x-shopify-delivery-id': 'deliv_4001_delete',
      'x-shopify-hmac-sha256': signWebhook(rawDelete),
    };

    await assert.rejects(
      () => processShopifyWebhook(repo, rawDelete, deleteHeaders),
      /simulated provenance delete constraint failure/
    );

    // Product AND provenance must still exist after rollback
    const catAfterFailedDel = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterFailedDel?.products.length, 1);
    assert.equal(catAfterFailedDel?.storeProfile.skuCount, 1);
    assert.equal((await repo.getShopifyProductProvenance(workspaceId)).length, 1);

    // Retry succeeds atomically
    failDelete = false;
    const retryDelRes = await processShopifyWebhook(repo, rawDelete, deleteHeaders);
    assert.equal(retryDelRes.processed, true);
    const catAfterDel = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catAfterDel?.products.length, 0);
    assert.equal(catAfterDel?.storeProfile.skuCount, 0);
    assert.equal((await repo.getShopifyProductProvenance(workspaceId)).length, 0);
  });

  test('5. Webhook stale/lost lease rejects commit and rolls back catalog & provenance changes', async () => {
    const repo = new MemoryRepository(false);
    const { workspaceId } = await seedWorkspaceWithShopify(repo, 'wh_stale_lease');

    const origUpdateStatus = repo.updateShopifyWebhookEventStatus.bind(repo);
    repo.updateShopifyWebhookEventStatus = async (eventId, shop, topic, status, error, leaseOwner) => {
      if (status === 'processed' && leaseOwner) {
        // Simulate another worker having reclaimed an expired lease before this stale worker finishes
        return origUpdateStatus(eventId, shop, topic, status, error, 'stolen_by_other_worker');
      }
      return origUpdateStatus(eventId, shop, topic, status, error, leaseOwner);
    };

    const payload = {
      id: 5001,
      title: 'Stale Lease Product',
      vendor: 'WS6 Brand',
      product_type: 'Coffee',
      handle: 'stale-lease-product',
      gift_card: true,
      updated_at: '2026-11-22T12:00:00Z',
      variants: [{ id: 500101, title: 'Default', sku: 'SL-1', barcode: '', price: '29.00', inventory_quantity: 2 }],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    await assert.rejects(
      () =>
        processShopifyWebhook(repo, raw, {
          'x-shopify-topic': 'products/create',
          'x-shopify-shop-domain': TEST_SHOP,
          'x-shopify-delivery-id': 'deliv_stale_lease_5001',
          'x-shopify-hmac-sha256': signWebhook(raw),
        }),
      /lease lost or expired/i
    );

    assert.equal((await repo.loadWorkspaceCatalog(workspaceId))?.products.length, 0, 'Stale lease rejection must roll back catalog');
    assert.equal((await repo.getShopifyProductProvenance(workspaceId)).length, 0, 'Stale lease rejection must roll back provenance');
  });

  test('6. Concurrent syncShopifyCatalog and processShopifyWebhook serialize cleanly and preserve tenant isolation', async () => {
    const repo = new MemoryRepository(false);
    const tenantA = await seedWorkspaceWithShopify(repo, 'conc_a', 'conc-a.myshopify.com');
    const tenantB = await seedWorkspaceWithShopify(repo, 'conc_b', 'conc-b.myshopify.com');

    const fetchA = makeGraphQLFetch([
      { numericId: '6001', title: 'Tenant A Synced Coffee', isGiftCard: false, sku: 'A-6001', price: '19.00' },
    ]);
    const webhookPayloadA = {
      id: 6002,
      title: 'Tenant A Webhook Gift Card',
      vendor: 'WS6 Brand',
      product_type: 'Gift Cards',
      handle: 'tenant-a-gc',
      gift_card: true,
      updated_at: '2026-11-22T12:00:00Z',
      variants: [{ id: 600201, title: 'Default', sku: 'A-6002', barcode: '', price: '25.00', inventory_quantity: 5 }],
    };
    const rawWebhookA = Buffer.from(JSON.stringify(webhookPayloadA));

    const webhookPayloadB = {
      id: 7001,
      title: 'Tenant B Mug',
      vendor: 'Tenant B',
      product_type: 'Drinkware',
      handle: 'tenant-b-mug',
      gift_card: false,
      updated_at: '2026-11-22T12:00:00Z',
      variants: [{ id: 700101, title: 'Default', sku: 'B-7001', barcode: '012345678905', price: '14.00', inventory_quantity: 8 }],
    };
    const rawWebhookB = Buffer.from(JSON.stringify(webhookPayloadB));

    await Promise.all([
      syncShopifyCatalog(repo, tenantA.workspaceId, { customFetch: fetchA as any }),
      processShopifyWebhook(repo, rawWebhookA, {
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'conc-a.myshopify.com',
        'x-shopify-delivery-id': 'deliv_conc_a_6002',
        'x-shopify-hmac-sha256': signWebhook(rawWebhookA),
      }),
      processShopifyWebhook(repo, rawWebhookB, {
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'conc-b.myshopify.com',
        'x-shopify-delivery-id': 'deliv_conc_b_7001',
        'x-shopify-hmac-sha256': signWebhook(rawWebhookB),
      }),
    ]);

    const catA = await repo.loadWorkspaceCatalog(tenantA.workspaceId);
    const provA = await repo.getShopifyProductProvenance(tenantA.workspaceId);
    assert.equal(catA?.products.length, 2, 'Concurrent sync and webhook for same tenant must preserve both products');
    assert.equal(provA.length, 2, 'Concurrent sync and webhook for same tenant must preserve both provenance rows');

    const catB = await repo.loadWorkspaceCatalog(tenantB.workspaceId);
    const provB = await repo.getShopifyProductProvenance(tenantB.workspaceId);
    assert.equal(catB?.products.length, 1, 'Tenant B catalog must remain isolated');
    assert.equal(provB.length, 1, 'Tenant B provenance must remain isolated');
    assert.equal(provB[0].productId, 'p_shopify_7001');
  });

  test('7. PostgresRepository SQL verification (mock pool): single-transaction sync & webhook provenance atomicity and ROLLBACK on fault', async () => {
    const createMockPg = (opts: { failSecondProvenance?: boolean; failWebhookLease?: boolean }) => {
      const queries: string[] = [];
      let provInsertCount = 0;

      const storeRow = {
        id: 'store_ws_pg_1',
        tier: 'Growth',
        sku_limit: 2500,
        name: 'PG Store',
        domain: TEST_SHOP,
        website_url: `https://${TEST_SHOP}`,
        platform: 'Shopify Admin GraphQL API (2026-10)',
        source_classification: 'shopify_oauth',
        source_metadata_json: {},
        evidence_coverage_avg: null,
        last_audit_date: null,
        shopify_connected: true,
        shopify_shop_domain: TEST_SHOP,
        currency: 'USD',
        sku_count: 0,
        catalog_completeness_avg: 0,
        truth_boundary_strictness: 'standard',
        connectors_json: [],
        catalog_version: 1,
      };
      const connRow = {
        id: 'conn_ws_pg_1',
        workspaceId: 'ws_pg_1',
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('shpat_pg_mock'),
        refreshTokenEncrypted: null,
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshTokenExpiresAt: null,
        lastRefreshedAt: null,
        webhookSubscriptions: [],
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        webhookLastVerifiedAt: null,
        webhookVerificationStatus: null,
        webhookVerificationDetails: null,
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const syncRowBase = {
        id: 'sync_pg_mock_1',
        workspaceId: 'ws_pg_1',
        shopDomain: TEST_SHOP,
        status: 'syncing',
        productsDiscovered: 0,
        productsImported: 0,
        variantsImported: 0,
        excludedByPlan: 0,
        cursorResumed: null,
        errorMessage: null,
        parentSyncRunId: null,
        attemptNumber: 1,
        variantCompletenessStatus: 'complete',
        variantCompleteness: {},
        paginationMetadata: {},
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const handleQuery = async (sql: string, params: any[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM shopify_connections')) return { rows: [connRow], rowCount: 1 };
        if (sql.includes('FROM stores') && sql.includes('FOR UPDATE')) return { rows: [storeRow], rowCount: 1 };
        if (sql.includes('FROM stores')) return { rows: [storeRow], rowCount: 1 };
        if (sql.includes('INSERT INTO stores') && sql.includes('RETURNING catalog_version')) {
          return { rows: [{ catalog_version: 2 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO shopify_sync_runs')) return { rows: [syncRowBase], rowCount: 1 };
        if (sql.includes('UPDATE shopify_sync_runs')) {
          return {
            rows: [{ ...syncRowBase, status: params[2] || 'completed', completedAt: new Date().toISOString() }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO shopify_webhook_events')) {
          return {
            rows: [
              {
                id: params[0],
                workspaceId: params[1],
                shopDomain: params[2],
                eventId: params[3],
                topic: params[4],
                deliveryId: params[5],
                payload: {},
                status: 'processing',
                retryCount: 0,
                leaseOwner: params[7],
                leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                attemptCount: 1,
                lastError: null,
                processedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE shopify_webhook_events')) {
          if (opts.failWebhookLease && params[3] === 'processed') {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO shopify_product_provenance')) {
          provInsertCount++;
          if (opts.failSecondProvenance && provInsertCount === 2) {
            throw new Error('pg_mock_provenance_failure');
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      };

      const client = { query: handleQuery, release: () => {} };
      const pool: any = {
        connect: async () => client,
        query: handleQuery,
      };
      return { pgRepo: new PostgresRepository(pool), queries };
    };

    // 7a. Sync rollback in PostgreSQL transaction on 2nd provenance insert failure
    const mockFailSync = createMockPg({ failSecondProvenance: true });
    const fetchTwo = makeGraphQLFetch([
      { numericId: '8101', title: 'PG Product 1', isGiftCard: false, sku: 'PG-1', price: '10.00' },
      { numericId: '8102', title: 'PG Product 2', isGiftCard: true, sku: 'PG-2', price: '25.00' },
    ]);
    await assert.rejects(
      () => syncShopifyCatalog(mockFailSync.pgRepo, 'ws_pg_1', { customFetch: fetchTwo as any }),
      /pg_mock_provenance_failure/
    );
    assert.ok(mockFailSync.queries.includes('BEGIN'), 'Sync must run inside BEGIN');
    assert.ok(mockFailSync.queries.includes('ROLLBACK'), 'Sync must ROLLBACK on provenance error');
    assert.equal(mockFailSync.queries.includes('COMMIT'), false, 'Sync must never COMMIT when provenance fails');

    // 7b. Sync clean commit uses single BEGIN..COMMIT covering stores, products, provenance, AND sync_runs
    const mockPassSync = createMockPg({});
    const passRes = await syncShopifyCatalog(mockPassSync.pgRepo, 'ws_pg_1', { customFetch: fetchTwo as any });
    assert.equal(passRes.status, 'completed');
    const beginIdx = mockPassSync.queries.indexOf('BEGIN');
    const commitIdx = mockPassSync.queries.indexOf('COMMIT');
    assert.ok(beginIdx >= 0 && commitIdx > beginIdx);
    const txSlice = mockPassSync.queries.slice(beginIdx, commitIdx);
    assert.ok(txSlice.some((q) => q.includes('INSERT INTO stores')), 'Transaction must include store update');
    assert.ok(txSlice.some((q) => q.includes('INSERT INTO products')), 'Transaction must include product insert');
    assert.ok(txSlice.some((q) => q.includes('INSERT INTO shopify_product_provenance')), 'Transaction must include provenance upsert');
    assert.ok(txSlice.some((q) => q.includes('UPDATE shopify_sync_runs')), 'Transaction must include sync run completion update');

    // 7c. Webhook stale lease rolls back entire transaction (products + provenance + webhook_events)
    const mockFailWh = createMockPg({ failWebhookLease: true });
    const whPayload = Buffer.from(
      JSON.stringify({
        id: 8201,
        title: 'PG Webhook Product',
        vendor: 'WS6',
        product_type: 'Gift Cards',
        gift_card: true,
        updated_at: '2026-11-22T12:00:00Z',
        variants: [{ id: 820101, title: 'Default', sku: 'PGW-1', price: '30.00', inventory_quantity: 5 }],
      })
    );
    await assert.rejects(
      () =>
        processShopifyWebhook(mockFailWh.pgRepo, whPayload, {
          'x-shopify-topic': 'products/create',
          'x-shopify-shop-domain': TEST_SHOP,
          'x-shopify-delivery-id': 'deliv_pg_mock_fail',
          'x-shopify-hmac-sha256': signWebhook(whPayload),
        }),
      /lease ownership lost or expired/i
    );
    assert.ok(mockFailWh.queries.includes('BEGIN'));
    assert.ok(mockFailWh.queries.includes('ROLLBACK'));
    assert.equal(mockFailWh.queries.includes('COMMIT'), false);
  });

  const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST || process.env.PGHOST);
  test(
    '8. Live PostgreSQL transactional atomicity for Shopify catalog + provenance + sync/webhook commits',
    { skip: !hasLivePg },
    async () => {
      const pgConfig = getPostgresPoolConfig();
      assert.ok(pgConfig, 'Live PostgreSQL config must exist when test runs');
      const pool = new Pool(pgConfig);
      const pgRepo = new PostgresRepository(pool);
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const userId = `u_ws6_pg_${suffix}`;
      const wsId = `ws_ws6_pg_${suffix}`;
      const shopDomain = `ws6-pg-${suffix}.myshopify.com`;

      try {
        await pgRepo.createUser({
          id: userId,
          email: `ws6_pg_${suffix}@example.com`,
          passwordHash: 'hash_unused',
          fullName: 'WS6 PG User',
        });
        await pgRepo.createWorkspace({ id: wsId, name: 'WS6 PG Store', slug: `ws6-pg-${suffix}` }, userId);
        await pgRepo.saveShopifyConnection({
          id: `conn_${wsId}`,
          workspaceId: wsId,
          shopDomain,
          accessTokenEncrypted: encryptCredential('shpat_live_pg_test'),
          refreshTokenEncrypted: null,
          tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshTokenExpiresAt: null,
          lastRefreshedAt: null,
          webhookSubscriptions: [],
          grantedScopes: 'read_products',
          keyVersion: 'v1',
          status: 'connected',
          installedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Force failure inside commitShopifyCatalogSyncAtomic via non-existent syncRunId -> must ROLLBACK products & provenance!
        await assert.rejects(() =>
          pgRepo.commitShopifyCatalogSyncAtomic({
            workspaceId: wsId,
            syncRunId: 'sync_missing_id_forces_rollback',
            syncRunUpdates: { status: 'completed' },
            buildNextCatalog: (catalog) => ({
              nextCatalog: {
                ...catalog,
                products: [
                  {
                    id: 'p_shopify_9911',
                    title: 'Should Roll Back',
                    brand: 'Test',
                    category: 'Coffee',
                    description: 'Desc',
                    image: '',
                    status: 'active',
                    completenessScore: 50,
                    evidenceCoverageScore: 0,
                    externalDiscoveryStatus: 'observed_in_sample',
                    sourceClassification: 'shopify_oauth',
                    attributes: { sourceProductId: '9911' },
                    variants: [{ id: 'v_shopify_991101', sku: 'RB-1', title: 'Default', barcode: '', price: 15, inventoryCount: 1, attributes: {} }],
                    offers: [],
                    evidenceDocuments: [],
                    findingsCount: 0,
                    lastAudited: new Date().toISOString(),
                  },
                ],
              },
              provenanceRecords: [
                {
                  workspaceId: wsId,
                  productId: 'p_shopify_9911',
                  shopDomain,
                  shopifyProductId: '9911',
                  shopifyGid: 'gid://shopify/Product/9911',
                  isGiftCard: true,
                  sourceType: 'shopify_graphql_admin_api',
                  verifiedAt: new Date().toISOString(),
                },
              ],
            }),
          })
        );

        const rolledBackCat = await pgRepo.loadWorkspaceCatalog(wsId);
        assert.equal(rolledBackCat?.products.length, 0, 'PostgreSQL rollback must revert product rows');
        const rolledBackProv = await pgRepo.getShopifyProductProvenance(wsId);
        assert.equal(rolledBackProv.length, 0, 'PostgreSQL rollback must revert provenance rows');

        // Clean sync commit
        const fetchLive = makeGraphQLFetch([
          { numericId: '9912', title: 'Committed Live PG Card', isGiftCard: true, sku: 'PG-9912', price: '40.00' },
        ]);
        const syncRes = await syncShopifyCatalog(pgRepo, wsId, { customFetch: fetchLive as any });
        assert.equal(syncRes.status, 'completed');
        assert.equal((await pgRepo.loadWorkspaceCatalog(wsId))?.products.length, 1);
        const provAfter = await pgRepo.getShopifyProductProvenance(wsId);
        assert.equal(provAfter.length, 1);
        assert.equal(provAfter[0].isGiftCard, true);
      } finally {
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
        await pool.end();
      }
    }
  );
});
