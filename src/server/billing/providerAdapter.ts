import crypto from 'crypto';
import Stripe from 'stripe';
import { 
  IBillingProvider, 
  CheckoutSessionOptions, 
  CheckoutSessionResult, 
  CustomerPortalSessionResult, 
  WebhookEventPayload, 
  AUTHORITATIVE_PLANS,
  BillingPlanDefinition,
  PlanTier 
} from './types';

const STRIPE_PRICE_ID_REGEX = /^price_[A-Za-z0-9_]{8,}$/;
const STRIPE_PRICE_PLACEHOLDER_RE =
  /(placeholder|your_price|replace_me|changeme|my_stripe_price|example|sample|todo|^price_(?:test_)?x+$|^price_0+$|<|>)/i;

export interface StripePriceIdValidationResult {
  valid: boolean;
  value?: string;
  reason?: string;
}

/**
 * Validates that a configured Stripe Price ID has valid format and is not a placeholder.
 */
export function validateStripePriceIdFormat(raw: string | undefined): StripePriceIdValidationResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, reason: 'missing' };
  }
  const trimmed = raw.trim();
  if (STRIPE_PRICE_PLACEHOLDER_RE.test(trimmed)) {
    return { valid: false, value: trimmed, reason: 'placeholder_value' };
  }
  if (!STRIPE_PRICE_ID_REGEX.test(trimmed)) {
    return { valid: false, value: trimmed, reason: 'invalid_format' };
  }
  return { valid: true, value: trimmed };
}

export const PAID_STRIPE_PRICE_TIERS: ReadonlyArray<{
  tier: 'Starter' | 'Growth' | 'Enterprise';
  envVar: 'STRIPE_PRICE_STARTER' | 'STRIPE_PRICE_GROWTH' | 'STRIPE_PRICE_ENTERPRISE';
  aliasEnvVar: 'STRIPE_PRICE_ID_STARTER' | 'STRIPE_PRICE_ID_GROWTH' | 'STRIPE_PRICE_ID_ENTERPRISE';
  expectedCents: number;
}> = [
  { tier: 'Starter', envVar: 'STRIPE_PRICE_STARTER', aliasEnvVar: 'STRIPE_PRICE_ID_STARTER', expectedCents: 4900 },
  { tier: 'Growth', envVar: 'STRIPE_PRICE_GROWTH', aliasEnvVar: 'STRIPE_PRICE_ID_GROWTH', expectedCents: 14900 },
  { tier: 'Enterprise', envVar: 'STRIPE_PRICE_ENTERPRISE', aliasEnvVar: 'STRIPE_PRICE_ID_ENTERPRISE', expectedCents: 49900 },
];

export interface StripePriceConfigurationValidation {
  valid: boolean;
  missingOrInvalid: string[];
  errors: string[];
  priceIds: Partial<Record<'Starter' | 'Growth' | 'Enterprise', string>>;
}

function getRawPlanPriceId(tier: PlanTier, priceMap?: Record<string, string>): string | undefined {
  if (priceMap) {
    if (priceMap[tier] !== undefined) return priceMap[tier];
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
 * Validates all required paid-tier Stripe Price IDs:
 * - Every paid tier (Starter, Growth, Enterprise) has a non-empty, non-placeholder, well-formed price_... ID.
 * - No two paid tiers share the same Stripe Price ID (prevents cross-tier misbilling).
 */
export function validateStripePriceConfiguration(
  priceMap?: Record<string, string>
): StripePriceConfigurationValidation {
  const missingOrInvalid: string[] = [];
  const errors: string[] = [];
  const priceIds: Partial<Record<'Starter' | 'Growth' | 'Enterprise', string>> = {};
  const seenOwners = new Map<string, { tier: string; envVar: string }>();

  for (const cfg of PAID_STRIPE_PRICE_TIERS) {
    const raw = getRawPlanPriceId(cfg.tier, priceMap);
    const check = validateStripePriceIdFormat(raw);
    if (!check.valid || !check.value) {
      const detail =
        check.reason === 'placeholder_value'
          ? 'placeholder value rejected'
          : check.reason === 'invalid_format'
          ? 'must match price_...'
          : 'missing';
      missingOrInvalid.push(`${cfg.envVar} (${detail})`);
      errors.push(`${cfg.envVar} for tier "${cfg.tier}" is ${detail}.`);
      continue;
    }

    const existingOwner = seenOwners.get(check.value);
    if (existingOwner) {
      missingOrInvalid.push(`${cfg.envVar} (conflicts with ${existingOwner.envVar})`);
      errors.push(
        `${cfg.envVar} for tier "${cfg.tier}" duplicates ${existingOwner.envVar} for tier "${existingOwner.tier}".`
      );
      continue;
    }

    seenOwners.set(check.value, { tier: cfg.tier, envVar: cfg.envVar });
    priceIds[cfg.tier] = check.value;
  }

  return {
    valid: missingOrInvalid.length === 0,
    missingOrInvalid,
    errors,
    priceIds,
  };
}

export interface StripeLivePriceCheckItem {
  tier: 'Starter' | 'Growth' | 'Enterprise';
  envVar: string;
  priceId?: string;
  valid: boolean;
  active?: boolean;
  currency?: string;
  unitAmount?: number | null;
  interval?: string | null;
  intervalCount?: number | null;
  errors: string[];
}

export interface StripeLivePriceVerificationResult {
  verified: boolean;
  missingOrInvalid: string[];
  plans: StripeLivePriceCheckItem[];
  error?: string;
}

/**
 * Verifies configured Stripe Price IDs against the Stripe Prices API:
 * ensures each price exists, is active, uses USD recurring monthly billing,
 * matches the authoritative tier amount, and is distinct across plans.
 * Never logs or returns Stripe secrets.
 */
export async function verifyStripeConfiguredPrices(
  stripeClient?: Stripe | null,
  priceMap?: Record<string, string>
): Promise<StripeLivePriceVerificationResult> {
  const staticCheck = validateStripePriceConfiguration(priceMap);
  const plans: StripeLivePriceCheckItem[] = [];
  const missingOrInvalid = [...staticCheck.missingOrInvalid];

  if (!staticCheck.valid) {
    for (const cfg of PAID_STRIPE_PRICE_TIERS) {
      const priceId = staticCheck.priceIds[cfg.tier];
      const tierErrors = staticCheck.errors.filter((e) => e.includes(cfg.envVar));
      plans.push({
        tier: cfg.tier,
        envVar: cfg.envVar,
        priceId,
        valid: Boolean(priceId) && tierErrors.length === 0,
        errors: tierErrors.length > 0 ? tierErrors : priceId ? [] : [`${cfg.envVar} is not configured.`],
      });
    }
    return {
      verified: false,
      missingOrInvalid,
      plans,
      error: staticCheck.errors[0] || 'Stripe Price ID configuration is incomplete or invalid.',
    };
  }

  const client =
    stripeClient ||
    (process.env.STRIPE_SECRET_KEY?.trim() ? new Stripe(process.env.STRIPE_SECRET_KEY.trim()) : null);
  if (!client || typeof client.prices?.retrieve !== 'function') {
    return {
      verified: false,
      missingOrInvalid: ['STRIPE_SECRET_KEY (required for live Stripe price verification)'],
      plans: PAID_STRIPE_PRICE_TIERS.map((cfg) => ({
        tier: cfg.tier,
        envVar: cfg.envVar,
        priceId: staticCheck.priceIds[cfg.tier],
        valid: false,
        errors: ['Stripe client is unavailable because STRIPE_SECRET_KEY is not configured.'],
      })),
      error: 'Stripe client is unavailable because STRIPE_SECRET_KEY is not configured.',
    };
  }

  for (const cfg of PAID_STRIPE_PRICE_TIERS) {
    const priceId = staticCheck.priceIds[cfg.tier]!;
    const itemErrors: string[] = [];
    try {
      const price = await client.prices.retrieve(priceId);
      const active = Boolean(price?.active);
      const currency = typeof price?.currency === 'string' ? price.currency.toLowerCase() : '';
      const interval = price?.recurring?.interval ?? null;
      const intervalCount = price?.recurring?.interval_count ?? null;
      const unitAmount = typeof price?.unit_amount === 'number' ? price.unit_amount : null;

      if (!active) {
        itemErrors.push(`${cfg.envVar} (${priceId}) is inactive in Stripe.`);
      }
      if (price?.type !== 'recurring' || !price?.recurring) {
        itemErrors.push(`${cfg.envVar} (${priceId}) must be a recurring Stripe price.`);
      }
      if (interval !== 'month' || (intervalCount !== null && intervalCount !== 1)) {
        itemErrors.push(
          `${cfg.envVar} (${priceId}) must have monthly recurring interval (got ${interval || 'none'}/${intervalCount ?? 'none'}).`
        );
      }
      if (currency !== 'usd') {
        itemErrors.push(`${cfg.envVar} (${priceId}) must use USD currency (got ${currency || 'none'}).`);
      }
      if (unitAmount !== cfg.expectedCents) {
        itemErrors.push(
          `${cfg.envVar} (${priceId}) unit_amount mismatch: expected ${cfg.expectedCents} cents for ${cfg.tier}, got ${unitAmount}.`
        );
      }

      if (itemErrors.length > 0) {
        missingOrInvalid.push(`${cfg.envVar} (${itemErrors.join('; ')})`);
      }

      plans.push({
        tier: cfg.tier,
        envVar: cfg.envVar,
        priceId,
        valid: itemErrors.length === 0,
        active,
        currency,
        unitAmount,
        interval,
        intervalCount,
        errors: itemErrors,
      });
    } catch (err: any) {
      const safeErr =
        typeof err?.message === 'string'
          ? err.message.replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9_]+\b/g, '[REDACTED_STRIPE_KEY]')
          : 'Unknown Stripe API error';
      const msg = `Failed to retrieve ${cfg.envVar} (${priceId}) from Stripe: ${safeErr}`;
      missingOrInvalid.push(`${cfg.envVar} (Stripe lookup failed)`);
      plans.push({
        tier: cfg.tier,
        envVar: cfg.envVar,
        priceId,
        valid: false,
        errors: [msg],
      });
    }
  }

  return {
    verified: missingOrInvalid.length === 0 && plans.every((p) => p.valid),
    missingOrInvalid,
    plans,
    ...(missingOrInvalid.length > 0 ? { error: 'One or more configured Stripe Price IDs failed verification.' } : {}),
  };
}

/**
 * Resolves configured Stripe Price ID for a given plan tier.
 * Price IDs are external Stripe resources and must be explicitly configured via
 * environment variables (e.g. STRIPE_PRICE_STARTER or STRIPE_PRICE_ID_STARTER)
 * or injected via priceMap for testing. Never falls back to hardcoded or placeholder IDs.
 */
export function getPlanPriceId(tier: PlanTier, priceMap?: Record<string, string>): string | undefined {
  const raw = getRawPlanPriceId(tier, priceMap);
  const check = validateStripePriceIdFormat(raw);
  return check.valid ? check.value : undefined;
}

/**
 * Looks up authoritative plan matching a given Stripe Price ID.
 * Rejects unmapped or duplicate/conflicting Price IDs to prevent unauthorized tier elevation.
 */
export function findPlanByPriceId(priceId: string, priceMap?: Record<string, string>): BillingPlanDefinition | null {
  if (!priceId) return null;
  const trimmed = priceId.trim();
  const matches: BillingPlanDefinition[] = [];
  for (const plan of Object.values(AUTHORITATIVE_PLANS)) {
    if (plan.priceCents <= 0) continue;
    const configuredId = getPlanPriceId(plan.tier, priceMap);
    if (configuredId && configuredId === trimmed) {
      matches.push(plan);
    }
  }
  return matches.length === 1 ? matches[0] : null;
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

  getPlanPriceMap(): Record<string, string> | undefined {
    return this.priceMap;
  }

  async verifyConfiguredPrices(): Promise<StripeLivePriceVerificationResult> {
    return verifyStripeConfiguredPrices(this.stripe, this.priceMap);
  }

  async retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session | null> {
    if (!this.stripe || !sessionId) return null;
    return await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'subscription'],
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
    if (!this.stripe || !subscriptionId) return null;
    return await this.stripe.subscriptions.retrieve(subscriptionId);
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

    const rawPriceId = getRawPlanPriceId(options.tier, this.priceMap);
    const priceCheck = validateStripePriceIdFormat(rawPriceId);
    const envKey = `STRIPE_PRICE_${options.tier.toUpperCase().replace(/\s+/g, '_')}`;
    if (!priceCheck.valid || !priceCheck.value) {
      if (priceCheck.reason === 'placeholder_value' || priceCheck.reason === 'invalid_format') {
        throw new Error(
          `[Billing] Stripe Price ID for plan tier "${options.tier}" (${envKey}) is invalid or uses a placeholder value.`
        );
      }
      throw new Error(
        `[Billing] Stripe Price ID is not configured for plan tier "${options.tier}". Please configure ${envKey}.`
      );
    }
    const priceId = priceCheck.value;

    // Prevent one plan's Price ID from silently mapping to another plan
    for (const cfg of PAID_STRIPE_PRICE_TIERS) {
      if (cfg.tier === options.tier) continue;
      const otherRaw = getRawPlanPriceId(cfg.tier, this.priceMap);
      const otherCheck = validateStripePriceIdFormat(otherRaw);
      if (otherCheck.valid && otherCheck.value === priceId) {
        throw new Error(
          `[Billing] Stripe Price ID for plan tier "${options.tier}" (${envKey}) conflicts with ${cfg.envVar} (${cfg.tier}).`
        );
      }
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
  private sessions = new Map<string, {
    sessionId: string;
    workspaceId: string;
    tier: PlanTier;
    customerId: string;
    subscriptionId: string;
    createdAt: number;
  }>();

  constructor(secret = process.env.BILLING_WEBHOOK_SECRET || 'sandbox_test_webhook_secret_key_123') {
    this.secret = secret;
  }

  getWebhookSecret(): string {
    return this.secret;
  }

  getPlanPriceMap(): Record<string, string> | undefined {
    return undefined;
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
    const customerId = options.customerId || `sbx_cus_${crypto.randomBytes(6).toString('hex')}`;
    const subscriptionId = `sbx_sub_${crypto.randomBytes(6).toString('hex')}`;

    this.sessions.set(sessionId, {
      sessionId,
      workspaceId: options.workspaceId,
      tier: plan.tier,
      customerId,
      subscriptionId,
      createdAt: Date.now(),
    });

    let checkoutUrl: string;
    try {
      const normalizedTemplate = options.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId);
      const parsed = new URL(normalizedTemplate);
      parsed.searchParams.set('session_id', sessionId);
      parsed.searchParams.set('provider', 'sandbox');
      parsed.searchParams.set('tier', options.tier);
      checkoutUrl = parsed.toString();
    } catch {
      const separator = options.successUrl.includes('?') ? '&' : '?';
      checkoutUrl = `${options.successUrl}${separator}session_id=${sessionId}&provider=sandbox&tier=${encodeURIComponent(options.tier)}`;
    }

    return {
      sessionId,
      checkoutUrl,
      provider: this.providerName,
    };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<any | null> {
    if (!sessionId) return null;
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    const nowSec = Math.floor(record.createdAt / 1000);
    return {
      id: record.sessionId,
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: record.workspaceId,
      customer: record.customerId,
      subscription: {
        id: record.subscriptionId,
        status: 'active',
        current_period_start: nowSec,
        current_period_end: nowSec + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
      },
      metadata: {
        workspaceId: record.workspaceId,
        tier: record.tier,
      },
    };
  }

  async createPortalSession(workspaceId: string, customerId: string, returnUrl: string): Promise<CustomerPortalSessionResult> {
    const portalId = `sbx_bps_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    let portalUrl: string;
    try {
      const parsed = new URL(returnUrl);
      parsed.searchParams.set('portal_session_id', portalId);
      parsed.searchParams.set('provider', 'sandbox');
      portalUrl = parsed.toString();
    } catch {
      const separator = returnUrl.includes('?') ? '&' : '?';
      portalUrl = `${returnUrl}${separator}portal_session_id=${portalId}&provider=sandbox`;
    }
    return {
      portalUrl,
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

