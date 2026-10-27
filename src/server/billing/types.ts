export type PlanTier = 'Free Audit' | 'Starter' | 'Growth' | 'Enterprise';

export type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'canceled' | 'expired';

export interface BillingPlanDefinition {
  id: string;
  tier: PlanTier;
  name: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year';
  skuLimit: number;
  features: string[];
}

export const AUTHORITATIVE_PLANS: Readonly<Record<string, BillingPlanDefinition>> = {
  'free_audit': {
    id: 'plan_free_audit',
    tier: 'Free Audit',
    name: 'Free Audit',
    priceCents: 0,
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: 2500,
    features: ['Catalog completeness auditing', 'Single-pass issue discovery', '2,500 SKU capacity'],
  },
  'starter': {
    id: 'plan_starter',
    tier: 'Starter',
    name: 'Starter Plan',
    priceCents: 4900, // $49.00
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: 250,
    features: ['Curated catalogue verification', 'Up to 250 verified SKUs', 'Essential schema & GTIN validation'],
  },
  'growth': {
    id: 'plan_growth',
    tier: 'Growth',
    name: 'Growth Plan',
    priceCents: 14900, // $149.00
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: 2500,
    features: ['Full catalogue intelligence', 'Up to 2,500 verified SKUs', 'Feed compliance & cross-channel sync'],
  },
  'enterprise': {
    id: 'plan_enterprise',
    tier: 'Enterprise',
    name: 'Enterprise Plan',
    priceCents: 49900, // $499.00
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: Infinity,
    features: ['Unlimited SKUs', 'Dedicated SLA', 'Custom ERP connectors', 'Audit trail export'],
  },
};

export interface SubscriptionRecord {
  id: string;
  workspaceId: string;
  provider: 'stripe' | 'sandbox' | string;
  customerId: string;
  subscriptionId: string;
  tier: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BillingEventRecord {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  idempotencyKey: string;
  payload: any;
  status: 'processed' | 'failed' | 'ignored';
  processedAt: string;
}

export interface CheckoutSessionOptions {
  workspaceId: string;
  tier: PlanTier;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
}

export interface CheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
  provider: string;
}

export interface CustomerPortalSessionResult {
  portalUrl: string;
  provider: string;
}

export interface WebhookEventPayload {
  id: string;
  type: string;
  data: {
    object: any;
  };
  created: number;
}

export interface IBillingProvider {
  readonly providerName: string;
  createCheckoutSession(options: CheckoutSessionOptions): Promise<CheckoutSessionResult>;
  createPortalSession(workspaceId: string, customerId: string, returnUrl: string): Promise<CustomerPortalSessionResult>;
  verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret: string): boolean | Promise<boolean>;
  parseWebhookEvent(rawBody: string | Buffer): WebhookEventPayload;
  getWebhookSecret?(): string;
}

