import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import {
  StripeBillingProvider,
  findPlanByPriceId,
  validateStripePriceConfiguration,
  verifyStripeConfiguredPrices,
} from './billing/providerAdapter';
import { validateProductionConfig } from './config/productionConfig';
import { runSecretSafeConfigCheck, runSecretSafeConfigCheckWithSmtpProbe } from './config/checkConfig';
import {
  clearDevEmailOutbox,
  sendPasswordResetEmail,
  setCustomEmailTransport,
  validateSmtpConfig,
  verifySmtpConnection,
} from './services/emailService';

function setValidProductionBaseEnv() {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://aixshop_user:prod_pg_secret_987@db.internal.aixshop.io:5432/aixshop';
  process.env.APP_URL = 'https://app.aixshop.io';
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.BILLING_PROVIDER = 'stripe';
  process.env.STRIPE_SECRET_KEY = 'sk_live_test_secret_key_999';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_test_webhook_secret_999';
  process.env.STRIPE_PRICE_STARTER = 'price_1StarterLiveReal999';
  process.env.STRIPE_PRICE_GROWTH = 'price_1GrowthLiveReal999';
  process.env.STRIPE_PRICE_ENTERPRISE = 'price_1EnterpriseLiveReal999';
  process.env.SMTP_HOST = 'smtp.mailgun.org';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_STARTTLS = 'require';
  process.env.SMTP_USER = 'postmaster@mail.aixshop.io';
  process.env.SMTP_PASS = 'prod_smtp_secret_pass_xyz987';
  process.env.SMTP_FROM = 'AIXSHOP <no-reply@aixshop.io>';
  process.env.SMTP_REJECT_UNAUTHORIZED = 'true';
  delete process.env.DISABLE_AUTH;
  delete process.env.ALLOW_INSECURE_HTTP;
  delete process.env.TRUST_PROXY;
}

async function startLocalSmtpServer(opts: {
  failAuth?: boolean;
  rejectRecipient?: boolean;
  rejectData?: boolean;
  hangGreeting?: boolean;
  advertiseStarttls?: boolean;
} = {}) {
  const receivedData: string[] = [];
  const authAttempts: string[] = [];
  const srv = net.createServer((socket) => {
    if (opts.hangGreeting) {
      // Intentionally stay silent to trigger socket timeout
      return;
    }
    let buffer = '';
    let inData = false;
    let dataBuf = '';

    socket.write('220 smtp.local.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            if (opts.rejectData) {
              dataBuf = '';
              socket.write('554 5.7.1 Message rejected by policy\r\n');
            } else {
              receivedData.push(dataBuf);
              dataBuf = '';
              socket.write('250 2.0.0 OK queued\r\n');
            }
          } else {
            dataBuf += `${line}\r\n`;
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-smtp.local.test\r\n');
          if (opts.advertiseStarttls) {
            socket.write('250-STARTTLS\r\n');
          }
          socket.write('250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          authAttempts.push(line);
          socket.write(opts.failAuth ? '535 5.7.8 Authentication credentials invalid\r\n' : '235 2.7.0 Auth OK\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          socket.write(opts.rejectRecipient ? '550 5.1.1 User unknown\r\n' : '250 2.1.5 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 Unknown command\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    receivedData,
    authAttempts,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe('Workstreams 3 & 4 — Stripe Price ID Enforcement, SMTP Readiness, and Safe Password Reset Handling', () => {
  const envKeys = [
    'NODE_ENV',
    'DATABASE_URL',
    'SQL_HOST',
    'PGHOST',
    'APP_URL',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'BILLING_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_GROWTH',
    'STRIPE_PRICE_ENTERPRISE',
    'STRIPE_PRICE_ID_STARTER',
    'STRIPE_PRICE_ID_GROWTH',
    'STRIPE_PRICE_ID_ENTERPRISE',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_STARTTLS',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'SMTP_REJECT_UNAUTHORIZED',
    'SMTP_TIMEOUT_MS',
    'DISABLE_AUTH',
    'ALLOW_INSECURE_HTTP',
    'TRUST_PROXY',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
    }
    setCustomEmailTransport(null);
    clearDevEmailOutbox();
  });

  afterEach(() => {
    setCustomEmailTransport(null);
    clearDevEmailOutbox();
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  // =========================================================================
  // WORKSTREAM 3 — Enforce Stripe Price IDs in Production
  // =========================================================================
  describe('Workstream 3: Stripe Price ID Production Enforcement & Verification', () => {
    test('W3.1 Passes production validation only when all 3 distinct Stripe Price IDs and prod config are set', () => {
      setValidProductionBaseEnv();
      const prod = validateProductionConfig();
      assert.equal(prod.valid, true, `Expected valid prod config, missingOrInvalid=${JSON.stringify(prod.missingOrInvalid)}`);
      assert.equal(prod.checks.billingConfigValid, true);
      assert.equal(prod.checks.stripePriceIdsValid, true);

      const strict = runSecretSafeConfigCheck({ strict: true });
      assert.equal(strict.valid, true);
      assert.equal(strict.optionalIntegrations.stripePriceIdsConfigured, true);

      const serialized = JSON.stringify({ prod, strict });
      assert.doesNotMatch(serialized, /sk_live_test_secret_key_999|whsec_live_test_webhook_secret_999|prod_pg_secret_987|prod_smtp_secret_pass_xyz987/);
    });

    test('W3.2 Rejects production readiness when Starter, Growth, or Enterprise Price ID is individually missing', () => {
      for (const missingVar of ['STRIPE_PRICE_STARTER', 'STRIPE_PRICE_GROWTH', 'STRIPE_PRICE_ENTERPRISE'] as const) {
        setValidProductionBaseEnv();
        delete process.env[missingVar];

        const prod = validateProductionConfig();
        assert.equal(prod.valid, false, `Missing ${missingVar} must fail validateProductionConfig()`);
        assert.equal(prod.checks.stripePriceIdsValid, false);
        assert.equal(prod.checks.billingConfigValid, false);
        assert.ok(
          prod.missingOrInvalid.some((entry) => entry.includes(missingVar)),
          `missingOrInvalid should identify ${missingVar}, got ${JSON.stringify(prod.missingOrInvalid)}`
        );

        const strict = runSecretSafeConfigCheck({ strict: true });
        assert.equal(strict.valid, false);
        assert.equal(strict.optionalIntegrations.stripePriceIdsConfigured, false);
      }
    });

    test('W3.3 Rejects placeholder, malformed, and cross-tier conflicting Stripe Price IDs', async () => {
      const invalidValues = [
        'price_placeholder_1234',
        'price_xxx',
        'your_price_id_here',
        'price_123',
        'prod_NotAPriceId123',
      ];

      for (const badVal of invalidValues) {
        setValidProductionBaseEnv();
        process.env.STRIPE_PRICE_GROWTH = badVal;
        const prod = validateProductionConfig();
        assert.equal(prod.valid, false, `Value "${badVal}" must be rejected`);
        assert.equal(prod.checks.stripePriceIdsValid, false);
        assert.ok(prod.missingOrInvalid.some((m) => m.includes('STRIPE_PRICE_GROWTH')));
      }

      // Conflicting / duplicate Price ID mapped to two plans
      setValidProductionBaseEnv();
      process.env.STRIPE_PRICE_STARTER = 'price_shared_dup_123456';
      process.env.STRIPE_PRICE_GROWTH = 'price_shared_dup_123456';
      const conflictProd = validateProductionConfig();
      assert.equal(conflictProd.valid, false);
      assert.equal(conflictProd.checks.stripePriceIdsValid, false);
      assert.ok(conflictProd.missingOrInvalid.some((m) => m.includes('conflicts with STRIPE_PRICE_STARTER')));

      // findPlanByPriceId refuses ambiguous duplicated Price ID
      assert.equal(findPlanByPriceId('price_shared_dup_123456'), null);

      // StripeBillingProvider.createCheckoutSession rejects conflicting Price ID
      const mockStripe = {
        checkout: { sessions: { create: async () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/x' }) } },
      } as any;
      const provider = new StripeBillingProvider('sk_test_key', 'whsec_key', mockStripe, {
        Starter: 'price_shared_dup_123456',
        Growth: 'price_shared_dup_123456',
        Enterprise: 'price_ent_unique_123456',
      });
      await assert.rejects(
        () =>
          provider.createCheckoutSession({
            workspaceId: 'ws_dup',
            tier: 'Starter',
            successUrl: 'https://app.aixshop.io/ok',
            cancelUrl: 'https://app.aixshop.io/cancel',
          }),
        /conflicts with STRIPE_PRICE_GROWTH/
      );

      // Placeholder rejected in createCheckoutSession too (never falls back)
      const placeholderProvider = new StripeBillingProvider('sk_test_key', 'whsec_key', mockStripe, {
        Starter: 'price_placeholder_starter',
      });
      await assert.rejects(
        () =>
          placeholderProvider.createCheckoutSession({
            workspaceId: 'ws_ph',
            tier: 'Starter',
            successUrl: 'https://app.aixshop.io/ok',
            cancelUrl: 'https://app.aixshop.io/cancel',
          }),
        /invalid or uses a placeholder value/
      );
    });

    test('W3.4 verifyStripeConfiguredPrices checks active status, recurring monthly interval, USD currency, and plan unit_amount', async () => {
      setValidProductionBaseEnv();
      const validMockStripe = {
        prices: {
          retrieve: async (priceId: string) => {
            if (priceId === 'price_1StarterLiveReal999') {
              return { id: priceId, active: true, type: 'recurring', currency: 'usd', unit_amount: 4900, recurring: { interval: 'month', interval_count: 1 } };
            }
            if (priceId === 'price_1GrowthLiveReal999') {
              return { id: priceId, active: true, type: 'recurring', currency: 'usd', unit_amount: 14900, recurring: { interval: 'month', interval_count: 1 } };
            }
            if (priceId === 'price_1EnterpriseLiveReal999') {
              return { id: priceId, active: true, type: 'recurring', currency: 'usd', unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } };
            }
            throw new Error(`Unknown price ${priceId}`);
          },
        },
      } as any;

      const okRes = await verifyStripeConfiguredPrices(validMockStripe);
      assert.equal(okRes.verified, true);
      assert.equal(okRes.missingOrInvalid.length, 0);
      assert.equal(okRes.plans.length, 3);
      assert.ok(okRes.plans.every((p) => p.valid));

      // Detect wrong interval (yearly instead of monthly) and wrong price amount without leaking secrets
      const badIntervalMockStripe = {
        prices: {
          retrieve: async (priceId: string) => {
            if (priceId === 'price_1StarterLiveReal999') {
              return { id: priceId, active: true, type: 'recurring', currency: 'usd', unit_amount: 4900, recurring: { interval: 'year', interval_count: 1 } };
            }
            if (priceId === 'price_1GrowthLiveReal999') {
              return { id: priceId, active: true, type: 'recurring', currency: 'usd', unit_amount: 9900, recurring: { interval: 'month', interval_count: 1 } };
            }
            throw new Error('Stripe API failure sk_live_should_never_leak_123');
          },
        },
      } as any;

      const badRes = await verifyStripeConfiguredPrices(badIntervalMockStripe);
      assert.equal(badRes.verified, false);
      assert.ok(badRes.plans[0].errors.some((e) => e.includes('monthly recurring interval')));
      assert.ok(badRes.plans[1].errors.some((e) => e.includes('unit_amount mismatch')));
      assert.equal(badRes.plans[2].valid, false);
      assert.doesNotMatch(JSON.stringify(badRes), /sk_live_should_never_leak_123/);
    });

    test('W3.5 Development/test mode preserves usability when Stripe Price IDs are unset', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_PRICE_STARTER;
      delete process.env.STRIPE_PRICE_GROWTH;
      delete process.env.STRIPE_PRICE_ENTERPRISE;
      delete process.env.SMTP_HOST;

      const devCheck = validateProductionConfig();
      assert.equal(devCheck.valid, true);
      assert.equal(validateStripePriceConfiguration().valid, false);
    });
  });

  // =========================================================================
  // WORKSTREAM 4 — SMTP Readiness Verification & Safe Password Reset Handling
  // =========================================================================
  describe('Workstream 4: SMTP Configuration, Connection Readiness & Password Reset Safety', () => {
    test('W4.1 Production config enforces SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, and TLS transport', () => {
      for (const missingSmtp of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const) {
        setValidProductionBaseEnv();
        delete process.env[missingSmtp];
        const res = validateProductionConfig();
        assert.equal(res.valid, false, `Missing ${missingSmtp} must fail production validation`);
        assert.equal(res.checks.smtpConfigValid, false);
      }

      // Preserves SMTP_PASS variable name and rejects invalid port / plaintext in production
      setValidProductionBaseEnv();
      process.env.SMTP_PORT = '99999';
      assert.equal(validateSmtpConfig({ isProd: true }).portValid, false);
      assert.equal(validateProductionConfig().checks.smtpConfigValid, false);

      setValidProductionBaseEnv();
      process.env.SMTP_STARTTLS = 'false';
      process.env.SMTP_SECURE = 'false';
      const plaintextRes = validateProductionConfig();
      assert.equal(plaintextRes.checks.smtpConfigValid, false);
      assert.ok(plaintextRes.missingOrInvalid.some((m) => m.includes('plaintext SMTP prohibited')));

      // Rejects .local sender in production
      setValidProductionBaseEnv();
      process.env.SMTP_FROM = 'no-reply@aixshop.local';
      assert.equal(validateProductionConfig().checks.smtpConfigValid, false);
    });

    test('W4.2 verifySmtpConnection distinguishes config validity, live connection, message acceptance, and never claims inbox delivery', async () => {
      const smtp = await startLocalSmtpServer();
      try {
        process.env.NODE_ENV = 'test';
        process.env.SMTP_HOST = '127.0.0.1';
        process.env.SMTP_PORT = String(smtp.port);
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_STARTTLS = 'false';
        process.env.SMTP_USER = 'mailer@aixshop.test';
        process.env.SMTP_PASS = 'super_secret_pass_456';
        process.env.SMTP_FROM = 'AIXSHOP <no-reply@aixshop.test>';

        // Offline config check says config valid, connection NOT verified yet
        const offline = runSecretSafeConfigCheck({ strict: false });
        assert.equal(offline.smtpReadiness.smtp_configuration_valid, true);
        assert.equal(offline.smtpReadiness.smtp_connection_verified, false);
        assert.equal(offline.smtpReadiness.smtp_message_accepted, null);
        assert.equal(offline.smtpReadiness.inbox_delivery_confirmed, false);

        // Live SMTP connection probe verifies greeting+EHLO+AUTH+QUIT without sending any message
        const liveProbe = await verifySmtpConnection({ timeoutMs: 2000 });
        assert.equal(liveProbe.smtp_configuration_valid, true);
        assert.equal(liveProbe.smtp_connection_verified, true);
        assert.equal(liveProbe.smtp_message_accepted, null);
        assert.equal(liveProbe.inbox_delivery_confirmed, false);
        assert.equal(smtp.receivedData.length, 0, 'Connection probe must not send email data');

        // Also test runSecretSafeConfigCheckWithSmtpProbe
        const checkWithProbe = await runSecretSafeConfigCheckWithSmtpProbe({ strict: false, timeoutMs: 2000 });
        assert.equal(checkWithProbe.smtpReadiness.smtp_connection_verified, true);
        assert.equal(checkWithProbe.smtpReadiness.inbox_delivery_confirmed, false);

        // Sending email sets smtp_message_accepted: true while inbox_delivery_confirmed remains false
        const sendRes = await sendPasswordResetEmail({
          to: 'merchant@example.com',
          fullName: 'Merchant',
          resetUrl: 'https://app.aixshop.io/#reset_token=tok_probe_1',
          ttlMinutes: 30,
        });
        assert.equal(sendRes.delivered, true);
        assert.equal(sendRes.smtp_configuration_valid, true);
        assert.equal(sendRes.smtp_connection_verified, true);
        assert.equal(sendRes.smtp_message_accepted, true);
        assert.equal(sendRes.inbox_delivery_confirmed, false);
      } finally {
        await smtp.close();
      }
    });

    test('W4.3 verifySmtpConnection handles AUTH failure, connection refusal, missing STARTTLS, and timeouts without leaking SMTP_PASS', async () => {
      // 1. Auth failure
      const authFailSmtp = await startLocalSmtpServer({ failAuth: true });
      try {
        process.env.NODE_ENV = 'test';
        process.env.SMTP_HOST = '127.0.0.1';
        process.env.SMTP_PORT = String(authFailSmtp.port);
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_STARTTLS = 'false';
        process.env.SMTP_USER = 'baduser';
        process.env.SMTP_PASS = 'ULTRA_SECRET_SMTP_PASS_NEVER_LEAK';
        process.env.SMTP_FROM = 'no-reply@aixshop.test';

        const probe = await verifySmtpConnection({ timeoutMs: 2000 });
        assert.equal(probe.smtp_configuration_valid, true);
        assert.equal(probe.smtp_connection_verified, false);
        assert.equal(probe.smtp_message_accepted, null);
        assert.equal(probe.inbox_delivery_confirmed, false);
        assert.match(probe.connectionError || '', /authentication failed|535/i);
        assert.doesNotMatch(JSON.stringify(probe), /ULTRA_SECRET_SMTP_PASS_NEVER_LEAK/);
      } finally {
        await authFailSmtp.close();
      }

      // 2. Unreachable port (connection refused)
      process.env.SMTP_PORT = '59997';
      const connFail = await verifySmtpConnection({ timeoutMs: 1000 });
      assert.equal(connFail.smtp_connection_verified, false);
      assert.equal(connFail.inbox_delivery_confirmed, false);
      assert.ok(connFail.connectionError);

      // 3. Timeout on silent socket
      const hangSmtp = await startLocalSmtpServer({ hangGreeting: true });
      try {
        process.env.SMTP_PORT = String(hangSmtp.port);
        const timeoutRes = await verifySmtpConnection({ timeoutMs: 120 });
        assert.equal(timeoutRes.smtp_connection_verified, false);
        assert.match(timeoutRes.connectionError || '', /timed out/i);
      } finally {
        await hangSmtp.close();
      }
    });

    test('W4.4 Password reset invalidates token on SMTP send rejection/failure, preserves non-enumeration, and logs no secrets', async () => {
      const repo = new MemoryRepository(false);
      const app = createApp(repo);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

      const capturedLogs: string[] = [];
      const origWarn = console.warn;
      const origErr = console.error;
      const origLog = console.log;
      console.warn = (...a: any[]) => capturedLogs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
      console.error = (...a: any[]) => capturedLogs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
      console.log = (...a: any[]) => capturedLogs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

      try {
        // Register user
        const regRes = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({
            email: 'reset-safe@example.com',
            password: 'InitialPassword123!',
            fullName: 'Safe Reset',
            workspaceName: 'Reset WS',
          }),
        });
        assert.equal(regRes.status, 201);

        // Capture raw token created on a failing delivery attempt by wrapping customEmailTransport
        let capturedResetToken = '';
        setCustomEmailTransport(async (email) => {
          const m = email.text.match(/#reset_token=([^\s]+)/);
          if (m?.[1]) capturedResetToken = decodeURIComponent(m[1]);
          return {
            delivered: false,
            mode: 'smtp',
            error: 'Simulated SMTP DATA rejection: 554 relay denied',
            smtp_configuration_valid: true,
            smtp_connection_verified: true,
            smtp_message_accepted: false,
            inbox_delivery_confirmed: false,
          };
        });

        // 1. Failing send returns 503 EMAIL_DELIVERY_FAILED and INVALIDATES created reset token
        const failRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'reset-safe@example.com' }),
        });
        assert.equal(failRes.status, 503);
        const failJson = await failRes.json();
        assert.equal(failJson.code, 'EMAIL_DELIVERY_FAILED');
        assert.ok(capturedResetToken, 'Test transport captured the generated token');

        // Confirm the failed token CANNOT be redeemed!
        const tryRedeem = await fetch(`${baseUrl}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ token: capturedResetToken, newPassword: 'AttackerPassword999!' }),
        });
        assert.equal(tryRedeem.status, 400);
        assert.equal((await tryRedeem.json()).code, 'INVALID_RESET_TOKEN');

        // 2. Real SMTP server rejecting DATA (554) invalidates token and leaves zero usable tokens
        setCustomEmailTransport(null);
        const rejectSmtp = await startLocalSmtpServer({ rejectData: true });
        try {
          process.env.NODE_ENV = 'test';
          process.env.SMTP_HOST = '127.0.0.1';
          process.env.SMTP_PORT = String(rejectSmtp.port);
          process.env.SMTP_SECURE = 'false';
          process.env.SMTP_STARTTLS = 'false';
          process.env.SMTP_USER = 'mailer@aixshop.test';
          process.env.SMTP_PASS = 'SMTP_SECRET_DO_NOT_LOG_999';
          process.env.SMTP_FROM = 'no-reply@aixshop.test';

          const smtpRejectRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ email: 'reset-safe@example.com' }),
          });
          assert.equal(smtpRejectRes.status, 503);
          assert.equal((await smtpRejectRes.json()).code, 'EMAIL_DELIVERY_FAILED');
          const unusedTokens = Array.from((repo as any).passwordResetTokens.values()).filter(
            (t: any) => t.usedAt === null
          );
          assert.equal(unusedTokens.length, 0, 'No usable reset tokens may remain after SMTP rejection');
        } finally {
          await rejectSmtp.close();
        }

        // 3. Anti-enumeration when SMTP auth fails / server is down: known and unknown emails yield identical 503
        const downPortSmtpPort = '59996';
        process.env.SMTP_PORT = downPortSmtpPort;
        const downKnown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'reset-safe@example.com' }),
        });
        const downUnknown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'nonexistent-user@example.com' }),
        });
        assert.equal(downKnown.status, 503);
        assert.equal(downUnknown.status, 503);
        assert.deepEqual(await downKnown.json(), await downUnknown.json());

        // 4. Production unconfigured SMTP fails identically pre-lookup (no account enumeration)
        setValidProductionBaseEnv();
        delete process.env.SMTP_HOST;
        const prodKnown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'reset-safe@example.com' }),
        });
        const prodUnknown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'nonexistent-user@example.com' }),
        });
        assert.equal(prodKnown.status, 503);
        assert.equal(prodUnknown.status, 503);
        assert.deepEqual(await prodKnown.json(), await prodUnknown.json());

        // 5. Recovery after transient failure: healthy SMTP succeeds, retries never create >1 usable token, reset works
        process.env.NODE_ENV = 'test';
        const healthySmtp = await startLocalSmtpServer();
        try {
          process.env.SMTP_HOST = '127.0.0.1';
          process.env.SMTP_PORT = String(healthySmtp.port);
          process.env.SMTP_SECURE = 'false';
          process.env.SMTP_STARTTLS = 'false';
          process.env.SMTP_USER = 'mailer@aixshop.test';
          process.env.SMTP_PASS = 'SMTP_SECRET_DO_NOT_LOG_999';
          process.env.SMTP_FROM = 'no-reply@aixshop.test';

          // Two rapid calls -> only latest token remains unused
          const ok1 = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ email: 'reset-safe@example.com' }),
          });
          const ok2 = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ email: 'reset-safe@example.com' }),
          });
          assert.equal(ok1.status, 200);
          assert.equal(ok2.status, 200);
          const unusedAfterTwo = Array.from((repo as any).passwordResetTokens.values()).filter(
            (t: any) => t.usedAt === null
          );
          assert.equal(unusedAfterTwo.length, 1, 'Retries must invalidate earlier token so at most 1 valid token exists');

          const latestBody = healthySmtp.receivedData[healthySmtp.receivedData.length - 1];
          const tokMatch = latestBody.match(/#reset_token=([^\s\r\n]+)/);
          assert.ok(tokMatch?.[1]);
          const latestToken = decodeURIComponent(tokMatch[1]);

          const resetOk = await fetch(`${baseUrl}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ token: latestToken, newPassword: 'RecoveredPassword456!' }),
          });
          assert.equal(resetOk.status, 200);

          const logsText = capturedLogs.join('\n');
          assert.doesNotMatch(logsText, /SMTP_SECRET_DO_NOT_LOG_999/);
          assert.doesNotMatch(logsText, /#reset_token=/);
          assert.doesNotMatch(logsText, /reset-safe@example\.com/);
        } finally {
          await healthySmtp.close();
        }
      } finally {
        console.warn = origWarn;
        console.error = origErr;
        console.log = origLog;
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      }
    });
  });
});
