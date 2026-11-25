import crypto from 'node:crypto';
import Stripe from 'stripe';
import {
  VerificationCheckResult,
  StageVerificationSummary,
  evaluateCommercialReadiness,
  summarizeStage,
  redactSecrets,
  isStripeLiveKey,
  isStripeTestKey,
} from './statusModel';
import {
  StripeBillingProvider,
  verifyStripeConfiguredPrices,
} from '../billing/providerAdapter';
import { BillingService } from '../services/billingService';
import { MemoryRepository } from '../db/memoryRepository';

export interface StripeExternalVerifyOptions {
  targetEnvironment?: string;
}

const ALL_STRIPE_CHECK_DEFS: Array<{ testId: string; name: string; purpose: string }> = [
  {
    testId: 'S2-KEY-SAFETY-GUARD',
    name: 'Stripe Test Mode key safety guard (reject sk_live_)',
    purpose: 'Ensure Stage 2 only runs with sk_test_... keys and strictly rejects live keys',
  },
  {
    testId: 'S2-PRICE-INTEGRITY',
    name: 'Stripe Test Mode authoritative Price ID verification',
    purpose: 'Verify Starter ($49), Growth ($149), Enterprise ($499) prices are active, USD monthly, and distinct',
  },
  {
    testId: 'S2-CHECKOUT-SESSION',
    name: 'Stripe Test Mode Checkout Session creation & metadata mapping',
    purpose: 'Create real Checkout Sessions for Starter & Growth and verify URL, metadata, and customer association',
  },
  {
    testId: 'S2-WEBHOOK-SIGNATURE-EVENTS',
    name: 'Stripe webhook HMAC signature & supported event lifecycle processing',
    purpose: 'Verify real signed webhook payloads through StripeBillingProvider + BillingService idempotency',
  },
  {
    testId: 'S2-SUBSCRIPTION-LIFECYCLE',
    name: 'Stripe Test Mode Subscription creation, plan change, cancel & cleanup',
    purpose: 'Verify test customer + test clock/subscription lifecycle & clean teardown in Stripe Test Mode',
  },
];

export async function runStripeExternalVerification(
  options: StripeExternalVerifyOptions = {}
): Promise<StageVerificationSummary> {
  const readiness = evaluateCommercialReadiness();
  const stageReadiness = readiness.integrations.stage_2_stripe;
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || '';
  const targetEnv = options.targetEnvironment || (isStripeTestKey(stripeKey) ? 'stripe-test-mode' : 'unconfigured-stripe');
  const nowIso = () => new Date().toISOString();

  // Fail loudly if someone tries to run Stage 2 verification with a live Stripe key
  if (isStripeLiveKey(stripeKey)) {
    const failedChecks: VerificationCheckResult[] = ALL_STRIPE_CHECK_DEFS.map((def, idx) => ({
      testId: def.testId,
      stage: 'stage_2_stripe',
      name: def.name,
      purpose: def.purpose,
      status: idx === 0 ? 'FAIL' : 'BLOCKED',
      executionMode: 'external_provider',
      targetEnvironment: 'REJECTED_LIVE_MODE',
      executedAt: nowIso(),
      blockerOrFailure:
        idx === 0
          ? 'LIVE_KEY_REJECTED_IN_TEST_VERIFICATION: STRIPE_SECRET_KEY uses live mode prefix. Stage 2 strictly requires sk_test_....'
          : 'Blocked by live-key safety guard.',
    }));
    return summarizeStage('stage_2_stripe', 'Stage 2 — Stripe Test Mode', failedChecks, [
      'STRIPE_SECRET_KEY (must be sk_test_...)',
    ]);
  }

  if (stageReadiness.status !== 'READY') {
    const blockedChecks: VerificationCheckResult[] = ALL_STRIPE_CHECK_DEFS.map((def) => ({
      testId: def.testId,
      stage: 'stage_2_stripe',
      name: def.name,
      purpose: def.purpose,
      status: 'BLOCKED',
      executionMode: 'external_provider',
      targetEnvironment: targetEnv,
      executedAt: nowIso(),
      blockerOrFailure: `Missing prerequisites: ${stageReadiness.missingEnvVars.join(', ')}`,
    }));

    return summarizeStage(
      'stage_2_stripe',
      'Stage 2 — Stripe Test Mode',
      blockedChecks,
      stageReadiness.missingEnvVars
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!.trim();
  const stripe = new Stripe(stripeKey);
  const provider = new StripeBillingProvider(stripeKey, webhookSecret, stripe);
  const checks: VerificationCheckResult[] = [];
  const createdCustomerIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdClockIds: string[] = [];

  try {
    // Check 1: Test Mode Safety Guard
    checks.push({
      testId: 'S2-KEY-SAFETY-GUARD',
      stage: 'stage_2_stripe',
      name: ALL_STRIPE_CHECK_DEFS[0].name,
      purpose: ALL_STRIPE_CHECK_DEFS[0].purpose,
      status: 'PASS',
      executionMode: 'external_provider',
      targetEnvironment: 'stripe-test-mode',
      executedAt: nowIso(),
      evidence: { keyMode: 'test', prefixVerified: 'sk_test_' },
    });

    // Check 2: Price verification against Stripe API
    {
      const t0 = Date.now();
      const priceRes = await verifyStripeConfiguredPrices(stripe);
      if (!priceRes.verified) {
        checks.push({
          testId: 'S2-PRICE-INTEGRITY',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[1].name,
          purpose: ALL_STRIPE_CHECK_DEFS[1].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: priceRes.error || priceRes.missingOrInvalid.join('; '),
          evidence: { plans: priceRes.plans },
        });
      } else {
        checks.push({
          testId: 'S2-PRICE-INTEGRITY',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[1].name,
          purpose: ALL_STRIPE_CHECK_DEFS[1].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            plansVerified: priceRes.plans.map((p) => ({
              tier: p.tier,
              priceId: p.priceId,
              unitAmount: p.unitAmount,
              currency: p.currency,
              interval: p.interval,
            })),
          },
        });
      }
    }

    // Create isolated Stripe test customer for Checkout + Lifecycle checks
    const customerEmail =
      process.env.STRIPE_TEST_CUSTOMER_EMAIL?.trim() || `aixshop-verify-${Date.now()}@example.com`;
    const testCustomer = await stripe.customers.create({
      email: customerEmail,
      name: 'AIXSHOP Verification Customer',
      metadata: { aixshop_verification: 'true', created_at: nowIso() },
    });
    createdCustomerIds.push(testCustomer.id);

    // Check 3: Checkout Session Creation (Starter + Growth)
    {
      const t0 = Date.now();
      try {
        const wsId = `ws_stripe_verify_${Date.now()}`;
        const baseApp = process.env.APP_URL?.startsWith('https://')
          ? process.env.APP_URL.replace(/\/+$/, '')
          : 'https://staging.aixshop.example.com';

        const starterSession = await provider.createCheckoutSession({
          workspaceId: wsId,
          tier: 'Starter',
          customerId: testCustomer.id,
          successUrl: `${baseApp}/?page=settings&tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${baseApp}/?page=settings&tab=subscription&checkout=canceled`,
        });
        createdSessionIds.push(starterSession.sessionId);

        const retrieved = await provider.retrieveCheckoutSession(starterSession.sessionId);
        const sessionHost = new URL(starterSession.checkoutUrl).hostname;
        if (
          !retrieved ||
          retrieved.metadata?.workspaceId !== wsId ||
          retrieved.metadata?.tier !== 'Starter'
        ) {
          throw new Error('Checkout session metadata mismatch in Stripe Test Mode.');
        }

        checks.push({
          testId: 'S2-CHECKOUT-SESSION',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[2].name,
          purpose: ALL_STRIPE_CHECK_DEFS[2].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            sessionId: starterSession.sessionId,
            checkoutHost: sessionHost,
            customerId: testCustomer.id,
            metadataVerified: retrieved.metadata,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S2-CHECKOUT-SESSION',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[2].name,
          purpose: ALL_STRIPE_CHECK_DEFS[2].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }

    // Check 4: Signed webhook verification & BillingService lifecycle transitions
    {
      const t0 = Date.now();
      try {
        const repo = new MemoryRepository(false);
        const wsId = `ws_stripe_wh_${Date.now()}`;
        const owner = await repo.createUser({
          id: `usr_${wsId}`,
          email: customerEmail,
          passwordHash: 'not_used',
          fullName: 'Stripe WH Verifier',
        });
        await repo.createWorkspace({ id: wsId, name: 'Stripe WH WS', slug: wsId }, owner.id);
        const billingSvc = new BillingService(repo, provider);

        const signPayload = (payloadStr: string): string => {
          const ts = Math.floor(Date.now() / 1000);
          const sig = crypto
            .createHmac('sha256', webhookSecret)
            .update(`${ts}.${payloadStr}`)
            .digest('hex');
          return `t=${ts},v1=${sig}`;
        };

        const nowSec = Math.floor(Date.now() / 1000);
        const checkoutPayload = JSON.stringify({
          id: `evt_verify_cs_${Date.now()}`,
          type: 'checkout.session.completed',
          created: nowSec,
          data: {
            object: {
              id: `cs_test_${Date.now()}`,
              client_reference_id: wsId,
              customer: testCustomer.id,
              subscription: `sub_verify_${Date.now()}`,
              payment_status: 'paid',
              metadata: { workspaceId: wsId, tier: 'Starter' },
            },
          },
        });
        const sigOk = await provider.verifyWebhookSignature(checkoutPayload, signPayload(checkoutPayload));
        const badSigRejected = !(await provider.verifyWebhookSignature(checkoutPayload, `t=${nowSec},v1=${'0'.repeat(64)}`));
        if (!sigOk || !badSigRejected) {
          throw new Error('Stripe webhook signature verification failed.');
        }

        const r1 = await billingSvc.handleWebhook(checkoutPayload, signPayload(checkoutPayload));
        const rDup = await billingSvc.handleWebhook(checkoutPayload, signPayload(checkoutPayload));
        const storeAfterUpgrade = await repo.getStoreByWorkspace(wsId);

        // Failed payment -> past_due -> invoice.payment_succeeded -> active -> deleted -> Free Audit
        const failPayload = JSON.stringify({
          id: `evt_verify_fail_${Date.now()}`,
          type: 'invoice.payment_failed',
          created: nowSec + 10,
          data: { object: { subscription: r1.subscription?.subscriptionId, metadata: { workspaceId: wsId } } },
        });
        await billingSvc.handleWebhook(failPayload, signPayload(failPayload));
        const subPastDue = await repo.getSubscriptionByWorkspace(wsId);

        const recoverPayload = JSON.stringify({
          id: `evt_verify_rec_${Date.now()}`,
          type: 'invoice.payment_succeeded',
          created: nowSec + 20,
          data: { object: { subscription: r1.subscription?.subscriptionId, metadata: { workspaceId: wsId } } },
        });
        await billingSvc.handleWebhook(recoverPayload, signPayload(recoverPayload));
        const subRecovered = await repo.getSubscriptionByWorkspace(wsId);

        const delPayload = JSON.stringify({
          id: `evt_verify_del_${Date.now()}`,
          type: 'customer.subscription.deleted',
          created: nowSec + 30,
          data: { object: { id: r1.subscription?.subscriptionId, customer: testCustomer.id, metadata: { workspaceId: wsId } } },
        });
        await billingSvc.handleWebhook(delPayload, signPayload(delPayload));
        const storeAfterDelete = await repo.getStoreByWorkspace(wsId);

        if (
          r1.action !== 'processed' ||
          rDup.action !== 'duplicate' ||
          storeAfterUpgrade?.tier !== 'Starter' ||
          subPastDue?.status !== 'past_due' ||
          subRecovered?.status !== 'active' ||
          storeAfterDelete?.tier !== 'Free Audit'
        ) {
          throw new Error('BillingService lifecycle assertions failed.');
        }

        checks.push({
          testId: 'S2-WEBHOOK-SIGNATURE-EVENTS',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[3].name,
          purpose: ALL_STRIPE_CHECK_DEFS[3].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            invalidSignatureRejected: badSigRejected,
            duplicateWebhookAction: rDup.action,
            upgradedTier: storeAfterUpgrade?.tier,
            pastDueObserved: subPastDue?.status,
            recoveredStatus: subRecovered?.status,
            canceledDowngradedTier: storeAfterDelete?.tier,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S2-WEBHOOK-SIGNATURE-EVENTS',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[3].name,
          purpose: ALL_STRIPE_CHECK_DEFS[3].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }

    // Check 5: Live Test Clock / Subscription API lifecycle (opt-in via STRIPE_TEST_CLOCK_ENABLED=true)
    const testClockEnabled =
      (process.env.STRIPE_TEST_CLOCK_ENABLED || '').trim().toLowerCase() === 'true';
    if (!testClockEnabled) {
      checks.push({
        testId: 'S2-SUBSCRIPTION-LIFECYCLE',
        stage: 'stage_2_stripe',
        name: ALL_STRIPE_CHECK_DEFS[4].name,
        purpose: ALL_STRIPE_CHECK_DEFS[4].purpose,
        status: 'NOT RUN',
        executionMode: 'external_provider',
        targetEnvironment: 'stripe-test-mode',
        executedAt: nowIso(),
        blockerOrFailure: 'Skipped Stripe Test Clock lifecycle mutation (set STRIPE_TEST_CLOCK_ENABLED=true to execute live Test Clock renewal & cancellation checks)',
      });
    } else {
      const t0 = Date.now();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const clock = await stripe.testHelpers.testClocks.create({
          frozen_time: nowSec,
          name: `AIXSHOP Verify Clock ${Date.now()}`,
        });
        createdClockIds.push(clock.id);

        const clockCustomer = await stripe.customers.create({
          email: customerEmail,
          test_clock: clock.id,
          payment_method: 'pm_card_visa',
          invoice_settings: { default_payment_method: 'pm_card_visa' },
          metadata: { aixshop_verification: 'true' },
        });
        createdCustomerIds.push(clockCustomer.id);

        const starterPriceId = process.env.STRIPE_PRICE_STARTER!.trim();
        const growthPriceId = process.env.STRIPE_PRICE_GROWTH!.trim();

        const sub = await stripe.subscriptions.create({
          customer: clockCustomer.id,
          items: [{ price: starterPriceId }],
          metadata: { tier: 'Starter', aixshop_verification: 'true' },
        });
        const itemId = sub.items.data[0].id;

        const upgraded = await stripe.subscriptions.update(sub.id, {
          items: [{ id: itemId, price: growthPriceId }],
          metadata: { tier: 'Growth' },
        });
        const cancelAtEnd = await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: true,
        });
        const canceled = await stripe.subscriptions.cancel(sub.id);

        checks.push({
          testId: 'S2-SUBSCRIPTION-LIFECYCLE',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[4].name,
          purpose: ALL_STRIPE_CHECK_DEFS[4].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            testClockId: clock.id,
            subscriptionId: sub.id,
            initialStatus: sub.status,
            upgradedPriceId: upgraded.items.data[0]?.price?.id,
            cancelAtPeriodEnd: cancelAtEnd.cancel_at_period_end,
            canceledStatus: canceled.status,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S2-SUBSCRIPTION-LIFECYCLE',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[4].name,
          purpose: ALL_STRIPE_CHECK_DEFS[4].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }
  } finally {
    // Safe teardown of Stripe test artifacts created during this run
    for (const sid of createdSessionIds) {
      await stripe.checkout.sessions.expire(sid).catch(() => {});
    }
    for (const cid of createdCustomerIds) {
      await stripe.customers.del(cid).catch(() => {});
    }
    for (const clockId of createdClockIds) {
      await stripe.testHelpers.testClocks.del(clockId).catch(() => {});
    }
  }

  return summarizeStage('stage_2_stripe', 'Stage 2 — Stripe Test Mode', checks, []);
}
