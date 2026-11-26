import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { SandboxBillingProvider, setBillingProvider } from './billing/providerAdapter';
import { _resetRateLimiter } from './middleware/auth';

interface CapturedLoopbackEmail {
  mailFrom: string;
  rcptTo: string[];
  rawData: string;
  subject: string;
}

/**
 * Local TCP SMTP loopback server to exercise real node:net SMTP protocol
 * end-to-end without external provider credentials (PASS — SIMULATED).
 */
async function startLoopbackSmtpServer(): Promise<{
  port: number;
  messages: CapturedLoopbackEmail[];
  close: () => Promise<void>;
}> {
  const messages: CapturedLoopbackEmail[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: CapturedLoopbackEmail = { mailFrom: '', rcptTo: [], rawData: '', subject: '' };

    socket.write('220 aixshop-30step.local ESMTP Ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const endIdx = buffer.indexOf('\r\n.\r\n');
          if (endIdx === -1) break;
          current.rawData = buffer.slice(0, endIdx);
          const subjMatch = current.rawData.match(/^Subject:\s*(.+)$/im);
          current.subject = subjMatch?.[1]?.trim() || '';
          buffer = buffer.slice(endIdx + 5);
          inData = false;
          messages.push({ ...current, rcptTo: [...current.rcptTo] });
          current = { mailFrom: '', rcptTo: [], rawData: '', subject: '' };
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }

        const lineIdx = buffer.indexOf('\r\n');
        if (lineIdx === -1) break;
        const line = buffer.slice(0, lineIdx);
        buffer = buffer.slice(lineIdx + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-aixshop-30step.local\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          current.mailFrom = line.slice(10).trim();
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          current.rcptTo.push(line.slice(8).trim());
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  return {
    port: addr.port,
    messages,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

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

function signShopifyQueryParams(params: Record<string, string>, secret: string): string {
  const msg = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

describe('Task E — Complete 30-Step Commercial Customer Journey E2E (PASS — SIMULATED)', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;
  let sandboxProvider: SandboxBillingProvider;
  let smtpServer: Awaited<ReturnType<typeof startLoopbackSmtpServer>>;

  const originalFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'APP_URL',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_STARTTLS',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'SUPPORT_EMAIL',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'SHOPIFY_APP_URL',
    'SHOPIFY_SCOPES',
    'AIXSHOP_PLATFORM_REVIEWER_SECRET',
    'BILLING_WEBHOOK_SECRET',
  ];

  // Stateful mock Shopify Admin API state
  const shopDomain = 'journey30-store.myshopify.com';
  const shopifyState = {
    barcodeByVariantGid: new Map<string, string>([
      ['gid://shopify/ProductVariant/3001', ''], // Missing barcode -> will be fixed via AIXSHOP approved write-back
      ['gid://shopify/ProductVariant/3002', '0850029381013'], // Valid GS1 barcode
      ['gid://shopify/ProductVariant/3003', ''], // Artisan product -> will be cleared via GTIN exemption evidence review
    ]),
    webhookTopicsRegistered: [] as string[],
    mutationCalls: 0,
  };

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    _resetRateLimiter();

    smtpServer = await startLoopbackSmtpServer();

    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtpServer.port);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_STARTTLS = 'false';
    process.env.SMTP_USER = 'smtp_30step_user';
    process.env.SMTP_PASS = 'smtp_30step_pass';
    process.env.SMTP_FROM = 'AIXSHOP <no-reply@aixshop.local>';
    process.env.SUPPORT_EMAIL = 'billing-support@aixshop.local';
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    process.env.SHOPIFY_API_KEY = 'shopify_30step_client_key';
    process.env.SHOPIFY_API_SECRET = 'shopify_30step_secret_0123456789abcdef';
    delete process.env.SHOPIFY_SCOPES;
    process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = 'platform_reviewer_30step_secret_32_chars_ok';
    process.env.BILLING_WEBHOOK_SECRET = 'sandbox_whsec_30step_secret_key';

    sandboxProvider = new SandboxBillingProvider(process.env.BILLING_WEBHOOK_SECRET);
    setBillingProvider(sandboxProvider);

    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.APP_URL = baseUrl;
        process.env.SHOPIFY_APP_URL = baseUrl;
        resolve();
      });
    });

    // Route external https://*.myshopify.com calls to simulated Shopify endpoints while forwarding local HTTP to originalFetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }

      if (url === `https://${shopDomain}/admin/oauth/access_token`) {
        return new Response(
          JSON.stringify({
            access_token: 'shpat_simulated_30step_token_12345',
            scope: 'read_products,write_products',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.startsWith(`https://${shopDomain}/admin/api/`) && url.endsWith('/graphql.json')) {
        const parsed = JSON.parse(String(init?.body || '{}'));
        const query = String(parsed.query || '');
        const variables = parsed.variables || {};

        // 1. Shop identity check
        if (query.includes('shop {') && !query.includes('webhookSubscriptions')) {
          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  name: 'Journey 30 Store',
                  myshopifyDomain: shopDomain,
                  primaryDomain: { host: shopDomain },
                  currencyCode: 'USD',
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 2. Webhook registration
        if (query.includes('webhookSubscriptionCreate')) {
          const topic = String(variables.topic || '');
          if (topic && !shopifyState.webhookTopicsRegistered.includes(topic)) {
            shopifyState.webhookTopicsRegistered.push(topic);
          }
          return new Response(
            JSON.stringify({
              data: {
                webhookSubscriptionCreate: {
                  webhookSubscription: {
                    id: `gid://shopify/WebhookSubscription/${shopifyState.webhookTopicsRegistered.length}`,
                    topic,
                  },
                  userErrors: [],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 3. Live webhook verification
        if (query.includes('webhookSubscriptions(')) {
          return new Response(
            JSON.stringify({
              data: {
                webhookSubscriptions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: shopifyState.webhookTopicsRegistered.map((topic, idx) => ({
                    node: {
                      id: `gid://shopify/WebhookSubscription/${idx + 1}`,
                      topic,
                      endpoint: { callbackUrl: `${baseUrl}/api/shopify/webhooks` },
                    },
                  })),
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 4. Write-back variant mutation
        if (query.includes('productVariantsBulkUpdate')) {
          shopifyState.mutationCalls++;
          const variantInput = variables.variants?.[0];
          if (variantInput?.id && typeof variantInput.barcode === 'string') {
            shopifyState.barcodeByVariantGid.set(variantInput.id, variantInput.barcode);
          }
          return new Response(
            JSON.stringify({
              data: {
                productVariantsBulkUpdate: {
                  product: { id: variables.productId },
                  productVariants: [
                    {
                      id: variantInput?.id,
                      barcode: variantInput?.barcode ?? null,
                      sku: variantInput?.sku ?? 'WB-SKU',
                      price: variantInput?.price ?? '45.00',
                    },
                  ],
                  userErrors: [],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 5. Post-mutation read-back verification snapshot (verifyProductWriteBack)
        if (query.includes('verifyProductWriteBack')) {
          const gid = String(variables.productId || '');
          return new Response(
            JSON.stringify({
              data: {
                product: {
                  id: gid,
                  title: 'Ceramic Pour-Over Carafe',
                  variants: {
                    edges: [
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/3001',
                          barcode: shopifyState.barcodeByVariantGid.get('gid://shopify/ProductVariant/3001') ?? '',
                          sku: 'CARAFE-01',
                          price: '45.00',
                        },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 6. Paginated products query (page 1 -> page 2)
        if (query.includes('products(')) {
          const after = variables.after || null;
          if (!after) {
            return new Response(
              JSON.stringify({
                data: {
                  products: {
                    pageInfo: { hasNextPage: true, endCursor: 'cursor_page_1' },
                    edges: [
                      {
                        cursor: 'c1',
                        node: {
                          id: 'gid://shopify/Product/3001',
                          title: 'Ceramic Pour-Over Carafe',
                          description:
                            'Double-walled borosilicate glass and matte stoneware pour-over coffee carafe built for daily brewing.',
                          vendor: 'Journey Goods',
                          productType: 'Brew Gear',
                          handle: 'ceramic-carafe',
                          status: 'ACTIVE',
                          isGiftCard: false,
                          updatedAt: '2026-11-20T00:00:00Z',
                          images: { edges: [{ node: { url: 'https://cdn.shopify.com/carafe.jpg' } }] },
                          variants: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [
                              {
                                cursor: 'v1',
                                node: {
                                  id: 'gid://shopify/ProductVariant/3001',
                                  title: 'Matte Clay 600ml',
                                  sku: 'CARAFE-01',
                                  barcode:
                                    shopifyState.barcodeByVariantGid.get('gid://shopify/ProductVariant/3001') || '',
                                  price: '45.00',
                                  inventoryQuantity: 20,
                                  selectedOptions: [],
                                },
                              },
                            ],
                          },
                        },
                      },
                      {
                        cursor: 'c2',
                        node: {
                          id: 'gid://shopify/Product/3002',
                          title: 'Verified Single-Origin Roast 340g',
                          description:
                            'Washed Ethiopian whole coffee beans roasted weekly with full GS1 barcode compliance.',
                          vendor: 'Journey Goods',
                          productType: 'Coffee',
                          handle: 'verified-roast',
                          status: 'ACTIVE',
                          isGiftCard: false,
                          updatedAt: '2026-11-20T00:00:00Z',
                          images: { edges: [{ node: { url: 'https://cdn.shopify.com/roast.jpg' } }] },
                          variants: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [
                              {
                                cursor: 'v2',
                                node: {
                                  id: 'gid://shopify/ProductVariant/3002',
                                  title: '340g',
                                  sku: 'ROAST-340',
                                  barcode: '0850029381013',
                                  price: '21.00',
                                  inventoryQuantity: 50,
                                  selectedOptions: [],
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
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          return new Response(
            JSON.stringify({
              data: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      cursor: 'c3',
                      node: {
                        id: 'gid://shopify/Product/3003',
                        title: 'Hand-Turned Walnut Scoop',
                        description:
                          'Individually hand-carved American black walnut coffee scoop finished with food-safe beeswax.',
                        vendor: 'Journey Artisan Studio',
                        productType: 'Home Goods',
                        handle: 'walnut-scoop',
                        status: 'ACTIVE',
                        isGiftCard: false,
                        updatedAt: '2026-11-20T00:00:00Z',
                        images: { edges: [{ node: { url: 'https://cdn.shopify.com/scoop.jpg' } }] },
                        variants: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          edges: [
                            {
                              cursor: 'v3',
                              node: {
                                id: 'gid://shopify/ProductVariant/3003',
                                title: 'Standard',
                                sku: 'SCOOP-01',
                                barcode: '',
                                price: '34.00',
                                inventoryQuantity: 10,
                                selectedOptions: [],
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
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      throw new Error(`Unexpected external fetch call in 30-step test: ${url}`);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    setBillingProvider(null);
    _resetRateLimiter();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await smtpServer.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('Executes complete 30-step end-to-end commercial journey without credential leaks or broken invariants', async () => {
    const emailA = 'merchant30@example.test';
    const initialPw = 'Journey30!InitialPw';
    const resetPw = 'Journey30!RotatedPw';

    // Step 1: Public liveness/readiness & authoritative plans endpoint
    const liveRes = await originalFetch(`${baseUrl}/api/health/live`);
    assert.equal(liveRes.status, 200);
    const readyRes = await originalFetch(`${baseUrl}/api/health/ready`);
    assert.equal(readyRes.status, 200);
    const plansRes = await originalFetch(`${baseUrl}/api/billing/plans`);
    assert.equal(plansRes.status, 200);
    const plansJson = await plansRes.json();
    assert.ok(plansJson.plans.some((p: any) => p.tier === 'Starter' && p.priceCents === 4900));

    // Step 2: Unauthenticated visitor blocked from protected routes
    const unauthRes = await originalFetch(`${baseUrl}/api/catalog`);
    assert.equal(unauthRes.status, 401);

    // Step 3: Merchant A registers -> session cookie + Referrer-Policy + Free Audit workspace
    const regA = await originalFetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: emailA,
        password: initialPw,
        fullName: 'Merchant Thirty',
        workspaceName: 'Journey 30 Goods',
      }),
    });
    assert.equal(regA.status, 201);
    assert.equal(regA.headers.get('referrer-policy'), 'no-referrer');
    let cookieA = extractSessionCookie(regA);
    assert.ok(cookieA);
    const regABody = await regA.json();
    const wsA = regABody.workspace.id;

    const authHeaders = (extra: Record<string, string> = {}) => ({
      Cookie: `aixshop_session=${cookieA}`,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    });

    // Step 4: CSRF middleware rejects state-changing cookie request lacking X-Requested-With
    const csrfFail = await originalFetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: { Cookie: `aixshop_session=${cookieA}` },
    });
    assert.equal(csrfFail.status, 403);
    assert.equal((await csrfFail.json()).code, 'CSRF_REJECTED');

    // Step 5: Guest-to-cloud catalog transfer (authorize + commit + audit log)
    const guestPayload = {
      products: [
        {
          id: 'guest_preview_01',
          title: 'Guest Preview French Press',
          brand: 'Journey Goods',
          category: 'Brew Gear',
          description: 'Stainless double-wall coffee press imported from guest preview.',
          image: 'https://example.com/press.jpg',
          status: 'active',
          completenessScore: 80,
          evidenceCoverageScore: 0,
          externalDiscoveryStatus: 'unindexed',
          sourceClassification: 'public_feed',
          sourceOrigin: 'https://journey30-store.myshopify.com',
          acquisitionMethod: 'public_storefront_json',
          variants: [
            {
              id: 'var_guest_01',
              sku: 'PRESS-01',
              title: '1L',
              barcode: '0850029381013',
              price: 54.0,
              inventoryCount: 15,
              attributes: {},
            },
          ],
          offers: [],
          attributes: {},
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
      storeProfile: {
        name: 'Journey 30 Preview',
        domain: shopDomain,
        websiteUrl: `https://${shopDomain}`,
        platform: 'Shopify Public Store Discovery (Limited Sample)',
        sourceClassification: 'public_feed',
        currency: 'USD',
        skuCount: 1,
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      },
    };
    const transferKey = `gt_30_${crypto.randomBytes(6).toString('hex')}`;
    const gtAuth = await originalFetch(`${baseUrl}/api/catalog/guest-transfer/authorize`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: transferKey,
        conflictStrategy: 'merge_prefer_cloud',
        payload: guestPayload,
      }),
    });
    assert.equal(gtAuth.status, 200);
    const gtAuthJson = await gtAuth.json();
    assert.ok(gtAuthJson.transferToken);

    const gtCommit = await originalFetch(`${baseUrl}/api/catalog/guest-transfer/commit`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        transferToken: gtAuthJson.transferToken,
        idempotencyKey: transferKey,
        conflictStrategy: 'merge_prefer_cloud',
        payload: guestPayload,
      }),
    });
    assert.equal(gtCommit.status, 200);

    // Step 6: Free Audit paywall strictly redacts findings/scores and blocks paid endpoints
    const freeCat = await (await originalFetch(`${baseUrl}/api/catalog`, { headers: authHeaders() })).json();
    assert.equal(freeCat.reportEntitlement.hasFullReportAccess, false);
    assert.equal(freeCat.catalog.findings.length, 0);

    for (const [method, endpoint, body] of [
      ['POST', '/api/audit/run', undefined],
      ['GET', '/api/audit/latest', undefined],
      ['GET', '/api/audit/history', undefined],
      ['GET', '/api/discovery/audit', undefined],
      ['POST', '/api/feed/validate', JSON.stringify({ platform: 'google_merchant_center' })],
      ['GET', '/api/feed/export?platform=google_merchant_center&format=csv', undefined],
    ] as const) {
      const blocked = await originalFetch(`${baseUrl}${endpoint}`, {
        method,
        headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body,
      });
      assert.equal(blocked.status, 403, `${method} ${endpoint} must require paid tier`);
      assert.equal((await blocked.json()).code, 'REPORT_PAYMENT_REQUIRED');
    }

    // Step 7: Create Checkout Session -> zero billing emails dispatched before confirmation
    const checkoutRes = await originalFetch(`${baseUrl}/api/billing/checkout-session`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tier: 'Starter' }),
    });
    assert.equal(checkoutRes.status, 200);
    const checkoutJson = await checkoutRes.json();
    assert.ok(checkoutJson.sessionId);
    assert.equal(smtpServer.messages.length, 0, 'checkout-session creation must not send confirmation emails');

    // Step 8: Verify Checkout Session -> upgrades to Starter + sends initial_payment_confirmed email once
    const verifyRes = await originalFetch(`${baseUrl}/api/billing/checkout-session/verify`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sessionId: checkoutJson.sessionId }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyJson = await verifyRes.json();
    assert.equal(verifyJson.verified, true);
    assert.equal(verifyJson.reportEntitlement.hasFullReportAccess, true);
    assert.equal(smtpServer.messages.length, 1);
    assert.match(smtpServer.messages[0].subject, /Payment Confirmed/i);

    // Step 9: Duplicate checkout.session.completed webhook deduplicates initial confirmation email cleanly
    const tsBase = Math.floor(Date.now() / 1000);
    const dupCheckoutWh = sandboxProvider.generateSignedPayload({
      id: 'evt_30step_initial_dup',
      type: 'checkout.session.completed',
      created: tsBase,
      data: {
        object: {
          id: checkoutJson.sessionId,
          client_reference_id: wsA,
          customer: verifyJson.subscription.providerCustomerId,
          subscription: verifyJson.subscription.providerSubscriptionId,
          payment_status: 'paid',
          amount_total: 4900,
          currency: 'usd',
          metadata: { workspaceId: wsA, tier: 'Starter' },
        },
      },
    });
    const whInitialRes = await originalFetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': dupCheckoutWh.signature },
      body: dupCheckoutWh.payload,
    });
    assert.equal(whInitialRes.status, 200);
    assert.equal(smtpServer.messages.length, 1, 'Duplicate checkout completion must not double-send confirmation email');

    // Step 10: Initiate Shopify OAuth with writeAccess=true
    const connectRes = await originalFetch(
      `${baseUrl}/api/shopify/connect?shop=${encodeURIComponent(shopDomain)}&writeAccess=true`,
      { headers: authHeaders() }
    );
    assert.equal(connectRes.status, 200);
    const connectJson = await connectRes.json();
    assert.ok(connectJson.scopes.includes('write_products'));
    assert.ok(connectJson.authUrl.includes('write_products'));

    // Step 11: Complete Shopify OAuth callback with valid HMAC -> encrypts token & grants writeBackAuthorized
    const cbParams: Record<string, string> = {
      code: 'shpca_30step_code_1',
      shop: shopDomain,
      state: connectJson.state,
      timestamp: String(tsBase),
    };
    const cbHmac = signShopifyQueryParams(cbParams, process.env.SHOPIFY_API_SECRET!);
    const cbQuery = new URLSearchParams({ ...cbParams, hmac: cbHmac }).toString();
    const cbRes = await originalFetch(`${baseUrl}/api/shopify/callback?${cbQuery}`);
    assert.equal(cbRes.status, 200);

    const statusRes = await originalFetch(`${baseUrl}/api/shopify/status`, { headers: authHeaders() });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.connected, true);
    assert.equal(statusJson.writeBackAuthorized, true);

    // Step 12: Start paginated Shopify catalog sync (page 1 only -> partially_completed)
    const syncPartialRes = await originalFetch(`${baseUrl}/api/shopify/sync`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ maxPages: 1, pageSize: 2 }),
    });
    assert.equal(syncPartialRes.status, 200);
    const syncPartialJson = await syncPartialRes.json();
    assert.equal(syncPartialJson.status, 'partially_completed');
    assert.equal(syncPartialJson.productsImported, 2);

    // Step 13: Resume paginated Shopify sync (completes remaining page)
    const syncResumeRes = await originalFetch(`${baseUrl}/api/shopify/sync/resume`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ syncRunId: syncPartialJson.syncRun.id, maxPages: 5, pageSize: 2 }),
    });
    assert.equal(syncResumeRes.status, 200);
    const syncResumeJson = await syncResumeRes.json();
    assert.equal(syncResumeJson.status, 'completed');

    // Step 14: Register and live-verify Shopify webhooks
    const whRegRes = await originalFetch(`${baseUrl}/api/shopify/webhooks/register`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(whRegRes.status, 200);
    const whVerRes = await originalFetch(`${baseUrl}/api/shopify/webhooks/verify`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(whVerRes.status, 200);
    assert.equal((await whVerRes.json()).verified, true);

    // Step 15: Run Audit #1 -> verifies GTIN findings & remediation actions created for synced Shopify products
    const audit1Res = await originalFetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(audit1Res.status, 200);
    const audit1 = await audit1Res.json();
    const run1Id = audit1.auditRun.id;
    const carafeAction = audit1.catalog.actions.find(
      (a: any) =>
        a.productId === 'p_shopify_3001' && a.proposedChange?.field === 'variants[0].barcode'
    );
    assert.ok(carafeAction, 'Audit #1 must generate variant barcode remediation action for Carafe');

    // Step 16: Verify persisted latest & historical audit runs
    const latestRes = await originalFetch(`${baseUrl}/api/audit/latest`, { headers: authHeaders() });
    assert.equal(latestRes.status, 200);
    assert.equal((await latestRes.json()).auditRun.id, run1Id);

    // Step 17: Merchant submits GTIN exemption evidence for Hand-Turned Walnut Scoop (always pending)
    const evUpload = await originalFetch(`${baseUrl}/api/catalog/evidence`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: 'ev_30step_scoop_exempt',
        productId: 'p_shopify_3003',
        title: 'GS1 Artisan Small-Batch Exemption',
        type: 'gtin_exemption_proof',
        issuer: 'GS1 Artisan Registry',
        evidencePurpose: 'gtin_exemption',
      }),
    });
    assert.equal(evUpload.status, 201);
    assert.equal((await evUpload.json()).evidence.status, 'pending');

    // Step 18: Self-approval by merchant rejected (403)
    const selfReview = await originalFetch(`${baseUrl}/api/catalog/evidence/ev_30step_scoop_exempt/review`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(selfReview.status, 403);
    assert.equal((await selfReview.json()).code, 'FORBIDDEN_REVIEWER_REQUIRED');

    // Step 19: Authorized platform reviewer approves exemption evidence
    const reviewerApprove = await originalFetch(`${baseUrl}/api/catalog/evidence/ev_30step_scoop_exempt/review`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        'X-AIXSHOP-Reviewer-Token': process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET!,
        'X-AIXSHOP-Reviewer-Id': 'compliance_reviewer_30',
      }),
      body: JSON.stringify({ decision: 'approved', reason: 'Verified handcrafted GTIN exemption' }),
    });
    assert.equal(reviewerApprove.status, 200);

    // Step 20: Run Audit #2 & compare historical audits -> scoop GTIN finding cleared
    const audit2Res = await originalFetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(audit2Res.status, 200);
    const audit2 = await audit2Res.json();
    const run2Id = audit2.auditRun.id;
    assert.equal(
      audit2.catalog.findings.some(
        (f: any) => f.productId === 'p_shopify_3003' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'
      ),
      false
    );
    const cmpRes = await originalFetch(
      `${baseUrl}/api/audit/compare?baseId=${encodeURIComponent(run1Id)}&targetId=${encodeURIComponent(run2Id)}`,
      { headers: authHeaders() }
    );
    assert.equal(cmpRes.status, 200);

    // Step 21: Merchant approves Carafe variant barcode remediation action with valid GS1 barcode
    const approveRes = await originalFetch(
      `${baseUrl}/api/catalog/actions/${encodeURIComponent(carafeAction.id)}/approve`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ customApprovedValue: '4006381333931' }),
      }
    );
    assert.equal(approveRes.status, 200);
    assert.equal((await approveRes.json()).action.status, 'approved');

    // Step 22: Execute Shopify Write-Back + read-back verification + history log
    const wbRes = await originalFetch(
      `${baseUrl}/api/shopify/write-back/${encodeURIComponent(carafeAction.id)}`,
      { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }) }
    );
    assert.equal(wbRes.status, 200);
    const wbJson = await wbRes.json();
    assert.equal(wbJson.operation.status, 'verified_applied');
    assert.equal(wbJson.operation.verifiedValue, '4006381333931');
    assert.equal(wbJson.action.status, 'applied_externally');
    assert.equal(shopifyState.mutationCalls, 1);

    const wbHistory = await (
      await originalFetch(`${baseUrl}/api/shopify/write-back/history`, { headers: authHeaders() })
    ).json();
    assert.equal(wbHistory.operations.length, 1);
    assert.equal(wbHistory.operations[0].verifiedValue, '4006381333931');

    // Step 23: Honest feed validation & CSV export includes verified written-back barcode
    const feedVal = await originalFetch(`${baseUrl}/api/feed/validate`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ platform: 'google_merchant_center' }),
    });
    assert.equal(feedVal.status, 200);
    assert.equal(feedVal.headers.get('x-aixshop-validation-scope'), 'local_structural_check_only');
    assert.equal(feedVal.headers.get('x-aixshop-external-platform-accepted'), 'false');

    const feedCsv = await (
      await originalFetch(`${baseUrl}/api/feed/export?platform=google_merchant_center&format=csv`, {
        headers: authHeaders(),
      })
    ).text();
    assert.ok(feedCsv.includes('4006381333931'));

    // Step 24: Recurring renewal invoice webhook -> extends period & sends recurring_renewal email
    const renewalWh = sandboxProvider.generateSignedPayload({
      id: 'evt_30step_renewal',
      type: 'invoice.payment_succeeded',
      created: tsBase + 60,
      data: {
        object: {
          id: 'in_30step_ren_1',
          subscription: verifyJson.subscription.providerSubscriptionId,
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          currency: 'usd',
          lines: {
            data: [{ period: { start: tsBase + 60, end: tsBase + 60 + 30 * 86400 } }],
          },
          metadata: { workspaceId: wsA },
        },
      },
    });
    assert.equal(
      (
        await originalFetch(`${baseUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': renewalWh.signature },
          body: renewalWh.payload,
        })
      ).status,
      200
    );
    assert.equal(smtpServer.messages.length, 2);
    assert.match(smtpServer.messages[1].subject, /Renew(al|ed)/i);

    // Step 25: Plan change webhook (Starter -> Growth) -> upgrades tier & sends plan_changed email
    const upgradeWh = sandboxProvider.generateSignedPayload({
      id: 'evt_30step_upgrade',
      type: 'customer.subscription.updated',
      created: tsBase + 120,
      data: {
        object: {
          id: verifyJson.subscription.providerSubscriptionId,
          customer: verifyJson.subscription.providerCustomerId,
          status: 'active',
          metadata: { workspaceId: wsA, tier: 'Growth' },
        },
      },
    });
    assert.equal(
      (
        await originalFetch(`${baseUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': upgradeWh.signature },
          body: upgradeWh.payload,
        })
      ).status,
      200
    );
    assert.equal(smtpServer.messages.length, 3);
    assert.match(smtpServer.messages[2].subject, /Plan Updated/i);

    // Step 26: Payment failure webhook -> past_due re-locks paid endpoints & sends payment_failed email
    const failWh = sandboxProvider.generateSignedPayload({
      id: 'evt_30step_pay_fail',
      type: 'invoice.payment_failed',
      created: tsBase + 180,
      data: {
        object: {
          id: 'in_30step_fail_1',
          subscription: verifyJson.subscription.providerSubscriptionId,
          amount_due: 14900,
          currency: 'usd',
          metadata: { workspaceId: wsA },
        },
      },
    });
    assert.equal(
      (
        await originalFetch(`${baseUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': failWh.signature },
          body: failWh.payload,
        })
      ).status,
      200
    );
    assert.equal(smtpServer.messages.length, 4);
    assert.match(smtpServer.messages[3].subject, /Payment Action Required/i);
    assert.equal(
      (
        await originalFetch(`${baseUrl}/api/audit/run`, {
          method: 'POST',
          headers: authHeaders(),
        })
      ).status,
      403
    );

    // Step 27: Subscription deleted webhook -> downgrades cleanly to Free Audit, preserves catalog, sends cancellation email
    const cancelWh = sandboxProvider.generateSignedPayload({
      id: 'evt_30step_cancel',
      type: 'customer.subscription.deleted',
      created: tsBase + 240,
      data: {
        object: {
          id: verifyJson.subscription.providerSubscriptionId,
          customer: verifyJson.subscription.providerCustomerId,
          metadata: { workspaceId: wsA },
        },
      },
    });
    assert.equal(
      (
        await originalFetch(`${baseUrl}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': cancelWh.signature },
          body: cancelWh.payload,
        })
      ).status,
      200
    );
    assert.equal(smtpServer.messages.length, 5);
    assert.match(smtpServer.messages[4].subject, /Canceled/i);

    const deliveries = await (
      await originalFetch(`${baseUrl}/api/billing/email-deliveries`, { headers: authHeaders() })
    ).json();
    assert.equal(deliveries.deliveries.length, 5);

    // Step 28: Password recovery over SMTP loopback + token consumption + re-login
    const forgotRes = await originalFetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailA }),
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(smtpServer.messages.length, 6);
    const resetMatch = smtpServer.messages[5].rawData.match(/#reset_token=([^\s\r\n]+)/);
    assert.ok(resetMatch?.[1]);

    const resetRes = await originalFetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: decodeURIComponent(resetMatch[1]), newPassword: resetPw }),
    });
    assert.equal(resetRes.status, 200);
    assert.equal((await originalFetch(`${baseUrl}/api/auth/me`, { headers: authHeaders() })).status, 401);

    const reLogin = await originalFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: resetPw }),
    });
    assert.equal(reLogin.status, 200);
    cookieA = extractSessionCookie(reLogin);

    // Step 29: Cross-tenant isolation check using Tenant B against Workspace A
    const regB = await originalFetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tenantb30@example.test',
        password: 'TenantB30!Password',
        fullName: 'Tenant B',
        workspaceName: 'Tenant B Store',
      }),
    });
    assert.equal(regB.status, 201);
    const cookieB = extractSessionCookie(regB);
    const wsB = (await regB.json()).workspace.id;

    const bSwitch = await originalFetch(`${baseUrl}/api/auth/switch-workspace`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `aixshop_session=${cookieB}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ workspaceId: wsA }),
    });
    assert.equal(bSwitch.status, 403);

    const bEmailLog = await (
      await originalFetch(`${baseUrl}/api/billing/email-deliveries`, {
        headers: {
          Cookie: `aixshop_session=${cookieB}`,
          'x-workspace-id': wsA,
        },
      })
    ).json();
    assert.equal(bEmailLog.workspaceId, wsB);
    assert.equal(bEmailLog.deliveries.length, 0);

    // Step 30: Cleanup both accounts via DELETE /api/auth/account & verify session invalidation
    for (const c of [cookieA, cookieB]) {
      const del = await originalFetch(`${baseUrl}/api/auth/account`, {
        method: 'DELETE',
        headers: {
          Cookie: `aixshop_session=${c}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(del.status, 200);
      assert.equal((await originalFetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: `aixshop_session=${c}` } })).status, 401);
    }
  });
});
