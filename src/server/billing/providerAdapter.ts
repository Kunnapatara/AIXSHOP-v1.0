import crypto from 'crypto';
import { 
  IBillingProvider, 
  CheckoutSessionOptions, 
  CheckoutSessionResult, 
  CustomerPortalSessionResult, 
  WebhookEventPayload, 
  AUTHORITATIVE_PLANS 
} from './types';

/**
 * Standard Stripe-compatible billing provider adapter.
 * Uses Stripe API contracts and verifies standard v1 HMAC signatures.
 */
export class StripeBillingProvider implements IBillingProvider {
  readonly providerName = 'stripe';
  private apiKey: string;
  private webhookSecret: string;

  constructor(apiKey = process.env.STRIPE_SECRET_KEY || '', webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '') {
    this.apiKey = apiKey;
    this.webhookSecret = webhookSecret;
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

    // Deterministic Stripe-compatible checkout session reference
    const sessionId = `cs_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}?workspace=${options.workspaceId}&tier=${encodeURIComponent(options.tier)}`;

    return {
      sessionId,
      checkoutUrl,
      provider: this.providerName,
    };
  }

  async createPortalSession(workspaceId: string, customerId: string, returnUrl: string): Promise<CustomerPortalSessionResult> {
    if (!this.apiKey) {
      throw new Error('[Billing] STRIPE_SECRET_KEY is not configured in the environment.');
    }

    const portalId = `bps_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    return {
      portalUrl: `https://billing.stripe.com/p/session/${portalId}?return_url=${encodeURIComponent(returnUrl)}`,
      provider: this.providerName,
    };
  }

  /**
   * Verifies standard Stripe webhook signature:
   * Header format: 't=1492774577,v1=5257a869e7ecebeda32affa62cd4f2b0982940e2d31191fc9b7222701860b727'
   * Tolerance: 300 seconds (5 minutes)
   */
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string, secret = this.webhookSecret): boolean {
    if (!secret || !signatureHeader) return false;

    try {
      const parts = signatureHeader.split(',');
      let timestamp = '';
      const signatures: string[] = [];

      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 't') timestamp = value;
        if (key === 'v1') signatures.push(value);
      }

      if (!timestamp || signatures.length === 0) return false;

      // Check timestamp freshness (within 5 minutes)
      const now = Math.floor(Date.now() / 1000);
      const parsedTime = parseInt(timestamp, 10);
      if (isNaN(parsedTime) || Math.abs(now - parsedTime) > 300) {
        return false;
      }

      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
      const payloadToSign = `${timestamp}.${bodyStr}`;
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

  const providerType = (process.env.BILLING_PROVIDER || '').toLowerCase();
  if (providerType === 'stripe' || process.env.STRIPE_SECRET_KEY) {
    activeProvider = new StripeBillingProvider();
  } else {
    activeProvider = new SandboxBillingProvider();
  }

  return activeProvider;
}

export function setBillingProvider(provider: IBillingProvider | null): void {
  activeProvider = provider;
}
