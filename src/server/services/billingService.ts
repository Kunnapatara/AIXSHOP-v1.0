import { DatabaseRepository } from '../db/repository';
import { 
  IBillingProvider, 
  SubscriptionRecord, 
  BillingEventRecord, 
  PlanTier, 
  AUTHORITATIVE_PLANS,
  WebhookEventPayload 
} from '../billing/types';
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

    return this.provider.createCheckoutSession({
      workspaceId,
      tier,
      successUrl,
      cancelUrl,
    });
  }

  async createPortalSession(workspaceId: string, returnUrl: string) {
    const subscription = await this.repo.getSubscriptionByWorkspace(workspaceId);
    const customerId = subscription?.customerId || `cust_${workspaceId}`;
    return this.provider.createPortalSession(workspaceId, customerId, returnUrl);
  }

  async handleWebhook(rawBody: string | Buffer, signatureHeader: string): Promise<WebhookProcessingResult> {
    // 1. Verify cryptographic webhook signature
    const secret = process.env.STRIPE_WEBHOOK_SECRET || process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123';
    const isValidSignature = this.provider.verifyWebhookSignature(rawBody, signatureHeader, secret);

    if (!isValidSignature) {
      const err: any = new Error('Invalid webhook signature verification failed.');
      err.statusCode = 400;
      throw err;
    }

    // 2. Parse event payload safely
    const event = this.provider.parseWebhookEvent(rawBody);

    // 3. Idempotency Check: Prevent duplicate processing or status regression
    const existingEvent = await this.repo.getBillingEventById(event.id);
    if (existingEvent && existingEvent.status === 'processed') {
      return {
        success: true,
        action: 'duplicate',
        message: `Webhook event ${event.id} was already processed (idempotent no-op).`,
      };
    }

    // 4. Dispatch event by type
    let result: WebhookProcessingResult;
    try {
      result = await this.processEvent(event);

      // Record audit record
      await this.repo.saveBillingEvent({
        id: `bevt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        provider: this.provider.providerName,
        eventId: event.id,
        eventType: event.type,
        idempotencyKey: event.id,
        payload: event,
        status: result.action === 'ignored' ? 'ignored' : 'processed',
        processedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      await this.repo.saveBillingEvent({
        id: `bevt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        provider: this.provider.providerName,
        eventId: event.id,
        eventType: event.type,
        idempotencyKey: event.id,
        payload: event,
        status: 'failed',
        processedAt: new Date().toISOString(),
      });
      throw err;
    }

    return result;
  }

  private async processEvent(event: WebhookEventPayload): Promise<WebhookProcessingResult> {
    const dataObj = event.data?.object || {};

    switch (event.type) {
      case 'checkout.session.completed': {
        const workspaceId = dataObj.client_reference_id || dataObj.metadata?.workspaceId || dataObj.workspaceId;
        const tier: PlanTier = dataObj.metadata?.tier || dataObj.tier || 'Starter';
        const customerId = dataObj.customer || dataObj.customerId || `cust_${workspaceId}`;
        const subscriptionId = dataObj.subscription || dataObj.subscriptionId || `sub_${Date.now()}`;

        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspace reference in checkout session.' };
        }

        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tier.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        const now = new Date();
        const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const subscriptionRecord: SubscriptionRecord = {
          id: `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId,
          subscriptionId,
          tier: plan.tier,
          status: 'active',
          currentPeriodStart: now.toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          cancelAtPeriodEnd: false,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };

        await this.repo.saveSubscription(subscriptionRecord);

        // Synchronize store profile tier and authoritative limit
        const store = await this.repo.getStoreByWorkspace(workspaceId);
        if (store) {
          const updatedStore: StoreProfile = {
            ...store,
            tier: plan.tier,
            skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
          };
          await this.repo.saveStoreProfile(workspaceId, updatedStore);
        }

        return {
          success: true,
          action: 'processed',
          message: `Workspace ${workspaceId} successfully upgraded to ${plan.tier} plan.`,
          subscription: subscriptionRecord,
        };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription update.' };
        }

        const tier: PlanTier = dataObj.metadata?.tier || dataObj.tier || 'Starter';
        const rawStatus = (dataObj.status || 'active').toLowerCase();
        let status: SubscriptionRecord['status'] = 'active';
        if (rawStatus === 'past_due') status = 'past_due';
        else if (rawStatus === 'canceled' || rawStatus === 'cancelled') status = 'canceled';
        else if (rawStatus === 'unpaid' || rawStatus === 'incomplete_expired') status = 'expired';

        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tier.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
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
          cancelAtPeriodEnd: Boolean(dataObj.cancel_at_period_end),
          createdAt: existingSub?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await this.repo.saveSubscription(subRecord);

        // If subscription is active, ensure store limits reflect active tier
        const store = await this.repo.getStoreByWorkspace(workspaceId);
        if (store && status === 'active') {
          const updatedStore: StoreProfile = {
            ...store,
            tier: plan.tier,
            skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
          };
          await this.repo.saveStoreProfile(workspaceId, updatedStore);
        }

        return {
          success: true,
          action: 'processed',
          message: `Subscription updated for workspace ${workspaceId} to status: ${status}.`,
          subscription: subRecord,
        };
      }

      case 'customer.subscription.deleted': {
        const workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription deletion.' };
        }

        const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        if (existingSub) {
          const updatedSub: SubscriptionRecord = {
            ...existingSub,
            status: 'canceled',
            cancelAtPeriodEnd: true,
            updatedAt: new Date().toISOString(),
          };
          await this.repo.saveSubscription(updatedSub);
        }

        // Downgrade store to Free Audit without deleting existing products
        const store = await this.repo.getStoreByWorkspace(workspaceId);
        if (store) {
          const updatedStore: StoreProfile = {
            ...store,
            tier: 'Free Audit',
            skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
          };
          await this.repo.saveStoreProfile(workspaceId, updatedStore);
        }

        return {
          success: true,
          action: 'processed',
          message: `Subscription for workspace ${workspaceId} was canceled and safely downgraded to Free Audit without data loss.`,
        };
      }

      case 'invoice.payment_succeeded': {
        const workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (workspaceId) {
          const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
          if (existingSub && existingSub.status === 'past_due') {
            existingSub.status = 'active';
            existingSub.updatedAt = new Date().toISOString();
            await this.repo.saveSubscription(existingSub);
          }
        }
        return { success: true, action: 'processed', message: 'Invoice payment succeeded recorded.' };
      }

      case 'invoice.payment_failed': {
        const workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (workspaceId) {
          const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
          if (existingSub) {
            existingSub.status = 'past_due';
            existingSub.updatedAt = new Date().toISOString();
            await this.repo.saveSubscription(existingSub);
          }
        }
        return { success: true, action: 'processed', message: 'Invoice payment failure processed; status marked past_due.' };
      }

      default:
        return { success: true, action: 'ignored', message: `Unhandled event type "${event.type}" safely ignored.` };
    }
  }
}
