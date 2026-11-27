import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import {
  BillingService,
  computeNextRetryAt,
  retryFailedBillingEmails,
  resolveBillingEmailRetryPolicy,
  startBillingEmailRetryScheduler,
} from './services/billingService';
import {
  parseEmailRetryCliArgs,
  resolveBillingEmailRetryCliExitCode,
} from './billing/recoverEmails';
import { SandboxBillingProvider } from './billing/providerAdapter';
import {
  OutgoingEmail,
  setCustomEmailTransport,
  clearDevEmailOutbox,
} from './services/emailService';

function signSandboxWebhook(rawBody: string, secret: string = 'sandbox_test_webhook_secret_key_123'): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('Task D: Checkout Confirmation & Billing Lifecycle Emails (PASS — SIMULATED)', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  before(async () => {
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
    setCustomEmailTransport(null);
    clearDevEmailOutbox();
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

  async function registerUserWorkspace(label: string) {
    const email = `billing-email-${label}-${crypto.randomBytes(4).toString('hex')}@example.test`;
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        email,
        password: 'StrongPassword!2026',
        fullName: `Billing Owner ${label}`,
        workspaceName: `Billing Store ${label}`,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const cookie = extractSessionCookie(res);
    return {
      email,
      userId: body.user.id as string,
      workspaceId: body.workspace.id as string,
      cookie,
    };
  }

  function makeMockCheckoutProvider(sessionOverrides: Record<string, any> = {}) {
    const base = new SandboxBillingProvider();
    return {
      providerName: 'sandbox',
      createCheckoutSession: base.createCheckoutSession.bind(base),
      createPortalSession: base.createPortalSession.bind(base),
      verifyWebhookSignature: base.verifyWebhookSignature.bind(base),
      parseWebhookEvent: base.parseWebhookEvent.bind(base),
      retrieveCheckoutSession: async (sessionId: string) => ({
        id: sessionId,
        status: 'complete',
        payment_status: 'paid',
        customer: 'cus_test_123',
        subscription: `sub_${sessionId}`,
        client_reference_id: sessionOverrides.workspaceId,
        metadata: {
          workspaceId: sessionOverrides.workspaceId,
          tier: sessionOverrides.tier || 'Growth',
        },
        ...sessionOverrides,
      }),
    };
  }

  test('1. createCheckoutSession sends zero emails; verifyCheckoutSession sends initial_payment_confirmed once and deduplicates checkout.session.completed webhook', async () => {
    const sent: OutgoingEmail[] = [];
    setCustomEmailTransport(async (email) => {
      sent.push(email);
      return { delivered: true, mode: 'custom_transport', messageId: `<msg_${sent.length}@test>` };
    });

    try {
      const ws = await registerUserWorkspace('checkout-verify-first');
      const sessionId = `cs_test_${crypto.randomBytes(4).toString('hex')}`;
      const provider = makeMockCheckoutProvider({
        workspaceId: ws.workspaceId,
        tier: 'Growth',
        subscription: `sub_shared_${sessionId}`,
      });
      const billingService = new BillingService(repo, provider as any);

      // Step A: createCheckoutSession must NOT send email
      await billingService.createCheckoutSession(
        ws.workspaceId,
        'Growth',
        'http://localhost:3000/?checkout=success',
        'http://localhost:3000/?checkout=canceled'
      );
      assert.equal(sent.length, 0, 'Initiating checkout must never send payment confirmation email');

      // Step B: verifyCheckoutSession commits upgrade and sends initial confirmation email
      const verified = await billingService.verifyCheckoutSession(ws.workspaceId, sessionId);
      assert.equal(verified.verified, true);
      assert.equal(verified.subscription.tier, 'Growth');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, ws.email);
      assert.match(sent[0].subject, /Payment Confirmed/i);
      assert.match(sent[0].text, /AIXSHOP/);
      assert.match(sent[0].text, /Growth/);
      assert.match(sent[0].text, /\$149\.00 USD/);
      assert.match(sent[0].text, /active/i);

      // Step C: Stripe checkout.session.completed webhook arrives afterward -> deduplicated, still 1 email
      const webhookBody = JSON.stringify({
        id: `evt_chk_${crypto.randomBytes(4).toString('hex')}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: sessionId,
            client_reference_id: ws.workspaceId,
            customer: 'cus_test_123',
            subscription: `sub_shared_${sessionId}`,
            payment_status: 'paid',
            metadata: { workspaceId: ws.workspaceId, tier: 'Growth' },
          },
        },
      });
      const whRes = await billingService.handleWebhook(webhookBody, signSandboxWebhook(webhookBody));
      assert.equal(whRes.success, true);
      assert.equal(sent.length, 1, 'Duplicate checkout.session.completed after verify must not double-send email');

      const deliveries = await repo.listBillingEmailDeliveries(ws.workspaceId);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].eventType, 'initial_payment_confirmed');
      assert.equal(deliveries[0].status, 'sent');
      assert.equal(deliveries[0].smtpMessageAccepted, true);
      assert.equal(deliveries[0].inboxDeliveryConfirmed, false);
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('2. Reverse order: checkout.session.completed webhook sends initial email once; subsequent verifyCheckoutSession deduplicates', async () => {
    const sent: OutgoingEmail[] = [];
    setCustomEmailTransport(async (email) => {
      sent.push(email);
      return { delivered: true, mode: 'custom_transport', messageId: `<msg_rev_${sent.length}@test>` };
    });

    try {
      const ws = await registerUserWorkspace('webhook-first');
      const sessionId = `cs_rev_${crypto.randomBytes(4).toString('hex')}`;
      const sharedSubId = `sub_rev_${sessionId}`;
      const provider = makeMockCheckoutProvider({
        workspaceId: ws.workspaceId,
        tier: 'Starter',
        subscription: sharedSubId,
      });
      const billingService = new BillingService(repo, provider as any);

      const webhookBody = JSON.stringify({
        id: `evt_rev_${crypto.randomBytes(4).toString('hex')}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: sessionId,
            client_reference_id: ws.workspaceId,
            customer: 'cus_rev_123',
            subscription: sharedSubId,
            payment_status: 'paid',
            metadata: { workspaceId: ws.workspaceId, tier: 'Starter' },
          },
        },
      });
      await billingService.handleWebhook(webhookBody, signSandboxWebhook(webhookBody));
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /\$49\.00 USD/);

      await billingService.verifyCheckoutSession(ws.workspaceId, sessionId);
      assert.equal(sent.length, 1, 'verifyCheckoutSession after webhook must deduplicate initial confirmation email');
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('3. Lifecycle emails: skips subscription_create invoice, sends recurring_renewal, plan_changed, payment_failed, and subscription_canceled', async () => {
    const sent: OutgoingEmail[] = [];
    setCustomEmailTransport(async (email) => {
      sent.push(email);
      return { delivered: true, mode: 'custom_transport', messageId: `<msg_lc_${sent.length}@test>` };
    });

    try {
      const ws = await registerUserWorkspace('lifecycle');
      const provider = new SandboxBillingProvider();
      const billingService = new BillingService(repo, provider);
      const baseTs = Math.floor(Date.now() / 1000);
      const subId = `sub_lc_${crypto.randomBytes(4).toString('hex')}`;

      const postWebhook = async (event: any) => {
        const raw = JSON.stringify(event);
        return billingService.handleWebhook(raw, signSandboxWebhook(raw));
      };

      // 1. Checkout completed -> initial_payment_confirmed (Starter $49)
      await postWebhook({
        id: `evt_lc_1_${crypto.randomBytes(3).toString('hex')}`,
        type: 'checkout.session.completed',
        created: baseTs + 1,
        data: {
          object: {
            id: 'cs_lc_1',
            client_reference_id: ws.workspaceId,
            customer: 'cus_lc_1',
            subscription: subId,
            payment_status: 'paid',
            metadata: { workspaceId: ws.workspaceId, tier: 'Starter' },
          },
        },
      });
      assert.equal(sent.length, 1);

      // 2. Initial invoice.payment_succeeded (billing_reason=subscription_create) -> NO duplicate email
      await postWebhook({
        id: `evt_lc_2_${crypto.randomBytes(3).toString('hex')}`,
        type: 'invoice.payment_succeeded',
        created: baseTs + 2,
        data: {
          object: {
            id: 'in_initial_1',
            subscription: subId,
            billing_reason: 'subscription_create',
            amount_paid: 4900,
            currency: 'usd',
            metadata: { workspaceId: ws.workspaceId },
          },
        },
      });
      assert.equal(sent.length, 1);

      // 3. Monthly recurring renewal (billing_reason=subscription_cycle) -> sends recurring_renewal
      await postWebhook({
        id: `evt_lc_3_${crypto.randomBytes(3).toString('hex')}`,
        type: 'invoice.payment_succeeded',
        created: baseTs + 3,
        data: {
          object: {
            id: 'in_cycle_2',
            subscription: subId,
            billing_reason: 'subscription_cycle',
            amount_paid: 4900,
            currency: 'usd',
            metadata: { workspaceId: ws.workspaceId },
          },
        },
      });
      assert.equal(sent.length, 2);
      assert.match(sent[1].subject, /Renewed/i);

      // 4. Plan changed Starter -> Growth -> sends plan_changed
      await postWebhook({
        id: `evt_lc_4_${crypto.randomBytes(3).toString('hex')}`,
        type: 'customer.subscription.updated',
        created: baseTs + 4,
        data: {
          object: {
            id: subId,
            customer: 'cus_lc_1',
            status: 'active',
            cancel_at_period_end: false,
            metadata: { workspaceId: ws.workspaceId, tier: 'Growth' },
          },
        },
      });
      assert.equal(sent.length, 3);
      assert.match(sent[2].subject, /Plan Updated to Growth/i);
      assert.match(sent[2].text, /Previous Plan: Starter/);
      assert.match(sent[2].text, /\$149\.00 USD/);

      // 5. Payment failed -> sends payment_failed
      await postWebhook({
        id: `evt_lc_5_${crypto.randomBytes(3).toString('hex')}`,
        type: 'invoice.payment_failed',
        created: baseTs + 5,
        data: {
          object: {
            id: 'in_fail_3',
            subscription: subId,
            amount_due: 14900,
            currency: 'usd',
            metadata: { workspaceId: ws.workspaceId },
          },
        },
      });
      assert.equal(sent.length, 4);
      assert.match(sent[3].subject, /Payment Action Required/i);

      // 6. Subscription deleted -> sends subscription_canceled
      await postWebhook({
        id: `evt_lc_6_${crypto.randomBytes(3).toString('hex')}`,
        type: 'customer.subscription.deleted',
        created: baseTs + 6,
        data: {
          object: {
            id: subId,
            customer: 'cus_lc_1',
            metadata: { workspaceId: ws.workspaceId },
          },
        },
      });
      assert.equal(sent.length, 5);
      assert.match(sent[4].subject, /Subscription Canceled/i);

      // Verify tenant-scoped delivery history endpoint
      const otherWs = await registerUserWorkspace('other-tenant');
      const ownHistoryRes = await fetch(`${baseUrl}/api/billing/email-deliveries`, {
        headers: { Cookie: `aixshop_session=${ws.cookie}` },
      });
      assert.equal(ownHistoryRes.status, 200);
      const ownHistory = await ownHistoryRes.json();
      assert.equal(ownHistory.deliveries.length, 5);

      const otherHistoryRes = await fetch(`${baseUrl}/api/billing/email-deliveries`, {
        headers: { Cookie: `aixshop_session=${otherWs.cookie}` },
      });
      assert.equal(otherHistoryRes.status, 200);
      const otherHistory = await otherHistoryRes.json();
      assert.equal(otherHistory.deliveries.length, 0, 'Billing email deliveries must be strictly workspace isolated');
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('4. Non-blocking email failure: SMTP/transport error does NOT fail billing verification and retryFailedBillingEmails recovers cleanly', async () => {
    let shouldFail = true;
    const deliveredEmails: OutgoingEmail[] = [];
    setCustomEmailTransport(async (email) => {
      if (shouldFail) {
        throw new Error('SMTP 451 temporary error AUTH PLAIN secret_password_xyz');
      }
      deliveredEmails.push(email);
      return { delivered: true, mode: 'custom_transport', messageId: '<msg_recovered@test>' };
    });

    try {
      const ws = await registerUserWorkspace('fail-and-retry');
      const sessionId = `cs_fail_${crypto.randomBytes(4).toString('hex')}`;
      const provider = makeMockCheckoutProvider({
        workspaceId: ws.workspaceId,
        tier: 'Enterprise',
        subscription: `sub_fail_${sessionId}`,
      });
      const billingService = new BillingService(repo, provider as any);

      // Billing verify MUST succeed even while email transport throws
      const verified = await billingService.verifyCheckoutSession(ws.workspaceId, sessionId);
      assert.equal(verified.verified, true);
      assert.equal(verified.subscription.tier, 'Enterprise');
      assert.equal(deliveredEmails.length, 0);

      const failedLogs = await repo.listBillingEmailDeliveries(ws.workspaceId);
      assert.equal(failedLogs.length, 1);
      assert.equal(failedLogs[0].status, 'failed');
      assert.doesNotMatch(failedLogs[0].errorMessage || '', /secret_password_xyz/);

      // Make delivery record eligible immediately for retry test
      await repo.updateBillingEmailDeliveryStatus(failedLogs[0].id, {
        status: 'failed',
        nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      });

      shouldFail = false;
      const retrySummary = await retryFailedBillingEmails(repo);
      assert.equal(retrySummary.sent >= 1, true);
      assert.equal(deliveredEmails.length, 1);
      assert.match(deliveredEmails[0].text, /\$499\.00 USD/);

      const afterLogs = await repo.listBillingEmailDeliveries(ws.workspaceId);
      assert.equal(afterLogs[0].status, 'sent');
      assert.equal(afterLogs[0].attemptCount, 2);
      assert.equal(afterLogs[0].smtpMessageAccepted, true);
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('5. Exponential backoff & maxAttempts: failed retries back off exponentially until permanently_failed with nextRetryAt=null', async () => {
    const fixedNow = Date.now();
    assert.equal(
      computeNextRetryAt(1, 60_000, 3_600_000, fixedNow),
      new Date(fixedNow + 60_000).toISOString()
    );
    assert.equal(
      computeNextRetryAt(2, 60_000, 3_600_000, fixedNow),
      new Date(fixedNow + 120_000).toISOString()
    );
    assert.equal(
      computeNextRetryAt(3, 60_000, 3_600_000, fixedNow),
      new Date(fixedNow + 240_000).toISOString()
    );
    assert.equal(
      computeNextRetryAt(10, 60_000, 3_600_000, fixedNow),
      new Date(fixedNow + 3_600_000).toISOString(),
      'Exponential backoff must be capped at maxBackoffMs'
    );

    const permanentAlerts: Array<{ deliveryId: string; attemptCount: number; errorMessage: string }> = [];
    setCustomEmailTransport(async () => {
      throw new Error('SMTP 421 upstream temporarily unavailable password=top_secret_val');
    });

    try {
      const isoRepo = new MemoryRepository(false);
      const createdUser = await isoRepo.createUser({
        id: 'usr_backoff',
        email: 'backoff@example.test',
        passwordHash: 'hash',
        fullName: 'Backoff Owner',
      });
      assert.equal(createdUser.id, 'usr_backoff');
      const ws = await isoRepo.createWorkspace(
        { id: 'ws_backoff', name: 'Backoff Store', slug: 'backoff-store' },
        'usr_backoff'
      );

      // Initial failed claim (attemptCount = 1)
      const claim1 = await isoRepo.createOrClaimBillingEmailDelivery({
        id: 'bemail_backoff_1',
        workspaceId: ws.workspace.id,
        deliveryKey: 'billing_email:backoff:1',
        eventType: 'initial_payment_confirmed',
        recipientEmail: 'backoff@example.test',
        tier: 'Starter',
        amountCents: 4900,
        currency: 'USD',
        payload: { tier: 'Starter' },
      });
      assert.equal(claim1.claimed, true);
      await isoRepo.updateBillingEmailDeliveryStatus(claim1.record.id, {
        status: 'failed',
        errorMessage: 'Initial failure',
        nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Retry #1 (attemptCount -> 2) with maxAttempts=3 -> failed with 120s backoff
      const sum1 = await retryFailedBillingEmails(isoRepo, {
        maxAttempts: 3,
        baseBackoffMs: 60_000,
        maxBackoffMs: 3_600_000,
        nowMs: fixedNow,
        onPermanentFailure: (info) => {
          permanentAlerts.push(info);
        },
      });
      assert.equal(sum1.retried, 1);
      assert.equal(sum1.failed, 1);
      assert.equal(sum1.permanentlyFailed, 0);

      let rec = await isoRepo.getBillingEmailDeliveryByKey('billing_email:backoff:1');
      assert.equal(rec?.status, 'failed');
      assert.equal(rec?.attemptCount, 2);
      assert.equal(rec?.nextRetryAt, new Date(fixedNow + 120_000).toISOString());
      assert.doesNotMatch(rec?.errorMessage || '', /top_secret_val/);

      // Not due yet -> skipped by scheduler until nextRetryAt
      const sumNotDue = await retryFailedBillingEmails(isoRepo, { maxAttempts: 3 });
      assert.equal(sumNotDue.scanned, 0);
      assert.equal(sumNotDue.retried, 0);

      // Simulate time advancing past retry #2 -> attemptCount -> 3 -> permanently_failed
      await isoRepo.updateBillingEmailDeliveryStatus(rec!.id, {
        status: 'failed',
        nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      });
      const sum2 = await retryFailedBillingEmails(isoRepo, {
        maxAttempts: 3,
        baseBackoffMs: 60_000,
        maxBackoffMs: 3_600_000,
        nowMs: fixedNow + 200_000,
        onPermanentFailure: (info) => {
          permanentAlerts.push(info);
        },
      });
      assert.equal(sum2.retried, 1);
      assert.equal(sum2.failed, 1);
      assert.equal(sum2.permanentlyFailed, 1);
      assert.equal(permanentAlerts.length, 1);
      assert.equal(permanentAlerts[0].attemptCount, 3);
      assert.doesNotMatch(permanentAlerts[0].errorMessage, /top_secret_val/);

      rec = await isoRepo.getBillingEmailDeliveryByKey('billing_email:backoff:1');
      assert.equal(rec?.status, 'permanently_failed');
      assert.equal(rec?.attemptCount, 3);
      assert.equal(rec?.nextRetryAt, null);

      // Permanently failed records are never retried or re-claimed automatically
      const claimAfterPerm = await isoRepo.createOrClaimBillingEmailDelivery({
        id: 'bemail_backoff_dup',
        workspaceId: ws.workspace.id,
        deliveryKey: 'billing_email:backoff:1',
        eventType: 'initial_payment_confirmed',
        recipientEmail: 'backoff@example.test',
        allowRetryFailed: true,
        maxAttempts: 10,
      });
      assert.equal(claimAfterPerm.claimed, false);
      const sum3 = await retryFailedBillingEmails(isoRepo, { maxAttempts: 10 });
      assert.equal(sum3.scanned, 0);
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('6. Concurrency protection & deduplication: simultaneous retry sweeps deliver once and prevent duplicate sends', async () => {
    let sendCalls = 0;
    setCustomEmailTransport(async () => {
      sendCalls += 1;
      // Delay slightly so two parallel sweep workers overlap while first claim is pending
      await new Promise((r) => setTimeout(r, 40));
      return { delivered: true, mode: 'custom_transport', messageId: `<concurrent_${sendCalls}@test>` };
    });

    try {
      const isoRepo = new MemoryRepository(false);
      await isoRepo.createOrClaimBillingEmailDelivery({
        id: 'bemail_concurrent_1',
        workspaceId: 'ws_conc',
        deliveryKey: 'billing_email:conc:1',
        eventType: 'recurring_renewal',
        recipientEmail: 'conc@example.test',
        tier: 'Growth',
        amountCents: 14900,
        currency: 'USD',
        payload: { tier: 'Growth' },
      });
      await isoRepo.updateBillingEmailDeliveryStatus('bemail_concurrent_1', {
        status: 'failed',
        errorMessage: 'Transient disconnect',
        nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      });

      const [sweepA, sweepB] = await Promise.all([
        retryFailedBillingEmails(isoRepo, { maxAttempts: 5 }),
        retryFailedBillingEmails(isoRepo, { maxAttempts: 5 }),
      ]);

      assert.equal(sendCalls, 1, 'Exactly one email transport call must occur across concurrent retry sweeps');
      assert.equal(sweepA.sent + sweepB.sent, 1);
      assert.equal(sweepA.skippedContended + sweepB.skippedContended, 1);

      // Subsequent sweep or claim sees status=sent and skips cleanly
      const sweepC = await retryFailedBillingEmails(isoRepo, { maxAttempts: 5 });
      assert.equal(sweepC.scanned, 0);
      assert.equal(sendCalls, 1);
    } finally {
      setCustomEmailTransport(null);
    }
  });

  test('7. Scheduler & CLI recovery helper: startBillingEmailRetryScheduler enforces in-flight guard and CLI parses flags', async () => {
    let transportCalls = 0;
    setCustomEmailTransport(async () => {
      transportCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { delivered: true, mode: 'custom_transport', messageId: '<sched_1@test>' };
    });

    try {
      const isoRepo = new MemoryRepository(false);
      await isoRepo.createOrClaimBillingEmailDelivery({
        id: 'bemail_sched_1',
        workspaceId: 'ws_sched',
        deliveryKey: 'billing_email:sched:1',
        eventType: 'plan_changed',
        recipientEmail: 'sched@example.test',
        tier: 'Enterprise',
        amountCents: 49900,
        currency: 'USD',
        payload: { tier: 'Enterprise', previousTier: 'Growth' },
      });
      await isoRepo.updateBillingEmailDeliveryStatus('bemail_sched_1', {
        status: 'failed',
        errorMessage: 'Temporary DNS error',
        nextRetryAt: new Date(Date.now() - 500).toISOString(),
      });

      const logged: Array<Record<string, unknown>> = [];
      const scheduler = startBillingEmailRetryScheduler(isoRepo, {
        intervalMs: 60_000,
        maxAttempts: 5,
        log: (_msg, meta) => {
          if (meta) logged.push(meta);
        },
      });

      try {
        const [run1, run2] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
        assert.ok(run1 || run2);
        // Second overlapping runOnce returns null due to in-flight guard
        assert.equal(run1 !== null && run2 !== null, false);
        assert.equal(transportCalls, 1);
        assert.equal(logged.length, 1);
        assert.equal(logged[0].sent, 1);
      } finally {
        scheduler.stop();
      }

      const policy = resolveBillingEmailRetryPolicy({ maxAttempts: 7, baseBackoffMs: 15_000, maxBackoffMs: 300_000 });
      assert.deepEqual(policy, { maxAttempts: 7, baseBackoffMs: 15_000, maxBackoffMs: 300_000 });

      const parsed = parseEmailRetryCliArgs([
        '--limit=20',
        '--max-attempts=4',
        '--base-backoff-ms=5000',
        '--max-backoff-ms=60000',
      ]);
      assert.deepEqual(parsed, {
        limit: 20,
        maxAttempts: 4,
        baseBackoffMs: 5000,
        maxBackoffMs: 60000,
      });
      assert.equal(
        resolveBillingEmailRetryCliExitCode({
          scanned: 1,
          retried: 1,
          sent: 1,
          failed: 0,
          permanentlyFailed: 0,
          skippedContended: 0,
        }),
        0
      );
      assert.equal(
        resolveBillingEmailRetryCliExitCode({
          scanned: 1,
          retried: 1,
          sent: 0,
          failed: 1,
          permanentlyFailed: 1,
          skippedContended: 0,
        }),
        1
      );
    } finally {
      setCustomEmailTransport(null);
    }
  });
});
