import crypto from 'crypto';
import Stripe from 'stripe';
import { 
  IBillingProvider, 
  CheckoutSessionOptions, 
  CheckoutSessionResult, 
  CustomerPortalSessionResult, 
  WebhookEventPayload, 
  AUTHORITATIVE_PLANS,
  PlanTier 
} from './types';

/**
 * Resolves configured Stripe Price ID for a given plan tier.
 * Price IDs are external Stripe resources and must be explicitly configured via
 * environment variables (e.g. STRIPE_PRICE_STARTER or STRIPE_PRICE_ID_STARTER)
 * or injected via priceMap for testing.
 */
export function getPlanPriceId(tier: PlanTier, priceMap?: Record<string, string>): string | undefined {
  if (priceMap) {
    if (priceMap[tier]) return priceMap[tier];
    const lowerTier = tier.toLowerCase();
    for (const [k, v] of Object.entries(priceMap)) {
      if (k.toLowerCase() === lowerTier) return v;
    }
  }

  switch (tier) {
    case 'Starter':
      return process.env.STRIPE_PRICE_STARTER || process.env.STRIPE_PRICE_ID_STARTER;
    case 'Growth':
      return process.env.STRIPE_PRICE_GROWTH || process.env.STRIPE_PRICE_ID_GROWTH;
    case 'Enterprise':
      return process.env.STRIPE_PRICE_ENTERPRISE || process.env.STRIPE_PRICE_ID_ENTERPRISE;
    default:
      return undefined;
  }
}

/**
 * Standard Stripe billing provider adapter.
 * Uses official Stripe SDK to create genuine Checkout Sessions, Customer Portal Sessions,
 * and verify incoming webhooks against original request bytes.
 */
export class StripeBillingProvider implements IBillingProvider {
  readonly providerName = 'stripe';
  private apiKey: string;
  private webhookSecret: string;
  private stripe: Stripe;
  private priceMap?: Record<string, string>;

  constructor(
    apiKey = process.env.STRIPE_SECRET_KEY || '',
    webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '',
    stripeClient?: Stripe,
    priceMap?: Record<string, string>
  ) {
    this.apiKey = apiKey;
    this.webhookSecret = webhookSecret;
    this.priceMap = priceMap;

    if (stripeClient) {
      this.stripe = stripeClient;
    } else if (this.apiKey) {
      this.stripe = new Stripe(this.apiKey);
    } else {
      // Lazy placeholder client until valid API key is configured or injected
      this.stripe = (null as any);
    }
  }

  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  async createCheckoutSession(options: CheckoutSessionOptions): Promise<CheckoutSessionResult> {
    if (!this.apiKey) {
      throw new Error('[Billing] STRIPE_SECRET_KEY is not configured in the environment.');
    }

    const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
      k => AUTHORITATIVE_PLANS[k].tier === options.tier
    );
    const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : null;

    if (!plan || plan.priceCents <= 0) {
      throw new Error(`[Billing] Cannot create paid checkout session for plan "${options.tier}".`);
    }

    const priceId = getPlanPriceId(options.tier, this.priceMap);
    if (!priceId) {
      const envKey = `STRIPE_PRICE_${options.tier.toUpperCase().replace(/\s+/g, '_')}`;
      throw new Error(`[Billing] Stripe Price ID is not configured for plan tier "${options.tier}". Please configure ${envKey}.`);
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      client_reference_id: options.workspaceId,
      metadata: {
        workspaceId: options.workspaceId,
        tier: options.tier,
      },
      subscription_data: {
        metadata: {
          workspaceId: options.workspaceId,
          tier: options.tier,
        },
      },
    };

    if (options.customerId && options.customerId.startsWith('cus_')) {
      sessionParams.customer = options.customerId;
    } else if (options.customerEmail) {
      sessionParams.customer_email = options.customerEmail;
    }

    try {
      const session = await this.stripe.checkout.sessions.create(sessionParams);
      if (!session || !session.id || !session.url) {
        throw new Error('[Billing] Stripe checkout session response was malformed or missing URL.');
      }

      return {
        sessionId: session.id,
        checkoutUrl: session.url,
        provider: this.providerName,
      };
    } catch (err: any) {
      if (err.message?.startsWith('[Billing]')) throw err;
      throw new Error(`[Billing] Stripe checkout session creation failed: ${err.message || 'Unknown Stripe API error'}`);
    }
  }

  async createPortalSession(workspaceId: string, customerId: string, returnUrl: string): Promise<CustomerPortalSessionResult> {
    if (!this.apiKey) {
      throw new Error('[Billing] STRIPE_SECRET_KEY is not configured in the environment.');
    }

    if (!customerId || !customerId.startsWith('cus_')) {
      throw new Error(`[Billing] Workspace "${workspaceId}" does not have a valid Stripe customer mapping.`);
    }

    try {
      const portalSession = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      if (!portalSession || !portalSession.url) {
        throw new Error('[Billing] Stripe customer portal session response was malformed.');
      }

      return {
        portalUrl: portalSession.url,
        provider: this.providerName,
      };
    } catch (err: any) {
      if (err.message?.startsWith('[Billing]')) throw err;
      throw new Error(`[Billing] Stripe customer portal session creation failed: ${err.message || 'Unknown Stripe API error'}`);
    }
  }

  async verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string, secret = this.webhookSecret): Promise<boolean> {
    if (!secret || !signatureHeader) return false;

    try {
      const payloadStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
      
      if (this.stripe?.webhooks?.signature?.verifyHeaderAsync) {
        await this.stripe.webhooks.signature.verifyHeaderAsync(
          payloadStr,
          signatureHeader,
          secret,
          300
        );
        return true;
      }

      // Synchronous fallback verification using Stripe v1 format (t=...,v1=...)
      const parts = signatureHeader.split(',');
      let timestamp = '';
      const signatures: string[] = [];

      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 't') timestamp = value;
        if (key === 'v1') signatures.push(value);
      }

      if (!timestamp || signatures.length === 0) return false;

      const now = Math.floor(Date.now() / 1000);
      const parsedTime = parseInt(timestamp, 10);
      if (isNaN(parsedTime) || Math.abs(now - parsedTime) > 300) {
        return false;
      }

      const payloadToSign = `${timestamp}.${payloadStr}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadToSign)
        .digest('hex');

      return signatures.some(sig => {
        try {
          return crypto.timingSafeEqual(
            Buffer.from(sig, 'hex'),
            Buffer.from(expectedSignature, 'hex')
          );
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string | Buffer): WebhookEventPayload {
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const parsed = JSON.parse(bodyStr);
    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.type) {
      throw new Error('[Billing] Malformed webhook event payload');
    }
    return parsed as WebhookEventPayload;
  }
}

/**
 * Deterministic sandbox provider adapter for local development, staging, and automated tests.
 * Enables full end-to-end billing lifecycle testing without requiring external live payment credentials.
 */
export class SandboxBillingProvider implements IBillingProvider {
  readonly providerName = 'sandbox';
  private secret: string;

  constructor(secret = process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123') {
    this.secret = secret;
  }

  getWebhookSecret(): string {
    return this.secret;
  }

  async createCheckoutSession(options: CheckoutSessionOptions): Promise<CheckoutSessionResult> {
    const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
      k => AUTHORITATIVE_PLANS[k].tier === options.tier
    );
    const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : null;

    if (!plan || plan.priceCents <= 0) {
      throw new Error(`[Billing] Cannot create paid checkout session for plan "${options.tier}".`);
    }

    const sessionId = `sbx_cs_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const checkoutUrl = `${options.successUrl}?session_id=${sessionId}&provider=sandbox&tier=${encodeURIComponent(options.tier)}`;

    return {
      sessionId,
      checkoutUrl,
      provider: this.providerName,
    };
  }

  async createPortalSession(workspaceId: string, customerId: string, returnUrl: string): Promise<CustomerPortalSessionResult> {
    const portalId = `sbx_bps_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    return {
      portalUrl: `${returnUrl}?portal_session_id=${portalId}&provider=sandbox`,
      provider: this.providerName,
    };
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string, secret = this.secret): boolean {
    if (!signatureHeader || !secret) return false;

    try {
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
      
      // Supports both plain HMAC-SHA256 and Stripe-style 't=...,v1=...' format
      if (signatureHeader.includes('v1=')) {
        const parts = signatureHeader.split(',');
        let timestamp = '';
        let sig = '';
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k === 't') timestamp = v;
          if (k === 'v1') sig = v;
        }
        if (!timestamp || !sig) return false;
        const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      }

      const expected = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string | Buffer): WebhookEventPayload {
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const parsed = JSON.parse(bodyStr);
    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.type) {
      throw new Error('[Billing] Malformed webhook event payload');
    }
    return parsed as WebhookEventPayload;
  }

  /**
   * Test helper: Generate signed webhook payload for unit and integration tests.
   */
  generateSignedPayload(event: any, customSecret = this.secret): { payload: string; signature: string } {
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signatureHash = crypto
      .createHmac('sha256', customSecret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const signature = `t=${timestamp},v1=${signatureHash}`;
    return { payload, signature };
  }
}

let activeProvider: IBillingProvider | null = null;

export function getBillingProvider(): IBillingProvider {
  if (activeProvider) return activeProvider;

  const env = process.env.NODE_ENV || 'development';
  const providerType = (process.env.BILLING_PROVIDER || '').toLowerCase();

  if (env === 'production') {
    // In production, fallback to sandbox billing is strictly forbidden.
    if (providerType === 'sandbox') {
      throw new Error('[Billing] Sandbox billing provider is strictly prohibited in production mode.');
    }
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      throw new Error('[Billing] Production billing requires STRIPE_SECRET_KEY to be configured.');
    }
    activeProvider = new StripeBillingProvider(apiKey, process.env.STRIPE_WEBHOOK_SECRET);
    return activeProvider;
  }

  // Non-production (development, test):
  if (providerType === 'stripe' || (providerType !== 'sandbox' && process.env.STRIPE_SECRET_KEY)) {
    activeProvider = new StripeBillingProvider();
  } else {
    activeProvider = new SandboxBillingProvider();
  }

  return activeProvider;
}

export function setBillingProvider(provider: IBillingProvider | null): void {
  activeProvider = provider;
}

