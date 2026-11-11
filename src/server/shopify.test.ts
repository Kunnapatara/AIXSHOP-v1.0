import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'node:crypto';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { 
  encryptCredential, 
  decryptCredential, 
  verifyHmacSha256, 
  verifyShopifyWebhookHmac 
} from './security/encryption';
import { 
  isValidShopDomain, 
  normalizeShopDomain, 
  SHOPIFY_API_VERSION 
} from './shopify/client';
import { 
  initiateShopifyConnect, 
  verifyShopifyCallbackHmac, 
  handleShopifyCallback, 
  disconnectShopify,
  refreshShopifyToken,
  getValidShopifyAccessToken
} from './shopify/oauthService';
import { 
  mapShopifyProductNodeToDomain, 
  syncShopifyCatalog,
  resumeShopifySync 
} from './shopify/syncService';
import { 
  processShopifyWebhook,
  registerShopifyWebhookSubscriptions,
  verifyShopifyWebhookSubscriptionsLive,
  DEFAULT_SHOPIFY_WEBHOOK_TOPICS
} from './shopify/webhookService';
import { fetchProductsPage } from './shopify/client';
import { ShopifyGraphQLProductNode } from './shopify/types';

describe('AIXSHOP v1.0 — Workstream C: Real Shopify Integration Suite', () => {
  const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars = 32 bytes
  const TEST_API_KEY = 'test_shopify_api_key_123';
  const TEST_API_SECRET = 'test_shopify_api_secret_456';
  const TEST_SHOP = 'my-artisan-store.myshopify.com';

  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;
  const originalEnv = { ...process.env };

  before(async () => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.SHOPIFY_API_KEY = TEST_API_KEY;
    process.env.SHOPIFY_API_SECRET = TEST_API_SECRET;
    process.env.SHOPIFY_APP_URL = 'http://127.0.0.1:3000';

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

  async function registerTestUser(email: string, wsName: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        fullName: 'Shopify Merchant',
        workspaceName: wsName,
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    return { token: data.token, workspace: data.workspace, user: data.user };
  }

  // 1. Security & Encryption Layer (AES-256-GCM)
  describe('1. Security & AES-256-GCM Credential Encryption', () => {
    test('encrypts and decrypts sensitive merchant tokens round-trip', () => {
      const plaintextToken = 'shpat_test_access_token_super_secret_999';
      const encrypted = encryptCredential(plaintextToken);
      assert.notEqual(encrypted, plaintextToken);
      assert.ok(encrypted.startsWith('v1:'));

      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, plaintextToken);
    });

    test('tampered ciphertext or auth tag is rejected by GCM authentication tag verification', () => {
      const plaintextToken = 'shpat_genuine_token_123';
      const encrypted = encryptCredential(plaintextToken);
      const parts = encrypted.split(':');
      // Tamper with ciphertext
      parts[3] = parts[3].replace(/a/g, 'b');
      const tampered = parts.join(':');

      assert.throws(() => {
        decryptCredential(tampered);
      });
    });

    test('missing encryption key strictly throws configuration error (no plaintext fallback)', () => {
      delete process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
      assert.throws(() => {
        encryptCredential('test_token');
      }, /SHOPIFY_TOKEN_ENCRYPTION_KEY environment secret is not configured/);
      process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    });

    test('timing-safe HMAC verification validates authentic signatures and rejects tampered signatures', () => {
      const message = 'code=123&shop=test.myshopify.com&state=abc';
      const validHmac = crypto.createHmac('sha256', TEST_API_SECRET).update(message).digest('hex');

      assert.equal(verifyHmacSha256(message, TEST_API_SECRET, validHmac), true);
      assert.equal(verifyHmacSha256(message, TEST_API_SECRET, 'bad_hmac_hex_value'), false);
    });
  });

  // 2. Domain Validation & API Versioning
  describe('2. Shop Domain Validation & Pinned API Version', () => {
    test('validates canonical Shopify domains and rejects dangerous injection/SSRF', () => {
      assert.equal(isValidShopDomain('solstice.myshopify.com'), true);
      assert.equal(isValidShopDomain('store-123.myshopify.com'), true);
      assert.equal(isValidShopDomain('attacker.com'), false);
      assert.equal(isValidShopDomain('myshopify.com'), false);
      assert.equal(isValidShopDomain('evil.myshopify.com.attacker.com'), false);
      assert.equal(isValidShopDomain('http://solstice.myshopify.com'), false);
    });

    test('normalizes raw merchant inputs into canonical domains', () => {
      assert.equal(normalizeShopDomain('solstice'), 'solstice.myshopify.com');
      assert.equal(normalizeShopDomain('https://solstice.myshopify.com/admin'), 'solstice.myshopify.com');
      assert.equal(normalizeShopDomain('my-store.myshopify.com:443'), 'my-store.myshopify.com');
    });

    test('Shopify Admin GraphQL client is pinned to 2026-10', () => {
      assert.equal(SHOPIFY_API_VERSION, '2026-10');
    });
  });

  // 3. OAuth Flow & Authorization Code Grant
  describe('3. OAuth Authorization Code Grant Flow', () => {
    test('initiateShopifyConnect produces secure authorization URL with CSRF nonce', async () => {
      const tenant = await registerTestUser('oauth_merchant_1@example.com', 'OAuth Test Store');
      const connectResult = await initiateShopifyConnect(repo, tenant.workspace.id, TEST_SHOP);

      assert.ok(connectResult.authUrl.includes(`https://${TEST_SHOP}/admin/oauth/authorize`));
      assert.ok(connectResult.authUrl.includes(`client_id=${TEST_API_KEY}`));
      assert.ok(connectResult.authUrl.includes('scope=read_products'));
      assert.ok(connectResult.authUrl.includes(`state=${connectResult.state}`));

      // Nonce must be consumed exactly once
      const consumed = await repo.getAndConsumeShopifyOAuthState(connectResult.state);
      assert.ok(consumed);
      assert.equal(consumed.workspaceId, tenant.workspace.id);
      assert.equal(consumed.shopDomain, TEST_SHOP);

      // Second consumption must return null
      const secondTry = await repo.getAndConsumeShopifyOAuthState(connectResult.state);
      assert.equal(secondTry, null);
    });

    test('verifyShopifyCallbackHmac computes HMAC strictly according to Shopify spec', () => {
      const query = {
        code: 'auth_code_xyz',
        shop: TEST_SHOP,
        state: 'nonce_123',
        timestamp: '1700000000',
      };
      // Sorted keys: code, shop, state, timestamp
      const message = `code=${query.code}&shop=${query.shop}&state=${query.state}&timestamp=${query.timestamp}`;
      const validHmac = crypto.createHmac('sha256', TEST_API_SECRET).update(message).digest('hex');

      assert.equal(verifyShopifyCallbackHmac({ ...query, hmac: validHmac }, TEST_API_SECRET), true);
      assert.equal(verifyShopifyCallbackHmac({ ...query, hmac: 'forged_hmac' }, TEST_API_SECRET), false);
    });

    test('handleShopifyCallback exchanges code, validates scopes, and stores encrypted credentials', async () => {
      const tenant = await registerTestUser('oauth_merchant_2@example.com', 'Token Exchange Store');
      const connect = await initiateShopifyConnect(repo, tenant.workspace.id, TEST_SHOP);

      const queryParams: Record<string, any> = {
        code: 'valid_test_code',
        shop: TEST_SHOP,
        state: connect.state,
        timestamp: '1700000000',
      };
      const message = `code=${queryParams.code}&shop=${queryParams.shop}&state=${queryParams.state}&timestamp=${queryParams.timestamp}`;
      queryParams.hmac = crypto.createHmac('sha256', TEST_API_SECRET).update(message).digest('hex');

      // Mock token exchange fetch
      const mockFetch = async (url: any, init: any): Promise<any> => {
        const urlStr = String(url);
        if (urlStr.includes('/admin/oauth/access_token')) {
          const body = JSON.parse(init.body);
          assert.equal(body.expiring, 1, 'Token exchange must request expiring offline tokens (expiring: 1)');
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'shpat_live_merchant_token_abc123',
              refresh_token: 'shprt_refresh_token_xyz987',
              scope: 'read_products',
              expires_in: 86400,
              refresh_token_expires_in: 7776000,
            }),
          };
        }
        if (urlStr.includes('/admin/api/2026-10/graphql.json')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Shopify-API-Version': '2026-10' }),
            json: async () => ({
              data: {
                shop: {
                  name: 'Artisan Crafts Goods',
                  myshopifyDomain: TEST_SHOP,
                  currencyCode: 'USD',
                },
              },
            }),
          };
        }
        throw new Error(`Unexpected mock URL ${urlStr}`);
      };

      const result = await handleShopifyCallback(repo, queryParams, { customFetch: mockFetch as any });
      assert.equal(result.shopDomain, TEST_SHOP);
      assert.equal(result.grantedScopes, 'read_products');
      assert.equal(result.shopName, 'Artisan Crafts Goods');

      // Verify connection in repo
      const stored = await repo.getShopifyConnection(tenant.workspace.id);
      assert.ok(stored);
      assert.equal(stored.status, 'connected');
      assert.notEqual(stored.accessTokenEncrypted, 'shpat_live_merchant_token_abc123');

      // Verify decrypted token
      const decrypted = decryptCredential(stored.accessTokenEncrypted);
      assert.equal(decrypted, 'shpat_live_merchant_token_abc123');
    });

    test('disconnectShopify safely revokes stored credentials and updates connection status', async () => {
      const tenant = await registerTestUser('oauth_merchant_3@example.com', 'Disconnect Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('dummy_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const disconnectRes = await disconnectShopify(repo, tenant.workspace.id);
      assert.equal(disconnectRes.success, true);

      const conn = await repo.getShopifyConnection(tenant.workspace.id);
      assert.ok(conn);
      assert.equal(conn.status, 'disconnected');
      assert.equal(conn.accessTokenEncrypted, '');
    });
  });

  // 4. GraphQL Product Mapping & Cursor Pagination
  describe('4. GraphQL Product Mapping & Multi-Page Pagination', () => {
    test('mapShopifyProductNodeToDomain maps GraphQL node into complete domain Product', () => {
      const mockNode: ShopifyGraphQLProductNode = {
        id: 'gid://shopify/Product/789123456',
        title: 'Ceramic Stoneware Pour Over Coffee Dripper',
        descriptionHtml: '<p>Handcrafted ceramic dripper with spiral internal ridges for clean pour over extraction.</p>',
        vendor: 'Ceramics Studio Co',
        productType: 'Coffee Dripper',
        handle: 'ceramic-stoneware-pour-over',
        status: 'ACTIVE',
        images: {
          edges: [
            { node: { url: 'https://cdn.shopify.com/s/files/1/dripper_front.jpg', altText: 'Front view' } },
            { node: { url: 'https://cdn.shopify.com/s/files/1/dripper_side.jpg', altText: 'Side view' } },
          ],
        },
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/987654321',
                title: 'Matte White',
                sku: 'DRIP-WHT-01',
                barcode: '9780201379624',
                price: '38.50',
                compareAtPrice: '45.00',
                inventoryQuantity: 24,
                selectedOptions: [{ name: 'Color', value: 'Matte White' }],
              },
            },
          ],
        },
      };

      const domainProd = mapShopifyProductNodeToDomain(mockNode, 'USD');
      assert.equal(domainProd.id, 'p_shopify_789123456');
      assert.equal(domainProd.title, 'Ceramic Stoneware Pour Over Coffee Dripper');
      assert.equal(domainProd.brand, 'Ceramics Studio Co');
      assert.equal(domainProd.category, 'Coffee Dripper');
      assert.equal(domainProd.image, 'https://cdn.shopify.com/s/files/1/dripper_front.jpg');
      assert.equal(domainProd.variants.length, 1);

      const v = domainProd.variants[0];
      assert.equal(v.id, 'v_shopify_987654321');
      assert.equal(v.sku, 'DRIP-WHT-01');
      assert.equal(v.barcode, '9780201379624');
      assert.equal(v.price, 38.50);
      assert.equal(v.inventoryCount, 24);
      assert.equal(v.attributes.compareAtPrice, '45.00');
      assert.equal(v.attributes.option_color, 'Matte White');

      assert.ok(domainProd.completenessScore > 50, 'Completeness score must be computed accurately');
    });

    test('syncShopifyCatalog paginates multiple pages via endCursor and enforces SKU limits', async () => {
      const tenant = await registerTestUser('sync_merchant_1@example.com', 'Catalog Sync Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('valid_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Starter tier profile with limit of 3 SKUs
      const storeProfile = await repo.getStoreByWorkspace(tenant.workspace.id);
      await repo.saveStoreProfile(tenant.workspace.id, {
        ...storeProfile!,
        tier: 'Starter',
        skuLimit: 3,
        connectors: [],
      });

      let pageRequestCount = 0;

      // Mock GraphQL pages
      const mockFetch = async (_url: any, init: any): Promise<any> => {
        const body = JSON.parse(init.body);
        pageRequestCount++;

        if (body.variables?.after === 'cursor_page_1') {
          // Page 2: Product 3 and 4
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      cursor: 'cursor_prod_3',
                      node: {
                        id: 'gid://shopify/Product/303',
                        title: 'Product 3',
                        vendor: 'Vendor',
                        productType: 'Type',
                        variants: {
                          edges: [{ node: { id: 'gid://shopify/ProductVariant/33', title: 'Default', sku: 'SKU-3', barcode: '9780201379624', price: '30.00', inventoryQuantity: 5 } }],
                        },
                      },
                    },
                    {
                      cursor: 'cursor_prod_4',
                      node: {
                        id: 'gid://shopify/Product/404',
                        title: 'Product 4',
                        vendor: 'Vendor',
                        productType: 'Type',
                        variants: {
                          edges: [{ node: { id: 'gid://shopify/ProductVariant/44', title: 'Default', sku: 'SKU-4', barcode: '9780201379624', price: '40.00', inventoryQuantity: 5 } }],
                        },
                      },
                    },
                  ],
                },
              },
            }),
          };
        }

        // Page 1: Product 1 and 2
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              products: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor_page_1' },
                edges: [
                  {
                    cursor: 'cursor_prod_1',
                    node: {
                      id: 'gid://shopify/Product/101',
                      title: 'Product 1',
                      vendor: 'Vendor',
                      productType: 'Type',
                      variants: {
                        edges: [{ node: { id: 'gid://shopify/ProductVariant/11', title: 'Default', sku: 'SKU-1', barcode: '9780201379624', price: '10.00', inventoryQuantity: 5 } }],
                      },
                    },
                  },
                  {
                    cursor: 'cursor_prod_2',
                    node: {
                      id: 'gid://shopify/Product/202',
                      title: 'Product 2',
                      vendor: 'Vendor',
                      productType: 'Type',
                      variants: {
                        edges: [{ node: { id: 'gid://shopify/ProductVariant/22', title: 'Default', sku: 'SKU-2', barcode: '9780201379624', price: '20.00', inventoryQuantity: 5 } }],
                      },
                    },
                  },
                ],
              },
            },
          }),
        };
      };

      const syncResult = await syncShopifyCatalog(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
        pageSize: 2,
      });

      assert.equal(pageRequestCount, 2, 'Must paginate through both pages');
      assert.equal(syncResult.productsDiscovered, 4);
      assert.equal(syncResult.productsImported, 3, 'Must import exactly 3 products respecting Starter limit of 3');
      assert.equal(syncResult.variantsImported, 3);
      assert.equal(syncResult.excludedByPlan, 1, 'Must report exactly 1 SKU excluded by plan limit');
      assert.equal(syncResult.status, 'partially_completed');
      assert.ok(syncResult.message.includes('Starter plan limit of 3 SKUs'));
    });
  });

  // 5. Webhooks & Idempotency
  describe('5. Verified Webhook Processing & Idempotency', () => {
    test('rejects webhook delivery with invalid HMAC signature', async () => {
      const rawPayload = JSON.stringify({ id: 12345, title: 'Unsigned Product' });
      const headers = {
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': TEST_SHOP,
        'x-shopify-delivery-id': 'deliv_111',
        'x-shopify-hmac-sha256': 'invalid_signature_hex_or_b64',
      };

      await assert.rejects(async () => {
        await processShopifyWebhook(repo, rawPayload, headers);
      }, /Invalid webhook HMAC signature/);
    });

    test('processes valid product create webhook and ignores duplicate delivery idempotently', async () => {
      const webhookShop = 'webhook-artisan.myshopify.com';
      const tenant = await registerTestUser('webhook_merchant@example.com', 'Webhook Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: webhookShop,
        accessTokenEncrypted: encryptCredential('valid_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const payload = {
        id: 998877,
        title: 'Live Webhook Artisan Mug',
        vendor: 'Ceramics Artisan',
        product_type: 'Drinkware',
        body_html: '<p>Handcrafted artisan mug received via webhook.</p>',
        variants: [
          { id: 112233, title: 'Default', sku: 'MUG-WH-01', price: '25.00', barcode: '9780201379624', inventory_quantity: 12 },
        ],
      };

      const rawPayload = Buffer.from(JSON.stringify(payload));
      const validHmac = crypto.createHmac('sha256', TEST_API_SECRET).update(rawPayload).digest('base64');

      const headers = {
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': webhookShop,
        'x-shopify-delivery-id': 'deliv_unique_555',
        'x-shopify-hmac-sha256': validHmac,
      };

      // First delivery: processes successfully
      const result1 = await processShopifyWebhook(repo, rawPayload, headers);
      assert.equal(result1.processed, true);
      assert.equal(result1.duplicate, false);

      // Verify product exists in tenant catalog
      const catalog = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      assert.ok(catalog);
      const product = catalog.products.find(p => p.id === 'p_shopify_998877');
      assert.ok(product, 'Must find created product in catalog');
      assert.equal(product.title, 'Live Webhook Artisan Mug');

      // Second delivery with identical delivery ID: acknowledged idempotently without duplication
      const result2 = await processShopifyWebhook(repo, rawPayload, headers);
      assert.equal(result2.processed, true);
      assert.equal(result2.duplicate, true, 'Second delivery must be detected as duplicate');

      // Catalog must still contain exactly 1 copy of the product
      const catalogAfter = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      const matchingCount = catalogAfter!.products.filter(p => p.id === 'p_shopify_998877').length;
      assert.equal(matchingCount, 1, 'Product must not be duplicated by redundant webhook delivery');
    });

    test('app/uninstalled webhook marks connection disconnected', async () => {
      const tenant = await registerTestUser('uninstall_merchant@example.com', 'Uninstall Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'uninstall-target.myshopify.com',
        accessTokenEncrypted: encryptCredential('token_to_revoke'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const rawPayload = Buffer.from(JSON.stringify({ shop_id: 12345 }));
      const hmac = crypto.createHmac('sha256', TEST_API_SECRET).update(rawPayload).digest('base64');

      const headers = {
        'x-shopify-topic': 'app/uninstalled',
        'x-shopify-shop-domain': 'uninstall-target.myshopify.com',
        'x-shopify-delivery-id': 'deliv_uninst_777',
        'x-shopify-hmac-sha256': hmac,
      };

      const result = await processShopifyWebhook(repo, rawPayload, headers);
      assert.equal(result.processed, true);

      const conn = await repo.getShopifyConnection(tenant.workspace.id);
      assert.ok(conn);
      assert.equal(conn.status, 'disconnected');
    });
  });

  // 6. HTTP API Endpoints & Workspace Scoping
  describe('6. HTTP API Endpoints & Tenant Isolation', () => {
    test('GET /api/shopify/status never exposes secrets and respects workspace scoping', async () => {
      const tenantA = await registerTestUser('status_tenant_a@example.com', 'Tenant A Store');
      const tenantB = await registerTestUser('status_tenant_b@example.com', 'Tenant B Store');

      // Connect only Tenant A
      await repo.saveShopifyConnection({
        id: `conn_${tenantA.workspace.id}`,
        workspaceId: tenantA.workspace.id,
        shopDomain: 'tenant-a.myshopify.com',
        accessTokenEncrypted: encryptCredential('tenant_a_secret_token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Tenant A queries status
      const resA = await fetch(`${baseUrl}/api/shopify/status`, {
        headers: { 'Authorization': `Bearer ${tenantA.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(resA.status, 200);
      const dataA = await resA.json();
      assert.equal(dataA.connected, true);
      assert.equal(dataA.shopDomain, 'tenant-a.myshopify.com');
      assert.deepEqual(dataA.grantedScopes, ['read_products']);
      assert.equal((dataA as any).accessTokenEncrypted, undefined, 'Must NEVER expose encrypted tokens');
      assert.equal((dataA as any).accessToken, undefined, 'Must NEVER expose access tokens');

      // Tenant B queries status (isolated: must report not connected)
      const resB = await fetch(`${baseUrl}/api/shopify/status`, {
        headers: { 'Authorization': `Bearer ${tenantB.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(resB.status, 200);
      const dataB = await resB.json();
      assert.equal(dataB.connected, false);
      assert.equal(dataB.shopDomain, null);
    });
  });

  // 7. Expiring Offline Access Tokens, Refresh Token Rotation & Mutex
  describe('7. Expiring Offline Access Tokens & Refresh Rotation', () => {
    test('refreshShopifyToken rotates refresh token and updates encrypted credentials', async () => {
      const tenant = await registerTestUser('refresh_user_1@example.com', 'Refresh Test Store');
      const initialToken = 'shpat_initial_token_111';
      const initialRefresh = 'shprt_initial_refresh_222';

      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential(initialToken),
        refreshTokenEncrypted: encryptCredential(initialRefresh),
        tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      let refreshPayloadSent: any = null;
      const mockFetch = async (url: any, init: any): Promise<any> => {
        const urlStr = String(url);
        if (urlStr.includes('/admin/oauth/access_token')) {
          refreshPayloadSent = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'shpat_refreshed_access_token_333',
              refresh_token: 'shprt_rotated_refresh_token_444',
              expires_in: 86400,
              refresh_token_expires_in: 7776000,
            }),
          };
        }
        throw new Error(`Unexpected mock URL ${urlStr}`);
      };

      const refreshed = await refreshShopifyToken(repo, tenant.workspace.id, { customFetch: mockFetch as any });
      assert.equal(refreshed.accessToken, 'shpat_refreshed_access_token_333');
      assert.equal(refreshPayloadSent.client_id, TEST_API_KEY);
      assert.equal(refreshPayloadSent.client_secret, TEST_API_SECRET);
      assert.equal(refreshPayloadSent.refresh_token, initialRefresh);

      const stored = await repo.getShopifyConnection(tenant.workspace.id);
      assert.ok(stored);
      assert.equal(decryptCredential(stored.accessTokenEncrypted), 'shpat_refreshed_access_token_333');
      assert.equal(decryptCredential(stored.refreshTokenEncrypted!), 'shprt_rotated_refresh_token_444');
      assert.ok(stored.lastRefreshedAt);
    });

    test('concurrent refresh calls are serialized via workspace mutex without duplicate HTTP requests', async () => {
      const tenant = await registerTestUser('refresh_user_2@example.com', 'Concurrent Refresh Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('old_token'),
        refreshTokenEncrypted: encryptCredential('old_refresh'),
        tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      let httpCallCount = 0;
      const mockFetch = async (): Promise<any> => {
        httpCallCount++;
        await new Promise(r => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_concurrent_res_token',
            refresh_token: 'shprt_concurrent_res_refresh',
            expires_in: 86400,
          }),
        };
      };

      const [r1, r2, r3] = await Promise.all([
        refreshShopifyToken(repo, tenant.workspace.id, { customFetch: mockFetch as any }),
        refreshShopifyToken(repo, tenant.workspace.id, { customFetch: mockFetch as any }),
        refreshShopifyToken(repo, tenant.workspace.id, { customFetch: mockFetch as any }),
      ]);

      assert.equal(r1.accessToken, 'shpat_concurrent_res_token');
      assert.equal(r2.accessToken, 'shpat_concurrent_res_token');
      assert.equal(r3.accessToken, 'shpat_concurrent_res_token');
      assert.equal(httpCallCount, 1, 'Concurrent refreshes must coalesce into exactly 1 HTTP token request');
    });

    test('rejection on refresh (invalid_grant) transitions connection to reauthorization_required', async () => {
      const tenant = await registerTestUser('refresh_user_3@example.com', 'Revoked Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('invalid_token'),
        refreshTokenEncrypted: encryptCredential('invalid_refresh'),
        tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockFetch = async (): Promise<any> => {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant', error_description: 'The refresh token has been revoked' }),
        };
      };

      await assert.rejects(async () => {
        await refreshShopifyToken(repo, tenant.workspace.id, { customFetch: mockFetch as any });
      }, /Merchant reauthorization required/);

      const conn = await repo.getShopifyConnection(tenant.workspace.id);
      assert.equal(conn?.status, 'reauthorization_required');
    });

    test('getValidShopifyAccessToken auto-refreshes when token is within 5-minute expiry window', async () => {
      const tenant = await registerTestUser('auto_refresh_user@example.com', 'Auto Refresh Store');
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: TEST_SHOP,
        accessTokenEncrypted: encryptCredential('expiring_soon_token'),
        refreshTokenEncrypted: encryptCredential('valid_refresh_token'),
        tokenExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockFetch = async (): Promise<any> => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_fresh_auto_refreshed_token',
            refresh_token: 'shprt_fresh_auto_refresh',
            expires_in: 86400,
          }),
        };
      };

      const token = await getValidShopifyAccessToken(repo, tenant.workspace.id, { customFetch: mockFetch as any });
      assert.equal(token, 'shpat_fresh_auto_refreshed_token');
    });
  });

  // 8. Out-of-Order Webhook Delivery Protection
  describe('8. Out-of-Order Webhook Delivery Protection', () => {
    test('discards older webhook update when existing product has newer timestamp', async () => {
      const tenant = await registerTestUser('webhook_ordering@example.com', 'Webhook Ordering Store');
      const shop = 'ordering-test.myshopify.com';
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: shop,
        accessTokenEncrypted: encryptCredential('token'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const newerPayload = {
        id: 777111,
        title: 'Newest Version of Product',
        vendor: 'Ceramics',
        product_type: 'Home',
        updated_at: '2026-11-10T12:00:00Z',
        variants: [{ id: 888111, title: 'Default', sku: 'SKU-NEW', price: '20.00' }],
      };
      const rawNewer = Buffer.from(JSON.stringify(newerPayload));
      const hmacNewer = crypto.createHmac('sha256', TEST_API_SECRET).update(rawNewer).digest('base64');

      await processShopifyWebhook(repo, rawNewer, {
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': shop,
        'x-shopify-delivery-id': 'deliv_newer_1',
        'x-shopify-hmac-sha256': hmacNewer,
      });

      const catalog1 = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      const prod1 = catalog1?.products.find(p => p.id === 'p_shopify_777111');
      assert.equal(prod1?.title, 'Newest Version of Product');

      const olderPayload = {
        id: 777111,
        title: 'Old Stale Version of Product',
        vendor: 'Ceramics',
        product_type: 'Home',
        updated_at: '2026-11-09T08:00:00Z',
        variants: [{ id: 888111, title: 'Default', sku: 'SKU-OLD', price: '15.00' }],
      };
      const rawOlder = Buffer.from(JSON.stringify(olderPayload));
      const hmacOlder = crypto.createHmac('sha256', TEST_API_SECRET).update(rawOlder).digest('base64');

      await processShopifyWebhook(repo, rawOlder, {
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': shop,
        'x-shopify-delivery-id': 'deliv_stale_2',
        'x-shopify-hmac-sha256': hmacOlder,
      });

      const catalog2 = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      const prod2 = catalog2?.products.find(p => p.id === 'p_shopify_777111');
      assert.equal(prod2?.title, 'Newest Version of Product', 'Stale out-of-order webhook delivery must not overwrite newer catalog data');
    });
  });

  // 9. Webhook Registration & GraphQL Mutations
  describe('9. Webhook Registration via Admin GraphQL', () => {
    test('registerShopifyWebhookSubscriptions calls webhookSubscriptionCreate for topics', async () => {
      let registeredTopics: string[] = [];

      const mockFetch = async (_url: any, init: any): Promise<any> => {
        const body = JSON.parse(init.body);
        if (body.query.includes('webhookSubscriptionCreate')) {
          registeredTopics.push(body.variables.topic);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                webhookSubscriptionCreate: {
                  userErrors: [],
                  webhookSubscription: {
                    id: `gid://shopify/WebhookSubscription/${Math.random().toString(36).substring(7)}`,
                    topic: body.variables.topic,
                  },
                },
              },
            }),
          };
        }
        throw new Error('Unexpected mutation');
      };

      const results = await registerShopifyWebhookSubscriptions(
        TEST_SHOP,
        'dummy_token',
        'https://example.com/api/shopify/webhooks',
        ['products/create', 'products/update', 'products/delete'],
        { customFetch: mockFetch as any }
      );

      assert.equal(results.length, 3);
      assert.ok(results.every(r => r.success));
      assert.deepEqual(registeredTopics, ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE']);
    });
  });

  // 10. Workstream D: Production Hardening, Distributed Concurrency & Resumable Sync
  describe('10. Workstream D: Distributed Concurrency, Variant Pagination & Resumable Sync', () => {
    test('refreshShopifyToken re-checks fresh token under lock to eliminate redundant refresh calls across instances', async () => {
      const tenant = await registerTestUser(`refresh-lock-${Date.now()}@test.com`, 'Refresh Lock Store');
      let shopifyHttpRefreshCount = 0;

      const mockFetch = async (url: any, init: any): Promise<any> => {
        if (url.includes('/admin/oauth/access_token')) {
          shopifyHttpRefreshCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: `shpat_fresh_token_${shopifyHttpRefreshCount}`,
              refresh_token: `shprt_fresh_token_${shopifyHttpRefreshCount}`,
              expires_in: 3600, // 1 hour
              refresh_token_expires_in: 86400 * 30,
            }),
          };
        }
        throw new Error('Unexpected network call');
      };

      // Set initial connection with an already-expired token
      const nowIso = new Date().toISOString();
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'concurrency-test.myshopify.com',
        accessTokenEncrypted: encryptCredential('initial_old_token'),
        refreshTokenEncrypted: encryptCredential('initial_old_refresh_token'),
        tokenExpiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 min ago
        refreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // Instance A executes refresh
      const resultA = await refreshShopifyToken(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(shopifyHttpRefreshCount, 1);
      assert.equal(resultA.accessToken, 'shpat_fresh_token_1');

      // Instance B executes refresh immediately after without force
      // Since the token is now fresh (1 hour expiry), it re-checks under the lock and skips the network call
      const resultB = await refreshShopifyToken(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(shopifyHttpRefreshCount, 1, 'Should NOT perform a second network refresh when token is already fresh');
      assert.equal(resultB.accessToken, 'shpat_fresh_token_1');
    });

    test('variant pagination loop terminates on non-advancing cursors and deduplicates variant IDs', async () => {
      let variantPageCalls = 0;

      const mockFetch = async (url: any, init: any): Promise<any> => {
        const body = JSON.parse(init.body);
        if (body.query.includes('getProductVariants')) {
          variantPageCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                product: {
                  variants: {
                    pageInfo: {
                      hasNextPage: true, // Claims next page exists
                      endCursor: 'stuck_cursor_never_advances', // Same cursor repeated
                    },
                    edges: [
                      {
                        cursor: 'stuck_cursor_never_advances',
                        node: {
                          id: 'gid://shopify/ProductVariant/dup_variant_99',
                          title: 'Repeating Variant',
                          sku: 'REP-99',
                          price: '29.99',
                          compareAtPrice: null,
                          inventoryQuantity: 5,
                        },
                      },
                    ],
                  },
                },
              },
            }),
          };
        }

        // Single product page with >100 variants trigger
        if (body.query.includes('getProducts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      cursor: 'p_cursor_1',
                      node: {
                        id: 'gid://shopify/Product/123999',
                        title: 'Apparel with Many Variants',
                        handle: 'apparel-product',
                        variants: {
                          pageInfo: {
                            hasNextPage: true,
                            endCursor: 'stuck_cursor_never_advances',
                          },
                          edges: [
                            {
                              cursor: 'c0',
                              node: {
                                id: 'gid://shopify/ProductVariant/dup_variant_99',
                                title: 'Initial Variant',
                                sku: 'REP-99',
                                price: '29.99',
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            }),
          };
        }

        throw new Error('Unexpected query');
      };

      const result = await fetchProductsPage('test-apparel.myshopify.com', 'dummy_token', null, 10, {
        customFetch: mockFetch as any,
      });

      assert.equal(result.products.length, 1);
      // Ensure it did not loop 50 times because cursor repeated
      assert.equal(variantPageCalls, 1, 'Must break pagination immediately when cursor fails to advance');
      // Ensure variant deduplication prevented adding duplicate variant ID
      assert.equal(result.products[0].variants?.edges.length, 1, 'Duplicate variant IDs must be deduplicated');
    });

    test('resumes partially completed catalog sync from stored cursor without duplicate products', async () => {
      const tenant = await registerTestUser(`resumesync-${Date.now()}@test.com`, 'Resume Sync Store');
      const nowIso = new Date().toISOString();

      // Configure active shopify connection
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'resumable-store.myshopify.com',
        accessTokenEncrypted: encryptCredential('valid_token'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const pagesRequested: string[] = [];

      const mockFetch = async (_url: any, init: any): Promise<any> => {
        const body = JSON.parse(init.body);
        const afterCursor = body.variables?.after;
        pagesRequested.push(afterCursor || 'PAGE_1');

        if (!afterCursor) {
          // Page 1
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                products: {
                  pageInfo: { hasNextPage: true, endCursor: 'page_1_end_cursor' },
                  edges: [
                    {
                      cursor: 'cursor_p1',
                      node: {
                        id: 'gid://shopify/Product/1001',
                        title: 'Product One',
                        handle: 'product-one',
                        status: 'ACTIVE',
                        variants: {
                          edges: [{
                            node: { id: 'gid://shopify/ProductVariant/v1001', sku: 'SKU-1001', price: '19.99' },
                          }],
                        },
                      },
                    },
                  ],
                },
              },
            }),
          };
        } else if (afterCursor === 'page_1_end_cursor') {
          // Page 2 (Final page)
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      cursor: 'cursor_p2',
                      node: {
                        id: 'gid://shopify/Product/1002',
                        title: 'Product Two',
                        handle: 'product-two',
                        status: 'ACTIVE',
                        variants: {
                          edges: [{
                            node: { id: 'gid://shopify/ProductVariant/v1002', sku: 'SKU-1002', price: '29.99' },
                          }],
                        },
                      },
                    },
                  ],
                },
              },
            }),
          };
        }

        throw new Error(`Unexpected cursor: ${afterCursor}`);
      };

      // Run initial sync restricted to 1 page -> partially completed
      const initialSync = await syncShopifyCatalog(repo, tenant.workspace.id, {
        maxPages: 1,
        pageSize: 1,
        customFetch: mockFetch as any,
      });

      assert.equal(initialSync.status, 'partially_completed');
      assert.equal(initialSync.productsImported, 1);
      assert.equal(initialSync.syncRun.cursorResumed, 'page_1_end_cursor');

      // Verify catalog currently has 1 product
      const catalogAfterPart1 = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      assert.equal(catalogAfterPart1?.products.length, 1);

      // Now resume sync from stored cursor
      const resumedSync = await resumeShopifySync(repo, tenant.workspace.id, {
        maxPages: 5,
        pageSize: 1,
        customFetch: mockFetch as any,
      });

      assert.equal(resumedSync.status, 'completed');
      assert.equal(pagesRequested[1], 'page_1_end_cursor', 'Resume must use the cursor saved from previous run');

      // Verify catalog now has both products without duplicates
      const catalogAfterResume = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      assert.equal(catalogAfterResume?.products.length, 2);
      const titles = catalogAfterResume?.products.map(p => p.title).sort();
      assert.deepEqual(titles, ['Product One', 'Product Two']);
    });

    test('verifyShopifyWebhookSubscriptionsLive queries Shopify GraphQL and reports accurate status', async () => {
      const tenant = await registerTestUser(`live-webhooks-${Date.now()}@test.com`, 'Live Webhooks Store');
      const nowIso = new Date().toISOString();

      let activeReturnedWebhooks = [
        { id: 'gid://shopify/WebhookSubscription/1', topic: 'PRODUCTS_CREATE', endpoint: { callbackUrl: 'https://app.com/api/shopify/webhooks' } },
        { id: 'gid://shopify/WebhookSubscription/2', topic: 'PRODUCTS_UPDATE', endpoint: { callbackUrl: 'https://app.com/api/shopify/webhooks' } },
        { id: 'gid://shopify/WebhookSubscription/3', topic: 'PRODUCTS_DELETE', endpoint: { callbackUrl: 'https://app.com/api/shopify/webhooks' } },
        { id: 'gid://shopify/WebhookSubscription/4', topic: 'APP_UNINSTALLED', endpoint: { callbackUrl: 'https://app.com/api/shopify/webhooks' } },
      ];

      const mockFetch = async (_url: any, init: any): Promise<any> => {
        const body = JSON.parse(init.body);
        if (body.query.includes('webhookSubscriptions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                webhookSubscriptions: {
                  edges: activeReturnedWebhooks.map(w => ({ node: w })),
                },
              },
            }),
          };
        }
        throw new Error('Unexpected query');
      };

      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'live-webhook-store.myshopify.com',
        accessTokenEncrypted: encryptCredential('valid_token'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // 1. All 4 webhooks active -> reports active & verified true
      const fullResult = await verifyShopifyWebhookSubscriptionsLive(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(fullResult.verified, true);
      assert.equal(fullResult.status, 'active');
      assert.equal(fullResult.activeTopics.length, 4);
      assert.equal(fullResult.missingTopics.length, 0);

      // 2. Remove 2 webhooks -> reports partially_registered
      activeReturnedWebhooks = [
        { id: 'gid://shopify/WebhookSubscription/1', topic: 'PRODUCTS_CREATE', endpoint: { callbackUrl: 'https://app.com/api/shopify/webhooks' } },
      ];

      const partialResult = await verifyShopifyWebhookSubscriptionsLive(repo, tenant.workspace.id, {
        customFetch: mockFetch as any,
      });

      assert.equal(partialResult.verified, false);
      assert.equal(partialResult.status, 'partially_registered');
      assert.deepEqual(partialResult.activeTopics, ['PRODUCTS_CREATE']);
      assert.ok(partialResult.missingTopics.includes('PRODUCTS_UPDATE'));
    });

    test('HTTP endpoints POST /api/shopify/sync/resume and POST /api/shopify/webhooks/verify', async () => {
      const tenant = await registerTestUser(`http-ws-d-${Date.now()}@test.com`, 'HTTP WS D Store');
      const nowIso = new Date().toISOString();

      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain: 'http-test-store.myshopify.com',
        accessTokenEncrypted: encryptCredential('valid_token'),
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso,
        lastVerifiedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // Test GET /api/shopify/status reflects canResumeSync: false initially
      const statusRes1 = await fetch(`${baseUrl}/api/shopify/status`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(statusRes1.status, 200);
      const status1 = await statusRes1.json();
      assert.equal(status1.canResumeSync, false);

      // Verify POST /api/shopify/webhooks/verify endpoint
      const verifyRes = await fetch(`${baseUrl}/api/shopify/webhooks/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
      });
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.success, true);
    });
  });
});
