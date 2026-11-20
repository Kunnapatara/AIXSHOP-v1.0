import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { SandboxBillingProvider, setBillingProvider } from './billing/providerAdapter';
import { encryptCredential, signShopifyWebhookHmac } from './security/encryption';
import { syncShopifyCatalog } from './shopify/syncService';
import { _resetRateLimiter } from './middleware/auth';
import { runSecretSafeConfigCheck } from './config/checkConfig';

interface CapturedSmtpMessage {
  mailFrom: string;
  rcptTo: string[];
  rawData: string;
  authSeen: boolean;
}

/**
 * Lightweight local loopback TCP SMTP responder used strictly to exercise
 * emailService.ts's real node:net SMTP socket protocol end-to-end without external credentials.
 */
async function startLocalSmtpLoopbackServer(): Promise<{
  port: number;
  messages: CapturedSmtpMessage[];
  close: () => Promise<void>;
}> {
  const messages: CapturedSmtpMessage[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let currentMsg: CapturedSmtpMessage = {
      mailFrom: '',
      rcptTo: [],
      rawData: '',
      authSeen: false,
    };

    socket.write('220 aixshop-loopback.local ESMTP Ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      while (true) {
        if (inData) {
          const endMarkerIdx = buffer.indexOf('\r\n.\r\n');
          if (endMarkerIdx === -1) break;
          currentMsg.rawData = buffer.slice(0, endMarkerIdx);
          buffer = buffer.slice(endMarkerIdx + 5);
          inData = false;
          messages.push({ ...currentMsg, rcptTo: [...currentMsg.rcptTo] });
          currentMsg = { mailFrom: '', rcptTo: [], rawData: '', authSeen: currentMsg.authSeen };
          socket.write('250 2.0.0 Ok: queued cleanly\r\n');
          continue;
        }

        const lineIdx = buffer.indexOf('\r\n');
        if (lineIdx === -1) break;
        const line = buffer.slice(0, lineIdx);
        buffer = buffer.slice(lineIdx + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-aixshop-loopback.local\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          currentMsg.authSeen = true;
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          currentMsg.mailFrom = line.slice(10).trim();
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          currentMsg.rcptTo.push(line.slice(8).trim());
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

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
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

describe('AIXSHOP v1.0 — Full Customer Journey E2E & Negative Paths (Local Test Doubles / MemoryRepository)', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;
  let sandboxProvider: SandboxBillingProvider;
  let smtpServer: Awaited<ReturnType<typeof startLocalSmtpLoopbackServer>>;

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_STARTTLS',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'SMTP_REJECT_UNAUTHORIZED',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'AIXSHOP_PLATFORM_REVIEWER_SECRET',
    'BILLING_WEBHOOK_SECRET',
  ];

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    _resetRateLimiter();

    smtpServer = await startLocalSmtpLoopbackServer();
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtpServer.port);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_STARTTLS = 'false';
    process.env.SMTP_USER = 'smtp_test_user';
    process.env.SMTP_PASS = 'smtp_test_pass';
    process.env.SMTP_FROM = 'AIXSHOP <no-reply@aixshop.local>';
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SHOPIFY_API_KEY = 'shopify_e2e_client_key_12345';
    process.env.SHOPIFY_API_SECRET = 'shopify_e2e_secret_1234567890abcdef';
    process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = 'platform_reviewer_e2e_secret_at_least_32_chars';
    process.env.BILLING_WEBHOOK_SECRET = 'e2e_sandbox_webhook_secret_key_123';

    sandboxProvider = new SandboxBillingProvider(process.env.BILLING_WEBHOOK_SECRET);
    setBillingProvider(sandboxProvider);

    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    setBillingProvider(null);
    _resetRateLimiter();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await smtpServer.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('1. Secret-safe config:check helper never exposes secret values and flags missing production credentials in strict mode', () => {
    const devReport = runSecretSafeConfigCheck({ strict: false });
    assert.equal(devReport.valid, true);
    assert.equal(devReport.optionalIntegrations.smtpConfigured, true);
    assert.equal(devReport.optionalIntegrations.reviewerSecretConfigured, true);

    const strictReport = runSecretSafeConfigCheck({ strict: true });
    const serialized = JSON.stringify(strictReport);
    assert.equal(serialized.includes(process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET!), false);
    assert.equal(serialized.includes(process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY!), false);
    assert.equal(serialized.includes(process.env.SMTP_PASS!), false);
    // Strict mode without Stripe keys or DATABASE_URL must fail cleanly
    assert.equal(strictReport.valid, false);
    assert.ok(strictReport.missingOrInvalid.some((m) => m.includes('STRIPE_SECRET_KEY')));
  });

  test('2. Full merchant E2E journey: register -> TCP SMTP password recovery -> Shopify sync (mock fetch) -> Free Audit paywall -> paid upgrade -> GTIN evidence review -> audit compare & feed export', async () => {
    const email = 'journey_merchant@example.com';
    const initialPw = 'InitialPassword!234';
    const resetPw = 'RotatedPassword!567';

    // Step 2a: Register merchant (receives HttpOnly session cookie + Referrer-Policy header)
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: initialPw,
        fullName: 'Journey Merchant',
        workspaceName: 'Journey Goods Co',
      }),
    });
    assert.equal(regRes.status, 201);
    assert.equal(regRes.headers.get('referrer-policy'), 'no-referrer');
    const regCookie = extractSessionCookie(regRes);
    assert.ok(regCookie);
    const regBody = await regRes.json();
    const workspaceId = regBody.workspace.id;

    // CSRF rejection: cookie auth POST without X-Requested-With fails closed
    const csrfRejectRes = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: { Cookie: `aixshop_session=${regCookie}` },
    });
    assert.equal(csrfRejectRes.status, 403);
    assert.equal((await csrfRejectRes.json()).code, 'CSRF_REJECTED');

    // Step 2b: Forgot password -> delivers over local TCP SMTP responder
    const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(smtpServer.messages.length, 1);
    assert.equal(smtpServer.messages[0].authSeen, true);
    const resetTokenMatch = smtpServer.messages[0].rawData.match(/#reset_token=([^\s\r\n]+)/);
    assert.ok(resetTokenMatch?.[1], 'SMTP email must contain reset_token URL fragment');
    const resetToken = decodeURIComponent(resetTokenMatch[1]);

    // Step 2c: Consume single-use password reset token -> old session revoked + replay blocked
    const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: resetPw }),
    });
    assert.equal(resetRes.status, 200);

    const revokedCheck = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `aixshop_session=${regCookie}` },
    });
    assert.equal(revokedCheck.status, 401);

    const replayReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'AnotherPassword!890' }),
    });
    assert.equal(replayReset.status, 400);

    // Login with new password
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: resetPw }),
    });
    assert.equal(loginRes.status, 200);
    const sessionCookie = extractSessionCookie(loginRes);
    assert.ok(sessionCookie);

    const cookieHeaders = (extra: Record<string, string> = {}) => ({
      Cookie: `aixshop_session=${sessionCookie}`,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    });

    // Step 2d: Connect Shopify (encrypted token) and sync products via mocked GraphQL customFetch
    const shopDomain = 'journey-goods.myshopify.com';
    await repo.saveShopifyConnection({
      id: `conn_${workspaceId}`,
      workspaceId,
      shopDomain,
      accessTokenEncrypted: encryptCredential('shpat_e2e_token_123'),
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

    const mockShopifyFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  cursor: 'p1',
                  node: {
                    id: 'gid://shopify/Product/101',
                    title: 'Journey Digital Gift Card',
                    description: 'Instant digital gift card for Journey Goods.',
                    vendor: 'Journey',
                    productType: 'Gift Cards',
                    handle: 'digital-gift-card',
                    status: 'ACTIVE',
                    isGiftCard: true,
                    updatedAt: '2026-11-15T10:00:00Z',
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/gc.jpg' } }] },
                    variants: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          cursor: 'v1',
                          node: {
                            id: 'gid://shopify/ProductVariant/1001',
                            title: '$50',
                            sku: 'GC-50',
                            barcode: '',
                            price: '50.00',
                            inventoryQuantity: 999,
                            selectedOptions: [],
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  cursor: 'p2',
                  node: {
                    id: 'gid://shopify/Product/102',
                    title: 'Valid Barcoded Coffee Beans',
                    description: 'Single-origin roasted whole beans in 340g bag.',
                    vendor: 'Journey',
                    productType: 'Coffee',
                    handle: 'coffee-beans',
                    status: 'ACTIVE',
                    isGiftCard: false,
                    updatedAt: '2026-11-15T10:00:00Z',
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/coffee.jpg' } }] },
                    variants: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          cursor: 'v2',
                          node: {
                            id: 'gid://shopify/ProductVariant/1002',
                            title: '340g',
                            sku: 'COF-340',
                            barcode: '0850029381013',
                            price: '22.00',
                            inventoryQuantity: 45,
                            selectedOptions: [],
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  cursor: 'p3',
                  node: {
                    id: 'gid://shopify/Product/103',
                    title: 'Handmade Walnut Tray',
                    description: 'Hand-carved black walnut serving tray.',
                    vendor: 'Journey Studio',
                    productType: 'Home Goods',
                    handle: 'walnut-tray',
                    status: 'ACTIVE',
                    isGiftCard: false,
                    updatedAt: '2026-11-15T10:00:00Z',
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/tray.jpg' } }] },
                    variants: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          cursor: 'v3',
                          node: {
                            id: 'gid://shopify/ProductVariant/1003',
                            title: 'Medium',
                            sku: 'TRAY-M',
                            barcode: '',
                            price: '68.00',
                            inventoryQuantity: 8,
                            selectedOptions: [],
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  cursor: 'p4',
                  node: {
                    id: 'gid://shopify/Product/104',
                    title: 'Corrupted Barcode Kettle',
                    description: 'Stainless steel gooseneck pour-over kettle.',
                    vendor: 'Journey',
                    productType: 'Brew Gear',
                    handle: 'kettle',
                    status: 'ACTIVE',
                    isGiftCard: false,
                    updatedAt: '2026-11-15T10:00:00Z',
                    images: { edges: [{ node: { url: 'https://cdn.shopify.com/kettle.jpg' } }] },
                    variants: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          cursor: 'v4',
                          node: {
                            id: 'gid://shopify/ProductVariant/1004',
                            title: '1L',
                            sku: 'KET-1L',
                            barcode: '0850029381019', // bad check digit (should end with 3)
                            price: '84.00',
                            inventoryQuantity: 12,
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

    const syncRes = await syncShopifyCatalog(repo, workspaceId, { customFetch: mockShopifyFetch });
    assert.equal(syncRes.productsImported, 4);

    // Step 2e: Enforce Free Audit No-Results-Before-Payment policy across all paid endpoints
    const freeCatRes = await fetch(`${baseUrl}/api/catalog`, { headers: cookieHeaders() });
    assert.equal(freeCatRes.status, 200);
    const freeCat = await freeCatRes.json();
    assert.equal(freeCat.reportEntitlement.hasFullReportAccess, false);
    assert.equal(freeCat.catalog.findings.length, 0);
    assert.equal(freeCat.catalog.storeProfile.catalogCompletenessAvg, 0);

    for (const [method, endpoint, body] of [
      ['POST', '/api/audit/run', undefined],
      ['GET', '/api/audit/latest', undefined],
      ['GET', '/api/audit/history', undefined],
      ['POST', '/api/feed/validate', JSON.stringify({ platform: 'google_merchant_center' })],
      ['GET', '/api/feed/export?platform=google_merchant_center&format=csv', undefined],
    ] as const) {
      const blockedRes = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: cookieHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body,
      });
      assert.equal(blockedRes.status, 403, `${method} ${endpoint} must return 403 for Free Audit`);
      const blockedJson = await blockedRes.json();
      assert.equal(blockedJson.code, 'REPORT_PAYMENT_REQUIRED');
    }

    // Step 2f: Checkout & verify paid subscription via SandboxBillingProvider + signed webhook
    const checkoutRes = await fetch(`${baseUrl}/api/billing/checkout-session`, {
      method: 'POST',
      headers: cookieHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tier: 'Growth' }),
    });
    assert.equal(checkoutRes.status, 200);
    const checkoutData = await checkoutRes.json();
    assert.ok(checkoutData.sessionId);

    const verifyRes = await fetch(`${baseUrl}/api/billing/checkout-session/verify`, {
      method: 'POST',
      headers: cookieHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sessionId: checkoutData.sessionId }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.verified, true);
    assert.equal(verifyData.reportEntitlement.hasFullReportAccess, true);

    // Step 2g: Run Audit #1 -> validate gift card exempt, handmade NEEDS_REVIEW, invalid GTIN critical
    const audit1Res = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: cookieHeaders(),
    });
    assert.equal(audit1Res.status, 200);
    const audit1 = await audit1Res.json();
    const run1Id = audit1.auditRun.id;

    assert.equal(
      audit1.catalog.findings.some((f: any) => f.productId === 'p_shopify_101' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'),
      false,
      'Gift card synced from Shopify must be verified_exempt'
    );
    assert.equal(
      audit1.catalog.findings.some(
        (f: any) =>
          f.productId === 'p_shopify_103' &&
          f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' &&
          f.reviewStatus === 'NEEDS_REVIEW'
      ),
      true,
      'Unverified handmade tray without barcode must classify as NEEDS_REVIEW'
    );
    assert.equal(
      audit1.catalog.findings.some(
        (f: any) =>
          f.productId === 'p_shopify_104' &&
          f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' &&
          f.gtinEligibilityStatus === 'gtin_present' &&
          f.severity === 'critical'
      ),
      true,
      'Corrupted GTIN check digit must be critical'
    );

    // Step 2h: Merchant uploads GTIN exemption proof -> 403 self-approve -> reviewer approves -> Audit #2 passes
    const uploadRes = await fetch(`${baseUrl}/api/catalog/evidence`, {
      method: 'POST',
      headers: cookieHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: 'ev_e2e_tray_exempt',
        productId: 'p_shopify_103',
        title: 'GS1 Handmade Craft GTIN Exemption',
        type: 'gtin_exemption_proof',
        issuer: 'GS1 Registry',
        evidencePurpose: 'gtin_exemption',
      }),
    });
    assert.equal(uploadRes.status, 201);
    assert.equal((await uploadRes.json()).evidence.status, 'pending');

    const selfReviewRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_e2e_tray_exempt/review`, {
      method: 'POST',
      headers: cookieHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(selfReviewRes.status, 403);
    assert.equal((await selfReviewRes.json()).code, 'FORBIDDEN_REVIEWER_REQUIRED');

    const reviewerRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_e2e_tray_exempt/review`, {
      method: 'POST',
      headers: cookieHeaders({
        'Content-Type': 'application/json',
        'X-AIXSHOP-Reviewer-Token': process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET!,
        'X-AIXSHOP-Reviewer-Id': 'e2e_compliance_reviewer',
      }),
      body: JSON.stringify({ decision: 'approved', reason: 'Confirmed artisan exemption certificate' }),
    });
    assert.equal(reviewerRes.status, 200);

    const audit2Res = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: cookieHeaders(),
    });
    assert.equal(audit2Res.status, 200);
    const audit2 = await audit2Res.json();
    const run2Id = audit2.auditRun.id;

    assert.equal(
      audit2.catalog.findings.some((f: any) => f.productId === 'p_shopify_103' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'),
      false,
      'Approved GTIN exemption must clear NEEDS_REVIEW finding on subsequent audit'
    );

    // Step 2i: Historical comparison & honest local feed validation/export
    const compareRes = await fetch(
      `${baseUrl}/api/audit/compare?baseId=${encodeURIComponent(run1Id)}&targetId=${encodeURIComponent(run2Id)}`,
      { headers: cookieHeaders() }
    );
    assert.equal(compareRes.status, 200);
    const compareJson = await compareRes.json();
    assert.ok(compareJson.comparison);

    const feedValRes = await fetch(`${baseUrl}/api/feed/validate`, {
      method: 'POST',
      headers: cookieHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ platform: 'google_merchant_center' }),
    });
    assert.equal(feedValRes.status, 200);
    assert.equal(feedValRes.headers.get('x-aixshop-validation-scope'), 'local_structural_check_only');
    assert.equal(feedValRes.headers.get('x-aixshop-external-platform-accepted'), 'false');

    const feedExportRes = await fetch(`${baseUrl}/api/feed/export?platform=google_merchant_center&format=csv`, {
      headers: cookieHeaders(),
    });
    assert.equal(feedExportRes.status, 200);
    const csvText = await feedExportRes.text();
    assert.ok(csvText.includes('0850029381013'));
  });

  test('3. Negative & resilience paths: payment failure -> downgrade, bad HMAC webhooks, idempotency, cross-tenant isolation, and 429 rate limits', async () => {
    // Setup Workspace A (paid) and Workspace B (free)
    const regA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'neg_a@example.com',
        password: 'StrongPassword!111',
        fullName: 'Owner A',
        workspaceName: 'Neg Store A',
      }),
    });
    assert.equal(regA.status, 201);
    const cookieA = extractSessionCookie(regA);
    const wsA = (await regA.json()).workspace.id;

    const regB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'neg_b@example.com',
        password: 'StrongPassword!222',
        fullName: 'Owner B',
        workspaceName: 'Neg Store B',
      }),
    });
    assert.equal(regB.status, 201);
    const cookieB = extractSessionCookie(regB);
    const wsB = (await regB.json()).workspace.id;

    // Cross-tenant isolation: Owner B cannot access Owner A's workspace via switch-workspace
    const switchForbidden = await fetch(`${baseUrl}/api/auth/switch-workspace`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `aixshop_session=${cookieB}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ workspaceId: wsA }),
    });
    assert.equal(switchForbidden.status, 403);

    // Upgrade Workspace A via signed checkout.session.completed webhook
    const tsBase = Math.floor(Date.now() / 1000);
    const checkoutEvent = sandboxProvider.generateSignedPayload({
      id: 'evt_e2e_neg_activate_1',
      type: 'checkout.session.completed',
      created: tsBase,
      data: {
        object: {
          client_reference_id: wsA,
          customer: 'sbx_cus_neg_a',
          subscription: 'sbx_sub_neg_a',
          payment_status: 'paid',
          metadata: { workspaceId: wsA, tier: 'Starter' },
        },
      },
    });
    const activateRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': checkoutEvent.signature },
      body: checkoutEvent.payload,
    });
    assert.equal(activateRes.status, 200);
    assert.equal((await activateRes.json()).action, 'processed');

    // Duplicate delivery of the exact same webhook event is idempotent
    const dupRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': checkoutEvent.signature },
      body: checkoutEvent.payload,
    });
    assert.equal(dupRes.status, 200);
    assert.equal((await dupRes.json()).action, 'duplicate');

    // Tampered billing webhook signature must be rejected (400)
    const badBillingWh = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=deadbeef' },
      body: checkoutEvent.payload,
    });
    assert.equal(badBillingWh.status, 400);

    // Tampered Shopify webhook HMAC signature must be rejected (401)
    const badShopifyWh = await fetch(`${baseUrl}/api/shopify/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shopify-hmac-sha256': 'invalidsignature==',
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': 'neg-store-a.myshopify.com',
        'x-shopify-delivery-id': 'del_bad_hmac',
      },
      body: JSON.stringify({ id: 999, title: 'Bad HMAC' }),
    });
    assert.equal(badShopifyWh.status, 401);

    // Payment failure webhook (invoice.payment_failed) sets subscription past_due and blocks paid audit access
    const failEvent = sandboxProvider.generateSignedPayload({
      id: 'evt_e2e_neg_pay_fail_2',
      type: 'invoice.payment_failed',
      created: tsBase + 5,
      data: {
        object: {
          subscription: 'sbx_sub_neg_a',
          metadata: { workspaceId: wsA },
        },
      },
    });
    const failWhRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': failEvent.signature },
      body: failEvent.payload,
    });
    assert.equal(failWhRes.status, 200);

    const auditBlockedPastDue = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: { Cookie: `aixshop_session=${cookieA}`, 'X-Requested-With': 'XMLHttpRequest' },
    });
    assert.equal(auditBlockedPastDue.status, 403);
    assert.equal((await auditBlockedPastDue.json()).code, 'REPORT_PAYMENT_REQUIRED');

    // Cancellation webhook (customer.subscription.deleted) downgrades to Free Audit cleanly
    const cancelEvent = sandboxProvider.generateSignedPayload({
      id: 'evt_e2e_neg_cancel_3',
      type: 'customer.subscription.deleted',
      created: tsBase + 10,
      data: {
        object: {
          id: 'sbx_sub_neg_a',
          customer: 'sbx_cus_neg_a',
          metadata: { workspaceId: wsA },
        },
      },
    });
    const cancelWhRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': cancelEvent.signature },
      body: cancelEvent.payload,
    });
    assert.equal(cancelWhRes.status, 200);

    const subAfterCancelRes = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Cookie: `aixshop_session=${cookieA}` },
    });
    assert.equal(subAfterCancelRes.status, 200);
    const subAfterCancel = await subAfterCancelRes.json();
    assert.equal(subAfterCancel.subscription.status, 'canceled');
    assert.equal(subAfterCancel.storeProfile.tier, 'Free Audit');
    assert.equal(subAfterCancel.reportEntitlement.hasFullReportAccess, false);

    // Rate limiting: verify forgot-password enforces 429 RATE_LIMITED after 10 attempts for Workspace B
    assert.ok(wsB);
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const rlRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `ratelimit_probe_${i}@example.com` }),
      });
      if (rlRes.status === 429) {
        const body = await rlRes.json();
        assert.equal(body.code, 'RATE_LIMITED');
        saw429 = true;
        break;
      }
    }
    assert.equal(saw429, true, 'Auth endpoint must return 429 RATE_LIMITED when window budget is exceeded');
  });
});
