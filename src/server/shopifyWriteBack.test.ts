import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { encryptCredential } from './security/encryption';
import { executeShopifyWriteBack, parseAllowlistedShopifyWriteBackField } from './shopify/writeBackService';
import { ActionItem, Product } from '../types';

const TEST_SHOP_DOMAIN = 'solstice-writeback-test.myshopify.com';
const TEST_TOKEN_SECRET = 'shpat_wb_test_fixture_token_12345';

describe('Task C: Shopify Approved Write-Back Capability (PASS — SIMULATED)', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  const prevEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  before(async () => {
    for (const key of [
      'SHOPIFY_API_KEY',
      'SHOPIFY_API_SECRET',
      'SHOPIFY_TOKEN_ENCRYPTION_KEY',
      'SHOPIFY_SCOPES',
      'APP_URL',
    ]) {
      prevEnv[key] = process.env[key];
    }

    process.env.SHOPIFY_API_KEY = 'test_shopify_api_key_wb';
    process.env.SHOPIFY_API_SECRET = 'test_shopify_api_secret_wb';
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    delete process.env.SHOPIFY_SCOPES;
    process.env.APP_URL = 'http://127.0.0.1:3000';

    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function extractSessionCookie(res: Response): string {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const m = raw.match(/aixshop_session=([^;]+)/);
      if (m?.[1]) return m[1];
    }
    const single = res.headers.get('set-cookie') || '';
    const m = single.match(/aixshop_session=([^;]+)/);
    return m?.[1] || '';
  }

  async function registerWorkspace(label: string) {
    const res = await originalFetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        email: `wb-${label}-${crypto.randomBytes(4).toString('hex')}@example.test`,
        password: 'StrongPassword!2026',
        fullName: `WB Operator ${label}`,
        workspaceName: `WB Store ${label}`,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const cookie = extractSessionCookie(res);
    assert.ok(cookie, 'Session cookie must be issued');
    return {
      userId: body.user.id as string,
      workspaceId: body.workspace.id as string,
      cookie,
    };
  }

  async function apiRequest(
    cookie: string,
    method: string,
    path: string,
    body?: any
  ): Promise<{ status: number; body: any }> {
    const res = await originalFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `aixshop_session=${cookie}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  async function seedPaidGrowthSubscription(workspaceId: string) {
    await repo.saveSubscription({
      id: `sub_${workspaceId}`,
      workspaceId,
      provider: 'stripe',
      customerId: `cus_${workspaceId}`,
      subscriptionId: `sub_stripe_${workspaceId}`,
      tier: 'Growth',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 86_400_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async function seedShopifyConnection(
    workspaceId: string,
    grantedScopes: string,
    shopDomain: string = TEST_SHOP_DOMAIN
  ) {
    const now = new Date().toISOString();
    await repo.saveShopifyConnection({
      id: `shop_conn_${workspaceId}`,
      workspaceId,
      shopDomain,
      accessTokenEncrypted: encryptCredential(TEST_TOKEN_SECRET),
      grantedScopes,
      keyVersion: 'v1',
      installedAt: now,
      lastVerifiedAt: now,
      status: 'connected',
      webhookSubscriptions: [],
      webhookVerificationStatus: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  async function seedShopifyCatalogAndAction(
    workspaceId: string,
    options: {
      includeProvenance?: boolean;
      includeVariantGid?: boolean;
      actionStatus?: ActionItem['status'];
      field?: string;
      from?: string;
      to?: string;
      actionId?: string;
      productId?: string;
    } = {}
  ) {
    const productId = options.productId || 'prod_wb_01';
    const actionId = options.actionId || `act_wb_${crypto.randomBytes(4).toString('hex')}`;
    const shopifyProductId = '9876543210';
    const shopifyProductGid = `gid://shopify/Product/${shopifyProductId}`;
    const shopifyVariantGid = 'gid://shopify/ProductVariant/1122334455';

    const product: Product = {
      id: productId,
      title: 'Artisan Pour-Over Kettle',
      brand: 'Solstice Goods',
      category: 'Kitchen & Dining',
      description: 'Precision stainless pour-over kettle.',
      image: 'https://cdn.shopify.com/kettle.jpg',
      status: 'active',
      completenessScore: 88,
      evidenceCoverageScore: 85,
      externalDiscoveryStatus: 'observed_in_sample',
      sourceClassification: 'shopify_oauth',
      sourceOrigin: TEST_SHOP_DOMAIN,
      acquisitionMethod: 'shopify_admin_graphql',
      attributes: {
        material: 'Stainless Steel',
        shopifyGid: shopifyProductGid,
      },
      variants: [
        {
          id: 'var_wb_01',
          sku: 'KETTLE-01',
          title: 'Matte Black 1L',
          barcode: '',
          price: 89.0,
          inventoryCount: 14,
          attributes:
            options.includeVariantGid === false
              ? {}
              : { shopifyVariantGid },
        },
      ],
      offers: [
        {
          id: 'off_wb_01',
          channel: 'Direct Storefront',
          price: 89.0,
          currency: 'USD',
          availability: 'in_stock',
          condition: 'new',
          url: `https://${TEST_SHOP_DOMAIN}/products/artisan-kettle`,
          merchantId: 'merch_wb',
          lastSync: new Date().toISOString(),
        },
      ],
      evidenceDocuments: [],
      findingsCount: 1,
      lastAudited: new Date().toISOString(),
    };

    const action: ActionItem = {
      id: actionId,
      findingId: 'find_wb_01',
      productId,
      productTitle: product.title,
      title: 'Update missing or unformatted catalog field',
      severity: 'high',
      status: options.actionStatus ?? 'approved',
      evidenceRequired: false,
      proposedChange: {
        field: options.field ?? 'variants[0].barcode',
        from: options.from ?? '',
        to: options.to ?? '4006381333931',
      },
      verificationStatus: 'verified_in_catalog',
      approvedAt: options.actionStatus === 'approved' || options.actionStatus === undefined ? new Date().toISOString() : undefined,
      auditLog: [],
    };

    const store = await repo.getStoreByWorkspace(workspaceId);
    assert.ok(store);

    const existingCatalog = await repo.loadWorkspaceCatalog(workspaceId);
    const mergedProducts = [
      ...(existingCatalog?.products || []).filter((p) => p.id !== productId),
      product,
    ];
    const mergedActions = [
      ...(existingCatalog?.actions || []).filter((a) => a.id !== actionId),
      action,
    ];

    await repo.saveWorkspaceCatalog(
      workspaceId,
      {
        products: mergedProducts,
        variants: mergedProducts.flatMap((p) => p.variants || []),
        offers: mergedProducts.flatMap((p) => p.offers || []),
        findings: existingCatalog?.findings || [],
        actions: mergedActions,
        evidence: existingCatalog?.evidence || [],
        storeProfile: {
          ...store,
          shopifyConnected: true,
          shopifyShopDomain: TEST_SHOP_DOMAIN,
          sourceClassification: 'shopify_oauth',
        },
      },
      existingCatalog?.catalogVersion !== undefined
        ? { expectedVersion: existingCatalog.catalogVersion }
        : undefined
    );

    if (options.includeProvenance !== false) {
      await repo.upsertShopifyProductProvenance({
        workspaceId,
        productId,
        shopDomain: TEST_SHOP_DOMAIN,
        shopifyProductId,
        shopifyGid: shopifyProductGid,
        isGiftCard: false,
        sourceType: 'shopify_graphql_admin_api',
        verifiedAt: new Date().toISOString(),
      });
    }

    return { productId, actionId, shopifyProductGid, shopifyVariantGid };
  }

  function installShopifyGraphQLMock(
    handler: (query: string, variables: any, attempt: number) => { status?: number; headers?: Record<string, string>; body: any }
  ) {
    let callCount = 0;
    const calls: Array<{ query: string; variables: any }> = [];

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes(TEST_SHOP_DOMAIN) && url.includes('/admin/api/')) {
        callCount += 1;
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ query: parsed.query || '', variables: parsed.variables });
        const result = handler(parsed.query || '', parsed.variables, callCount);
        return new Response(JSON.stringify(result.body), {
          status: result.status ?? 200,
          headers: {
            'Content-Type': 'application/json',
            ...(result.headers || {}),
          },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    return { calls };
  }

  test('1. Field allowlist parser strictly permits only product title and variant barcode/sku/price', () => {
    assert.deepEqual(parseAllowlistedShopifyWriteBackField('title'), {
      kind: 'product',
      property: 'title',
      fieldPath: 'title',
    });
    assert.deepEqual(parseAllowlistedShopifyWriteBackField('variants[0].barcode'), {
      kind: 'variant',
      variantIndex: 0,
      property: 'barcode',
      fieldPath: 'variants[0].barcode',
    });
    assert.deepEqual(parseAllowlistedShopifyWriteBackField('variants[2].sku'), {
      kind: 'variant',
      variantIndex: 2,
      property: 'sku',
      fieldPath: 'variants[2].sku',
    });
    assert.deepEqual(parseAllowlistedShopifyWriteBackField('variants[1].price'), {
      kind: 'variant',
      variantIndex: 1,
      property: 'price',
      fieldPath: 'variants[1].price',
    });

    assert.equal(parseAllowlistedShopifyWriteBackField('store.catalogPolicy.units'), null);
    assert.equal(parseAllowlistedShopifyWriteBackField('connectors.gmc.feedStatus'), null);
    assert.equal(parseAllowlistedShopifyWriteBackField('attributes.material'), null);
    assert.equal(parseAllowlistedShopifyWriteBackField('variants[0].inventoryCount'), null);
  });

  test('2. OAuth connect defaults to read_products and requests write_products only when writeAccess=true; /status reports writeBackAuthorized dynamically', async () => {
    const { workspaceId, cookie } = await registerWorkspace('oauth-scope');

    const defaultConnect = await apiRequest(
      cookie,
      'GET',
      `/api/shopify/connect?shop=${TEST_SHOP_DOMAIN}`
    );
    assert.equal(defaultConnect.status, 200);
    assert.match(defaultConnect.body.authUrl, /scope=read_products(&|$)/);
    assert.doesNotMatch(defaultConnect.body.authUrl, /write_products/);

    const writeConnect = await apiRequest(
      cookie,
      'GET',
      `/api/shopify/connect?shop=${TEST_SHOP_DOMAIN}&writeAccess=true`
    );
    assert.equal(writeConnect.status, 200);
    const parsedUrl = new URL(writeConnect.body.authUrl);
    assert.equal(parsedUrl.searchParams.get('scope'), 'read_products,write_products');

    await seedShopifyConnection(workspaceId, 'read_products');
    const readOnlyStatus = await apiRequest(cookie, 'GET', '/api/shopify/status');
    assert.equal(readOnlyStatus.status, 200);
    assert.equal(readOnlyStatus.body.writeBackAuthorized, false);

    await seedShopifyConnection(workspaceId, 'read_products,write_products');
    const writeStatus = await apiRequest(cookie, 'GET', '/api/shopify/status');
    assert.equal(writeStatus.status, 200);
    assert.equal(writeStatus.body.writeBackAuthorized, true);
  });

  test('3. Rejects write-back with 403 REPORT_PAYMENT_REQUIRED on Free Audit tier and 403 SHOPIFY_WRITE_SCOPE_REQUIRED when read-only', async () => {
    const { workspaceId, cookie } = await registerWorkspace('gates');
    await seedShopifyConnection(workspaceId, 'read_products,write_products');
    const { actionId } = await seedShopifyCatalogAndAction(workspaceId);

    const unpaidRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actionId}`);
    assert.equal(unpaidRes.status, 403);
    assert.equal(unpaidRes.body.code, 'REPORT_PAYMENT_REQUIRED');

    await seedPaidGrowthSubscription(workspaceId);
    await seedShopifyConnection(workspaceId, 'read_products');

    const readOnlyRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actionId}`);
    assert.equal(readOnlyRes.status, 403);
    assert.equal(readOnlyRes.body.code, 'SHOPIFY_WRITE_SCOPE_REQUIRED');
  });

  test('4. Rejects unapproved actions (409), missing provenance or variant GID (422), unsupported fields (422), and invalid values (422)', async () => {
    const { workspaceId, cookie } = await registerWorkspace('validation');
    await seedPaidGrowthSubscription(workspaceId);
    await seedShopifyConnection(workspaceId, 'read_products,write_products');

    const pending = await seedShopifyCatalogAndAction(workspaceId, {
      actionStatus: 'pending_review',
      actionId: 'act_pending_wb',
    });
    const rPending = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${pending.actionId}`);
    assert.equal(rPending.status, 409);
    assert.equal(rPending.body.code, 'ACTION_NOT_APPROVED');

    const dismissed = await seedShopifyCatalogAndAction(workspaceId, {
      actionStatus: 'dismissed',
      actionId: 'act_dismissed_wb',
    });
    const rDismissed = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${dismissed.actionId}`);
    assert.equal(rDismissed.status, 409);
    assert.equal(rDismissed.body.code, 'ACTION_NOT_APPROVED');

    const unsupported = await seedShopifyCatalogAndAction(workspaceId, {
      actionStatus: 'approved',
      field: 'attributes.material',
      to: 'Ceramic',
      actionId: 'act_unsupported_wb',
    });
    const rUnsupported = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${unsupported.actionId}`);
    assert.equal(rUnsupported.status, 422);
    assert.equal(rUnsupported.body.code, 'UNSUPPORTED_SHOPIFY_WRITEBACK_FIELD');

    const noVariantGid = await seedShopifyCatalogAndAction(workspaceId, {
      actionStatus: 'approved',
      includeVariantGid: false,
      actionId: 'act_novargid_wb',
    });
    const rNoVarGid = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${noVariantGid.actionId}`);
    assert.equal(rNoVarGid.status, 422);
    assert.equal(rNoVarGid.body.code, 'MISSING_SHOPIFY_VARIANT_GID');

    const badGtin = await seedShopifyCatalogAndAction(workspaceId, {
      actionStatus: 'approved',
      field: 'variants[0].barcode',
      to: '1234567890123', // invalid check digit
      actionId: 'act_bad_gtin_wb',
    });
    const rBadGtin = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${badGtin.actionId}`);
    assert.equal(rBadGtin.status, 422);
    assert.equal(rBadGtin.body.code, 'INVALID_WRITEBACK_VALUE');

    // Remove provenance and verify 422 MISSING_SHOPIFY_PROVENANCE
    const wsNoProv = await registerWorkspace('no-prov');
    await seedPaidGrowthSubscription(wsNoProv.workspaceId);
    await seedShopifyConnection(wsNoProv.workspaceId, 'read_products,write_products');
    const noProv = await seedShopifyCatalogAndAction(wsNoProv.workspaceId, {
      includeProvenance: false,
      actionId: 'act_noprov_wb',
    });
    const rNoProv = await apiRequest(wsNoProv.cookie, 'POST', `/api/shopify/write-back/${noProv.actionId}`);
    assert.equal(rNoProv.status, 422);
    assert.equal(rNoProv.body.code, 'MISSING_SHOPIFY_PROVENANCE');
  });

  test('5. Handles Shopify GraphQL userErrors (422) and read-back mismatch (502 verification_failed) without falsely marking applied_externally', async () => {
    const { workspaceId, cookie } = await registerWorkspace('failures');
    await seedPaidGrowthSubscription(workspaceId);
    await seedShopifyConnection(workspaceId, 'read_products,write_products');

    // Case A: GraphQL userErrors
    const actErr = await seedShopifyCatalogAndAction(workspaceId, {
      actionId: 'act_user_err',
      field: 'variants[0].barcode',
      to: '4006381333931',
    });

    installShopifyGraphQLMock((query) => {
      assert.match(query, /productVariantsBulkUpdate/);
      return {
        body: {
          data: {
            productVariantsBulkUpdate: {
              product: { id: actErr.shopifyProductGid },
              productVariants: [],
              userErrors: [{ field: ['barcode'], message: 'Barcode rejected by store policy' }],
            },
          },
        },
      };
    });

    const userErrRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actErr.actionId}`);
    assert.equal(userErrRes.status, 422);
    assert.equal(userErrRes.body.code, 'SHOPIFY_USER_ERROR');
    assert.equal(userErrRes.body.operation.status, 'failed');

    const catalogAfterErr = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catalogAfterErr?.actions[0].status, 'approved');

    // Case B: Mutation succeeds, read-back returns old value -> 502 WRITEBACK_READBACK_MISMATCH
    const actMismatch = await seedShopifyCatalogAndAction(workspaceId, {
      actionId: 'act_mismatch_wb',
      field: 'variants[0].barcode',
      to: '4006381333931',
    });

    installShopifyGraphQLMock((query) => {
      if (query.includes('productVariantsBulkUpdate')) {
        return {
          body: {
            data: {
              productVariantsBulkUpdate: {
                product: { id: actMismatch.shopifyProductGid },
                productVariants: [
                  { id: actMismatch.shopifyVariantGid, barcode: '4006381333931', sku: 'KETTLE-01', price: '89.00' },
                ],
                userErrors: [],
              },
            },
          },
        };
      }
      return {
        body: {
          data: {
            product: {
              id: actMismatch.shopifyProductGid,
              title: 'Artisan Pour-Over Kettle',
              variants: {
                edges: [
                  {
                    node: {
                      id: actMismatch.shopifyVariantGid,
                      barcode: '0000000000000', // mismatch!
                      sku: 'KETTLE-01',
                      price: '89.00',
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });

    const mismatchRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actMismatch.actionId}`);
    assert.equal(mismatchRes.status, 502);
    assert.equal(mismatchRes.body.code, 'WRITEBACK_READBACK_MISMATCH');
    assert.equal(mismatchRes.body.operation.status, 'verification_failed');
    assert.equal(mismatchRes.body.operation.verifiedValue, '0000000000000');

    const catalogAfterMismatch = await repo.loadWorkspaceCatalog(workspaceId);
    assert.equal(catalogAfterMismatch?.actions[0].status, 'approved');
  });

  test('6. Succeeds with post-mutation read-back verification for barcode (including 429 backoff), sku, price, and title; enforces idempotency and redacts secrets', async () => {
    const { workspaceId, cookie, userId } = await registerWorkspace('success-all');
    await seedPaidGrowthSubscription(workspaceId);
    await seedShopifyConnection(workspaceId, 'read_products,write_products');

    // A: Barcode with HTTP 429 retry recovery
    const actBarcode = await seedShopifyCatalogAndAction(workspaceId, {
      actionId: 'act_wb_barcode',
      field: 'variants[0].barcode',
      to: '4006381333931',
    });

    const mockTracker = installShopifyGraphQLMock((query, _vars, attempt) => {
      if (attempt === 1) {
        return {
          status: 429,
          headers: { 'Retry-After': '0' },
          body: { errors: [{ message: 'Throttled' }] },
        };
      }
      if (query.includes('productVariantsBulkUpdate')) {
        return {
          body: {
            data: {
              productVariantsBulkUpdate: {
                product: { id: actBarcode.shopifyProductGid },
                productVariants: [
                  { id: actBarcode.shopifyVariantGid, barcode: '4006381333931', sku: 'KETTLE-01', price: '89.00' },
                ],
                userErrors: [],
              },
            },
          },
        };
      }
      return {
        body: {
          data: {
            product: {
              id: actBarcode.shopifyProductGid,
              title: 'Artisan Pour-Over Kettle',
              variants: {
                edges: [
                  {
                    node: {
                      id: actBarcode.shopifyVariantGid,
                      barcode: '4006381333931',
                      sku: 'KETTLE-01',
                      price: '89.00',
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });

    const barcodeRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actBarcode.actionId}`);
    assert.equal(barcodeRes.status, 200);
    assert.equal(barcodeRes.body.success, true);
    assert.equal(barcodeRes.body.operation.status, 'verified_applied');
    assert.equal(barcodeRes.body.operation.verifiedValue, '4006381333931');
    assert.equal(barcodeRes.body.action.status, 'applied_externally');
    assert.equal(barcodeRes.body.action.verificationStatus, 'verified_in_catalog');
    assert.equal(mockTracker.calls.length, 3); // 1 throttled + 1 mutation + 1 read-back
    assert.ok(
      Array.isArray(barcodeRes.body.action.auditLog) &&
        barcodeRes.body.action.auditLog.some((e: any) => e.event === 'shopify_writeback_verified'),
      'Action auditLog must record shopify_writeback_verified'
    );

    // Duplicate retry must reject 409 WRITEBACK_ALREADY_APPLIED
    const dupRes = await apiRequest(cookie, 'POST', `/api/shopify/write-back/${actBarcode.actionId}`);
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.body.code, 'WRITEBACK_ALREADY_APPLIED');

    // B: SKU, decimal-normalized Price, and Product Title via executeShopifyWriteBack directly
    const cases: Array<{ id: string; field: string; to: string; expected: string }> = [
      { id: 'act_wb_sku', field: 'variants[0].sku', to: 'KETTLE-V2-BLK', expected: 'KETTLE-V2-BLK' },
      { id: 'act_wb_price', field: 'variants[0].price', to: '94.5', expected: '94.50' },
      { id: 'act_wb_title', field: 'title', to: 'Artisan Gooseneck Kettle V2', expected: 'Artisan Gooseneck Kettle V2' },
    ];

    for (const c of cases) {
      const seeded = await seedShopifyCatalogAndAction(workspaceId, {
        actionId: c.id,
        field: c.field,
        to: c.to,
      });

      const res = await executeShopifyWriteBack(repo, {
        workspaceId,
        actionId: seeded.actionId,
        operatorUserId: userId,
        customFetch: (async (_url: any, init?: RequestInit) => {
          const parsed = JSON.parse(String(init?.body || '{}'));
          const q = parsed.query || '';
          if (q.includes('productUpdate')) {
            return new Response(
              JSON.stringify({
                data: {
                  productUpdate: {
                    product: { id: seeded.shopifyProductGid, title: c.expected },
                    userErrors: [],
                  },
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (q.includes('productVariantsBulkUpdate')) {
            return new Response(
              JSON.stringify({
                data: {
                  productVariantsBulkUpdate: {
                    product: { id: seeded.shopifyProductGid },
                    productVariants: [
                      {
                        id: seeded.shopifyVariantGid,
                        barcode: '4006381333931',
                        sku: c.field.endsWith('.sku') ? c.expected : 'KETTLE-01',
                        price: c.field.endsWith('.price') ? c.expected : '89.00',
                      },
                    ],
                    userErrors: [],
                  },
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              data: {
                product: {
                  id: seeded.shopifyProductGid,
                  title: c.field === 'title' ? c.expected : 'Artisan Pour-Over Kettle',
                  variants: {
                    edges: [
                      {
                        node: {
                          id: seeded.shopifyVariantGid,
                          barcode: '4006381333931',
                          sku: c.field.endsWith('.sku') ? c.expected : 'KETTLE-01',
                          price: c.field.endsWith('.price') ? c.expected : '89.00',
                        },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as typeof fetch,
      });

      assert.equal(res.operation.status, 'verified_applied');
      assert.equal(res.operation.verifiedValue, c.expected);
      assert.equal(res.action.status, 'applied_externally');
    }

    // History endpoint returns all operations cleanly without leaking Shopify access token
    const historyRes = await apiRequest(cookie, 'GET', '/api/shopify/write-back/history');
    assert.equal(historyRes.status, 200);
    assert.equal(historyRes.body.operations.length, 4);
    assert.equal(JSON.stringify(historyRes.body).includes(TEST_TOKEN_SECRET), false);
  });
});
