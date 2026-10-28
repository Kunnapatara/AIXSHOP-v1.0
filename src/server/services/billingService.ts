import { DatabaseRepository } from '../db/repository';
import { 
  IBillingProvider, 
  SubscriptionRecord, 
  BillingEventRecord, 
  PlanTier, 
  AUTHORITATIVE_PLANS,
  WebhookEventPayload 
} from '../billing/types';
import { findPlanByPriceId } from '../billing/providerAdapter';
import { StoreProfile } from '../../types';

export interface WebhookProcessingResult {
  success: boolean;
  action: 'processed' | 'ignored' | 'duplicate';
  message: string;
  subscription?: SubscriptionRecord;
}

export class BillingService {
  private repo: DatabaseRepository;
  private provider: IBillingProvider;

  constructor(repo: DatabaseRepository, provider: IBillingProvider) {
    this.repo = repo;
    this.provider = provider;
  }

  async createCheckoutSession(
    workspaceId: string, 
    tier: PlanTier, 
    successUrl: string, 
    cancelUrl: string
  ) {
    const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
      k => AUTHORITATIVE_PLANS[k].tier === tier
    );
    const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : null;

    if (!plan || plan.priceCents <= 0) {
      throw new Error(`Invalid plan tier "${tier}". Paid checkout is not available for free tiers.`);
    }

    const store = await this.repo.getStoreByWorkspace(workspaceId);
    if (!store) {
      throw new Error(`Workspace store not found for ${workspaceId}`);
    }

    const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
    const customerId = existingSub?.customerId;

    return this.provider.createCheckoutSession({
      workspaceId,
      tier,
      successUrl,
      cancelUrl,
      customerId,
    });
  }

  async createPortalSession(workspaceId: string, returnUrl: string) {
    const subscription = await this.repo.getSubscriptionByWorkspace(workspaceId);
    const customerId = subscription?.customerId;
    if (this.provider.providerName === 'stripe') {
      if (!customerId || !customerId.startsWith('cus_')) {
        throw new Error(`[Billing] Workspace "${workspaceId}" does not have an active customer or subscription record.`);
      }
    }
    return this.provider.createPortalSession(workspaceId, customerId || `cust_${workspaceId}`, returnUrl);
  }

  async handleWebhook(rawBody: string | Buffer, signatureHeader: string): Promise<WebhookProcessingResult> {
    // 1. Resolve webhook secret safely without insecure production fallback
    let secret = '';
    if (this.provider.providerName === 'stripe') {
      secret = (this.provider as any).getWebhookSecret?.() || process.env.STRIPE_WEBHOOK_SECRET || '';
    } else {
      secret = (this.provider as any).getWebhookSecret?.() || process.env.BILLING_WEBHOOK_SECRET || '';
      if (!secret && process.env.NODE_ENV !== 'production') {
        secret = 'sandbox_test_webhook_secret_key_123';
      }
    }

    if (!secret) {
      const err: any = new Error(
        process.env.NODE_ENV === 'production'
          ? 'Production billing webhook secret is not configured.'
          : 'Billing webhook secret is not configured.'
      );
      err.statusCode = 500;
      throw err;
    }

    // 2. Verify cryptographic webhook signature against original raw request bytes
    const isValidSignature = await this.provider.verifyWebhookSignature(rawBody, signatureHeader, secret);

    if (!isValidSignature) {
      const err: any = new Error('Invalid webhook signature verification failed.');
      err.statusCode = 400;
      throw err;
    }

    // 3. Parse event payload safely
    const event = this.provider.parseWebhookEvent(rawBody);

    // 4. Atomic Event Claim (PostgreSQL concurrency & idempotency guard)
    const claimRecord: BillingEventRecord = {
      id: `bevt_${event.id}`,
      provider: this.provider.providerName,
      eventId: event.id,
      eventType: event.type,
      idempotencyKey: event.id,
      payload: event,
      status: 'processing',
      processedAt: new Date().toISOString(),
    };

    const claim = await this.repo.claimBillingEvent(claimRecord);

    if (!claim.claimed) {
      const existingStatus = claim.event?.status;
      if (existingStatus === 'processed') {
        return {
          success: true,
          action: 'duplicate',
          message: `Webhook event ${event.id} was already processed (idempotent no-op).`,
        };
      }
      if (existingStatus === 'ignored') {
        return {
          success: true,
          action: 'ignored',
          message: `Webhook event ${event.id} was previously ignored.`,
        };
      }
      if (existingStatus === 'processing') {
        return {
          success: true,
          action: 'duplicate',
          message: `Webhook event ${event.id} is currently being processed by another worker.`,
        };
      }
    }

    // 5. Dispatch event processing within guarded transaction
    let result: WebhookProcessingResult;
    try {
      result = await this.processEvent(event);

      if (result.action === 'ignored') {
        await this.repo.updateBillingEventStatus(event.id, 'ignored');
      }
    } catch (err: any) {
      await this.repo.updateBillingEventStatus(event.id, 'failed');
      throw err;
    }

    return result;
  }

  private async processEvent(event: WebhookEventPayload): Promise<WebhookProcessingResult> {
    const dataObj = event.data?.object || {};
    const eventCreated = event.created || Math.floor(Date.now() / 1000);

    switch (event.type) {
      case 'checkout.session.completed': {
        const workspaceId = dataObj.client_reference_id || dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspace reference in checkout session.' };
        }

        const workspace = await this.repo.getWorkspaceById(workspaceId);
        if (!workspace) {
          return { success: false, action: 'ignored', message: `Workspace "${workspaceId}" not found in database.` };
        }

        // Validate real Stripe customer and subscription IDs (no fabricated placeholders in Stripe mode)
        const isStripe = this.provider.providerName === 'stripe';
        const customerId = dataObj.customer || dataObj.customerId;
        const subscriptionId = dataObj.subscription || dataObj.subscriptionId;

        if (isStripe) {
          if (!customerId || typeof customerId !== 'string' || !customerId.startsWith('cus_')) {
            throw new Error(`[Billing] Stripe checkout session ${event.id} missing valid customer ID (must start with cus_).`);
          }
          if (!subscriptionId || typeof subscriptionId !== 'string' || !subscriptionId.startsWith('sub_')) {
            throw new Error(`[Billing] Stripe checkout session ${event.id} missing valid subscription ID (must start with sub_).`);
          }
        } else {
          if (!customerId) {
            return { success: false, action: 'ignored', message: 'Missing customer reference in checkout session.' };
          }
        }

        // Verify Price ID if present against authoritative catalog
        const priceId = dataObj.line_items?.data?.[0]?.price?.id || dataObj.priceId || dataObj.metadata?.priceId;
        let planFromPrice = priceId ? findPlanByPriceId(priceId) : null;
        if (priceId && !planFromPrice && isStripe) {
          throw new Error(`[Billing] Configured price ID "${priceId}" is not associated with an authoritative plan.`);
        }

        const tierName = planFromPrice?.tier || dataObj.metadata?.tier || dataObj.tier || 'Starter';
        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tierName.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        // Evaluate payment status: only 'paid' or zero-payment trials grant active store entitlements
        const paymentStatus = (dataObj.payment_status || 'paid').toLowerCase();
        let subStatus: SubscriptionRecord['status'] = 'active';
        let grantTier = true;

        if (paymentStatus === 'paid') {
          subStatus = 'active';
          grantTier = true;
        } else if (paymentStatus === 'no_payment_required') {
          subStatus = 'trialing';
          grantTier = true;
        } else {
          // Delayed or unpaid checkout payment
          subStatus = 'incomplete';
          grantTier = false;
        }

        // Out-of-order check
        const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        if (existingSub && existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale checkout event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const now = new Date();
        const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const subscriptionRecord: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: customerId || `cust_${workspaceId}`,
          subscriptionId: subscriptionId || `sub_${Date.now()}`,
          tier: plan.tier,
          status: subStatus,
          currentPeriodStart: now.toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || now.toISOString(),
          updatedAt: now.toISOString(),
        };

        const storeProfileUpdate = grantTier ? {
          tier: plan.tier,
          skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
        } : undefined;

        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: subscriptionRecord,
          storeProfileUpdate,
          markProcessed: true,
        });

        return {
          success: true,
          action: 'processed',
          message: grantTier 
            ? `Workspace ${workspaceId} successfully upgraded to ${plan.tier} plan.`
            : `Workspace ${workspaceId} checkout recorded with status ${subStatus} (unpaid; tier not elevated).`,
          subscription: subscriptionRecord,
        };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subId = dataObj.id;
        let workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription update.' };
        }

        // Out-of-order event check
        if (existingSub?.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale subscription update event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const tier: PlanTier = dataObj.metadata?.tier || dataObj.tier || existingSub?.tier || 'Starter';
        const rawStatus = (dataObj.status || 'active').toLowerCase();
        const cancelAtPeriodEnd = Boolean(dataObj.cancel_at_period_end);

        let status: SubscriptionRecord['status'] = 'active';
        if (rawStatus === 'trialing') status = 'trialing';
        else if (rawStatus === 'past_due') status = 'past_due';
        else if (rawStatus === 'canceled' || rawStatus === 'cancelled') status = 'canceled';
        else if (rawStatus === 'unpaid') status = 'unpaid';
        else if (rawStatus === 'incomplete') status = 'incomplete';
        else if (rawStatus === 'incomplete_expired') status = 'expired';

        // Do not resurrect already canceled subscriptions with older updates
        if (existingSub?.status === 'canceled' && status !== 'active') {
          return {
            success: true,
            action: 'ignored',
            message: `Subscription for workspace ${workspaceId} is already canceled. Stale status "${status}" ignored.`,
          };
        }

        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tier.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        const subRecord: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: dataObj.customer || existingSub?.customerId || `cust_${workspaceId}`,
          subscriptionId: dataObj.id || existingSub?.subscriptionId || `sub_${Date.now()}`,
          tier: plan.tier,
          status,
          currentPeriodStart: dataObj.current_period_start ? new Date(dataObj.current_period_start * 1000).toISOString() : new Date().toISOString(),
          currentPeriodEnd: dataObj.current_period_end ? new Date(dataObj.current_period_end * 1000).toISOString() : new Date(Date.now() + 30 * 86400000).toISOString(),
          cancelAtPeriodEnd,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Entitlement synchronization:
        // - Active or trialing (even with cancelAtPeriodEnd = true) preserves full paid tier entitlements until period ends!
        // - Canceled or expired immediately downgrades to Free Audit without deleting catalog items.
        let storeProfileUpdate: { tier: PlanTier; skuLimit?: number } | undefined = undefined;

        if (status === 'active' || status === 'trialing') {
          storeProfileUpdate = {
            tier: plan.tier,
            skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
          };
        } else if (status === 'canceled' || status === 'expired') {
          storeProfileUpdate = {
            tier: 'Free Audit',
            skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
          };
        }

        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: subRecord,
          storeProfileUpdate,
          markProcessed: true,
        });

        return {
          success: true,
          action: 'processed',
          message: cancelAtPeriodEnd
            ? `Subscription set to cancel at period end; paid access preserved until ${subRecord.currentPeriodEnd}.`
            : `Subscription updated for workspace ${workspaceId} to status: ${status}.`,
          subscription: subRecord,
        };
      }

      case 'customer.subscription.deleted': {
        const subId = dataObj.id;
        let workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription deletion.' };
        }

        // Out-of-order check
        if (existingSub?.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale subscription deletion event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const updatedSub: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: dataObj.customer || existingSub?.customerId || `cust_${workspaceId}`,
          subscriptionId: dataObj.id || existingSub?.subscriptionId || `sub_${Date.now()}`,
          tier: existingSub?.tier || 'Free Audit',
          status: 'canceled',
          currentPeriodStart: existingSub?.currentPeriodStart || new Date().toISOString(),
          currentPeriodEnd: existingSub?.currentPeriodEnd || new Date().toISOString(),
          cancelAtPeriodEnd: true,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Downgrade store to Free Audit without deleting existing products
        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: updatedSub,
          storeProfileUpdate: {
            tier: 'Free Audit',
            skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
          },
          markProcessed: true,
        });

        return {
          success: true,
          action: 'processed',
          message: `Subscription for workspace ${workspaceId} was canceled and safely downgraded to Free Audit without data loss.`,
          subscription: updatedSub,
        };
      }

      case 'invoice.payment_succeeded': {
        const subId = dataObj.subscription;
        let workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (workspaceId && existingSub) {
          // Out-of-order event check
          if (existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
            return { success: true, action: 'ignored', message: 'Stale invoice payment event safely ignored.' };
          }

          // Do not resurrect canceled subscription
          if (existingSub.status === 'past_due') {
            const updatedSub: SubscriptionRecord = {
              ...existingSub,
              status: 'active',
              lastEventCreated: eventCreated,
              updatedAt: new Date().toISOString(),
            };

            const planDef = AUTHORITATIVE_PLANS[existingSub.tier.toLowerCase().replace(' ', '_')];
            const rawLimit = planDef?.skuLimit;
            const safeSkuLimit = (rawLimit === Infinity || rawLimit === undefined) ? undefined : rawLimit;

            await this.repo.applyBillingTransition({
              eventId: event.id,
              subscription: updatedSub,
              storeProfileUpdate: {
                tier: existingSub.tier,
                skuLimit: safeSkuLimit,
              },
              markProcessed: true,
            });
          }
        }
        return { success: true, action: 'processed', message: 'Invoice payment succeeded recorded.' };
      }

      case 'invoice.payment_failed': {
        const subId = dataObj.subscription;
        let workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (workspaceId && existingSub) {
          // Out-of-order event check
          if (existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
            return { success: true, action: 'ignored', message: 'Stale invoice payment failure event safely ignored.' };
          }

          if (existingSub.status !== 'canceled') {
            const updatedSub: SubscriptionRecord = {
              ...existingSub,
              status: 'past_due',
              lastEventCreated: eventCreated,
              updatedAt: new Date().toISOString(),
            };

            await this.repo.applyBillingTransition({
              eventId: event.id,
              subscription: updatedSub,
              markProcessed: true,
            });
          }
        }
        return { success: true, action: 'processed', message: 'Invoice payment failure processed; status marked past_due.' };
      }

      default:
        return { success: true, action: 'ignored', message: `Unhandled event type "${event.type}" safely ignored.` };
    }
  }
}
