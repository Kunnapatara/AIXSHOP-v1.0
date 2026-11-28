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
  stripeClient?: Stripe;
  testClockPollIntervalMs?: number;
  testClockTimeoutMs?: number;
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
    purpose: 'Verify Starter ($49/mo), Growth ($149/mo), Enterprise ($499/mo) prices are active, USD monthly, and distinct',
  },
  {
    testId: 'S2-CHECKOUT-SESSION',
    name: 'Stripe Test Mode Checkout Sessions (Starter & Growth) & metadata mapping',
    purpose: 'Create & retrieve real Checkout Sessions for both Starter & Growth and verify URL, customer association, workspace & tier metadata',
  },
  {
    testId: 'S2-WEBHOOK-LOCAL-SIMULATION',
    name: 'Stripe webhook HMAC signature & lifecycle simulation (local contract)',
    purpose: 'Verify local HMAC signing, signature rejection, idempotency, and BillingService transitions against MemoryRepository (not live Stripe delivery)',
  },
  {
    testId: 'S2-WEBHOOK-LIVE-DELIVERY',
    name: 'Stripe real deployed webhook delivery verification',
    purpose: 'Verify Stripe actually delivered signed webhook events to the deployed /api/billing/webhook endpoint',
  },
  {
    testId: 'S2-TEST-CLOCK-RENEWAL',
    name: 'Stripe Test Clock advancement, recurring renewal, upgrade & cancellation (opt-in)',
    purpose: 'Advance a real Stripe Test Clock to verify recurring invoice renewal, plan upgrade, cancel_at_period_end, and cancellation',
  },
  {
    testId: 'S2-STRIPE-CLEANUP',
    name: 'Stripe Test Mode temporary object expiration & deletion verification',
    purpose: 'Expire uncompleted Checkout Sessions, delete temporary Customers & Test Clocks, and verify cleanup outcomes',
  },
];

async function waitForTestClockReady(
  stripe: Stripe,
  clockId: string,
  pollIntervalMs = 1500,
  timeoutMs = 30000
): Promise<Stripe.TestHelpers.TestClock> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') {
      return clock;
    }
    if (clock.status === 'internal_failure') {
      throw new Error(`Stripe Test Clock ${clockId} entered internal_failure state.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Stripe Test Clock ${clockId} to become ready (last status: ${clock.status}).`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

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
      executionMode: def.testId === 'S2-WEBHOOK-LOCAL-SIMULATION' ? 'contract_fixture' : 'external_provider',
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
      executionMode: def.testId === 'S2-WEBHOOK-LOCAL-SIMULATION' ? 'contract_fixture' : 'external_provider',
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
  const stripe = options.stripeClient || new Stripe(stripeKey);
  const provider = new StripeBillingProvider(stripeKey, webhookSecret, stripe);
  const checks: VerificationCheckResult[] = [];
  const createdCustomerIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdClockIds: string[] = [];

  const cleanupSummary = {
    trackedSessionIds: [] as string[],
    trackedCustomerIds: [] as string[],
    trackedClockIds: [] as string[],
    expiredSessionIds: [] as string[],
    deletedCustomerIds: [] as string[],
    deletedClockIds: [] as string[],
    errors: [] as string[],
  };

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

    // Check 2: Price verification against Stripe API (Starter $49, Growth $149, Enterprise $499)
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
              active: p.active,
              unitAmount: p.unitAmount,
              currency: p.currency,
              interval: p.interval,
              intervalCount: p.intervalCount,
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

    // Check 3: Checkout Session Creation & Retrieval for BOTH Starter & Growth
    {
      const t0 = Date.now();
      try {
        const wsId = `ws_stripe_verify_${Date.now()}`;
        const baseApp = process.env.APP_URL?.startsWith('https://')
          ? process.env.APP_URL.replace(/\/+$/, '')
          : 'https://staging.aixshop.example.com';

        const verifiedSessions: Array<{
          tier: 'Starter' | 'Growth';
          sessionId: string;
          checkoutHost: string;
          customerId: string;
          metadataVerified: Record<string, string>;
        }> = [];

        for (const tier of ['Starter', 'Growth'] as const) {
          const session = await provider.createCheckoutSession({
            workspaceId: wsId,
            tier,
            customerId: testCustomer.id,
            successUrl: `${baseApp}/?page=settings&tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${baseApp}/?page=settings&tab=subscription&checkout=canceled`,
          });
          createdSessionIds.push(session.sessionId);

          const parsedUrl = new URL(session.checkoutUrl);
          if (parsedUrl.protocol !== 'https:') {
            throw new Error(`Checkout URL for ${tier} must be HTTPS (got ${parsedUrl.protocol}).`);
          }

          const retrieved = await provider.retrieveCheckoutSession(session.sessionId);
          if (!retrieved || retrieved.id !== session.sessionId) {
            throw new Error(`Failed to retrieve Stripe Checkout Session for ${tier} (${session.sessionId}).`);
          }

          const retrievedCustomerId =
            typeof retrieved.customer === 'string'
              ? retrieved.customer
              : retrieved.customer?.id || null;

          if (retrievedCustomerId !== testCustomer.id) {
            throw new Error(
              `Checkout session customer mismatch for ${tier}: expected ${testCustomer.id}, got ${retrievedCustomerId}`
            );
          }

          if (
            retrieved.metadata?.workspaceId !== wsId ||
            retrieved.metadata?.tier !== tier
          ) {
            throw new Error(`Checkout session metadata mismatch for ${tier} in Stripe Test Mode.`);
          }

          verifiedSessions.push({
            tier,
            sessionId: session.sessionId,
            checkoutHost: parsedUrl.hostname,
            customerId: retrievedCustomerId,
            metadataVerified: {
              workspaceId: retrieved.metadata.workspaceId,
              tier: retrieved.metadata.tier,
            },
          });
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
            customerId: testCustomer.id,
            sessionsVerified: verifiedSessions,
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

    // Check 4: Local Signed-Event Simulation (NOT real Stripe webhook delivery)
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
          testId: 'S2-WEBHOOK-LOCAL-SIMULATION',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[3].name,
          purpose: ALL_STRIPE_CHECK_DEFS[3].purpose,
          status: 'PASS — SIMULATED',
          executionMode: 'contract_fixture',
          targetEnvironment: 'local-memory-repo-webhook-sim',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            realExternalWebhookDeliveryProved: false,
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
          testId: 'S2-WEBHOOK-LOCAL-SIMULATION',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[3].name,
          purpose: ALL_STRIPE_CHECK_DEFS[3].purpose,
          status: 'FAIL',
          executionMode: 'contract_fixture',
          targetEnvironment: 'local-memory-repo-webhook-sim',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }

    // Check 5: Actual Deployed Webhook Delivery (explicitly separated from local simulation)
    {
      checks.push({
        testId: 'S2-WEBHOOK-LIVE-DELIVERY',
        stage: 'stage_2_stripe',
        name: ALL_STRIPE_CHECK_DEFS[4].name,
        purpose: ALL_STRIPE_CHECK_DEFS[4].purpose,
        status: 'NOT RUN',
        executionMode: 'external_provider',
        targetEnvironment: 'stripe-test-mode',
        executedAt: nowIso(),
        evidence: {
          realExternalWebhookDeliveryVerified: false,
        },
        blockerOrFailure:
          'Actual deployed Stripe webhook delivery cannot be proved by local signed-event simulation; trigger a real Checkout/invoice event via Stripe CLI or Staging Checkout targeting /api/billing/webhook.',
      });
    }

    // Check 6: Live Test Clock advancement & Subscription Renewal/Lifecycle (opt-in via STRIPE_TEST_CLOCK_ENABLED=true)
    const testClockEnabled =
      (process.env.STRIPE_TEST_CLOCK_ENABLED || '').trim().toLowerCase() === 'true';
    if (!testClockEnabled) {
      checks.push({
        testId: 'S2-TEST-CLOCK-RENEWAL',
        stage: 'stage_2_stripe',
        name: ALL_STRIPE_CHECK_DEFS[5].name,
        purpose: ALL_STRIPE_CHECK_DEFS[5].purpose,
        status: 'NOT RUN',
        executionMode: 'external_provider',
        targetEnvironment: 'stripe-test-mode',
        executedAt: nowIso(),
        blockerOrFailure:
          'Skipped Stripe Test Clock advancement & renewal verification (set STRIPE_TEST_CLOCK_ENABLED=true to execute Test Clock renewal, upgrade, and cancellation checks)',
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
        const initialPeriodEnd =
          (sub as any).current_period_end ??
          sub.items.data[0]?.current_period_end ??
          nowSec + 31 * 86400;

        // Advance Test Clock past initial billing period to exercise real recurring renewal
        const advanceTarget = initialPeriodEnd + 3600;
        await stripe.testHelpers.testClocks.advance(clock.id, {
          frozen_time: advanceTarget,
        });
        const readyClock = await waitForTestClockReady(
          stripe,
          clock.id,
          options.testClockPollIntervalMs,
          options.testClockTimeoutMs
        );

        const renewedSub = await stripe.subscriptions.retrieve(sub.id);
        const renewedPeriodEnd =
          (renewedSub as any).current_period_end ??
          renewedSub.items.data[0]?.current_period_end ??
          0;
        const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
        const renewalInvoice = invoices.data.find(
          (inv) => inv.billing_reason === 'subscription_cycle' && inv.status === 'paid'
        );

        if (!renewalInvoice || renewedPeriodEnd <= initialPeriodEnd) {
          throw new Error(
            `Test Clock advancement did not produce a paid subscription_cycle renewal invoice (initialPeriodEnd=${initialPeriodEnd}, renewedPeriodEnd=${renewedPeriodEnd}).`
          );
        }

        const itemId = renewedSub.items.data[0].id;
        const upgraded = await stripe.subscriptions.update(sub.id, {
          items: [{ id: itemId, price: growthPriceId }],
          metadata: { tier: 'Growth' },
        });
        const cancelAtEnd = await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: true,
        });
        const canceled = await stripe.subscriptions.cancel(sub.id);

        checks.push({
          testId: 'S2-TEST-CLOCK-RENEWAL',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[5].name,
          purpose: ALL_STRIPE_CHECK_DEFS[5].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: 'stripe-test-mode',
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            testClockId: clock.id,
            clockAdvancedTo: readyClock.frozen_time,
            subscriptionId: sub.id,
            initialStatus: sub.status,
            initialPeriodEnd,
            renewedPeriodEnd,
            renewalInvoiceId: renewalInvoice.id,
            renewalInvoiceStatus: renewalInvoice.status,
            upgradedPriceId: upgraded.items.data[0]?.price?.id,
            cancelAtPeriodEnd: cancelAtEnd.cancel_at_period_end,
            canceledStatus: canceled.status,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S2-TEST-CLOCK-RENEWAL',
          stage: 'stage_2_stripe',
          name: ALL_STRIPE_CHECK_DEFS[5].name,
          purpose: ALL_STRIPE_CHECK_DEFS[5].purpose,
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
    const tClean = Date.now();
    cleanupSummary.trackedSessionIds = [...createdSessionIds];
    cleanupSummary.trackedCustomerIds = [...createdCustomerIds];
    cleanupSummary.trackedClockIds = [...createdClockIds];

    for (const sid of createdSessionIds) {
      try {
        const exp = await stripe.checkout.sessions.expire(sid);
        if (exp.status !== 'expired') {
          cleanupSummary.errors.push(`Checkout session ${sid} returned status=${exp.status} after expire().`);
        } else {
          cleanupSummary.expiredSessionIds.push(sid);
        }
      } catch (err: any) {
        // If already expired, verify via retrieve
        try {
          const current = await stripe.checkout.sessions.retrieve(sid);
          if (current.status === 'expired') {
            cleanupSummary.expiredSessionIds.push(sid);
          } else {
            cleanupSummary.errors.push(`Failed expiring session ${sid} (status=${current.status}): ${redactSecrets(err)}`);
          }
        } catch (retErr: any) {
          cleanupSummary.errors.push(`Failed expiring session ${sid}: ${redactSecrets(retErr)}`);
        }
      }
    }

    for (const cid of createdCustomerIds) {
      try {
        const delRes = await stripe.customers.del(cid);
        if (!delRes.deleted) {
          cleanupSummary.errors.push(`Customer ${cid} del() returned deleted=${String(delRes.deleted)}.`);
        } else {
          cleanupSummary.deletedCustomerIds.push(cid);
        }
      } catch (err: any) {
        cleanupSummary.errors.push(`Failed deleting customer ${cid}: ${redactSecrets(err)}`);
      }
    }

    for (const clockId of createdClockIds) {
      try {
        const delClock = await stripe.testHelpers.testClocks.del(clockId);
        if (!delClock.deleted) {
          cleanupSummary.errors.push(`Test Clock ${clockId} del() returned deleted=${String(delClock.deleted)}.`);
        } else {
          cleanupSummary.deletedClockIds.push(clockId);
        }
      } catch (err: any) {
        cleanupSummary.errors.push(`Failed deleting Test Clock ${clockId}: ${redactSecrets(err)}`);
      }
    }

    const totalTracked =
      cleanupSummary.trackedSessionIds.length +
      cleanupSummary.trackedCustomerIds.length +
      cleanupSummary.trackedClockIds.length;

    checks.push({
      testId: 'S2-STRIPE-CLEANUP',
      stage: 'stage_2_stripe',
      name: ALL_STRIPE_CHECK_DEFS[6].name,
      purpose: ALL_STRIPE_CHECK_DEFS[6].purpose,
      status: cleanupSummary.errors.length === 0 ? 'PASS' : 'FAIL',
      executionMode: 'external_provider',
      targetEnvironment: 'stripe-test-mode',
      executedAt: nowIso(),
      durationMs: Date.now() - tClean,
      evidence: {
        trackedCount: totalTracked,
        expiredSessions: cleanupSummary.expiredSessionIds,
        deletedCustomers: cleanupSummary.deletedCustomerIds,
        deletedClocks: cleanupSummary.deletedClockIds,
      },
      ...(cleanupSummary.errors.length > 0
        ? { blockerOrFailure: cleanupSummary.errors.join('; ') }
        : {}),
    });
  }

  return summarizeStage('stage_2_stripe', 'Stage 2 — Stripe Test Mode', checks, []);
}
