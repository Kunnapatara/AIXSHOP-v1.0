import { StoreProfile, Product, ProductCandidate, CandidateProductStatus } from '../../types';
import { evaluateCandidateProducts } from '../../domain/ingestion/storeIngestion';
import { SubscriptionRecord } from '../billing/types';

export interface WorkspacePlanEntitlement {
  isValid: boolean;
  tier: string;
  skuLimit: number;
  isUnlimited: boolean;
  subscriptionStatus?: string;
  isPastDue?: boolean;
  error?: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  limit: number;
  currentUsage: number;
  additionalUsage: number;
  projectedUsage: number;
  tier: string;
  isUnlimited: boolean;
  error?: string;
}

export class PlanQuotaExceededError extends Error {
  code = 'PLAN_QUOTA_EXCEEDED';
  status = 403;
  limit: number;
  currentUsage: number;
  additionalUsage: number;
  projectedUsage: number;
  tier: string;

  constructor(quotaCheck: QuotaCheckResult) {
    super(quotaCheck.error || 'Plan quota exceeded');
    this.name = 'PlanQuotaExceededError';
    this.limit = quotaCheck.limit;
    this.currentUsage = quotaCheck.currentUsage;
    this.additionalUsage = quotaCheck.additionalUsage;
    this.projectedUsage = quotaCheck.projectedUsage;
    this.tier = quotaCheck.tier;
  }
}

export const VERIFIED_TIERS = {
  STARTER: 'Starter',
  GROWTH: 'Growth',
  ENTERPRISE: 'Enterprise',
  FREE_AUDIT: 'Free Audit',
} as const;

export const DEFAULT_TIER_LIMITS: Readonly<Record<string, number>> = {
  'starter': 250,
  'starter tier': 250,
  'growth': 2500,
  'growth tier': 2500,
  'enterprise': Infinity,
  'enterprise tier': Infinity,
  'free audit': 2500,
};

/**
 * Legacy hardcoded default that previously leaked from PostgreSQL repository.
 * Must never accidentally override Starter (to 2500) or cap Enterprise (to 2500).
 */
const LEGACY_STALE_DEFAULT_SKU_LIMIT = 2500;

/**
 * Resolves the effective plan and applicable SKU limits from trusted server-side data.
 * Does not trust any client-supplied request fields.
 * Validates whole-number limits and fails safely if store data is missing, corrupted, or invalid.
 */
export function resolveWorkspacePlanEntitlement(
  storeProfile: StoreProfile | null | undefined,
  subscription?: SubscriptionRecord | null
): WorkspacePlanEntitlement {
  if (!storeProfile) {
    return {
      isValid: false,
      tier: 'Unknown',
      skuLimit: 0,
      isUnlimited: false,
      error: 'Store profile not found for workspace. Access restricted.',
    };
  }

  // If a verified subscription is provided, it serves as authoritative billing source
  let rawTier = (storeProfile.tier || '').trim();
  let isPastDue = false;

  if (subscription) {
    const normalizedSubStatus = typeof subscription.status === 'string'
      ? subscription.status.trim().toLowerCase()
      : '';
    if (normalizedSubStatus === 'active' || normalizedSubStatus === 'trialing') {
      rawTier = subscription.tier;
    } else if (normalizedSubStatus === 'past_due') {
      rawTier = subscription.tier;
      isPastDue = true;
    } else {
      // Canceled, expired, unpaid, incomplete, pending, missing, or unknown status must fail closed
      rawTier = 'Free Audit';
    }
  }

  const normTier = (rawTier || 'Free Audit').toLowerCase();

  // Validate numeric limit integrity if specified
  const hasRawLimit = storeProfile.skuLimit !== undefined && storeProfile.skuLimit !== null;
  if (hasRawLimit) {
    const rawVal = storeProfile.skuLimit;
    if (
      typeof rawVal !== 'number' ||
      isNaN(rawVal) ||
      !Number.isInteger(rawVal) ||
      rawVal < 0
    ) {
      return {
        isValid: false,
        tier: rawTier || 'Unknown',
        skuLimit: 0,
        isUnlimited: false,
        error: 'Invalid whole-number SKU quota configured on workspace.',
      };
    }
  }

  // 1. Enterprise Tier (Must be genuinely unlimited unless an explicit non-stale contracted quota is set)
  if (normTier === 'enterprise' || normTier === 'enterprise tier') {
    if (hasRawLimit && storeProfile.skuLimit !== LEGACY_STALE_DEFAULT_SKU_LIMIT && storeProfile.skuLimit! > 0) {
      return {
        isValid: true,
        tier: 'Enterprise',
        skuLimit: storeProfile.skuLimit!,
        isUnlimited: false,
        isPastDue,
        subscriptionStatus: subscription?.status,
      };
    }
    return {
      isValid: true,
      tier: 'Enterprise',
      skuLimit: Infinity,
      isUnlimited: true,
      isPastDue,
      subscriptionStatus: subscription?.status,
    };
  }

  // 2. Starter Tier (Must never receive 2500 from legacy stale default)
  if (normTier === 'starter' || normTier === 'starter tier') {
    if (hasRawLimit && storeProfile.skuLimit !== LEGACY_STALE_DEFAULT_SKU_LIMIT) {
      return {
        isValid: true,
        tier: 'Starter',
        skuLimit: storeProfile.skuLimit!,
        isUnlimited: false,
        isPastDue,
        subscriptionStatus: subscription?.status,
      };
    }
    return {
      isValid: true,
      tier: 'Starter',
      skuLimit: DEFAULT_TIER_LIMITS['starter'],
      isUnlimited: false,
      isPastDue,
      subscriptionStatus: subscription?.status,
    };
  }

  // 3. Growth Tier
  if (normTier === 'growth' || normTier === 'growth tier') {
    return {
      isValid: true,
      tier: 'Growth',
      skuLimit: hasRawLimit ? storeProfile.skuLimit! : DEFAULT_TIER_LIMITS['growth'],
      isUnlimited: false,
      isPastDue,
      subscriptionStatus: subscription?.status,
    };
  }

  // 4. Free Audit
  if (normTier === 'free audit' || normTier === '') {
    return {
      isValid: true,
      tier: 'Free Audit',
      skuLimit: hasRawLimit ? storeProfile.skuLimit! : DEFAULT_TIER_LIMITS['free audit'],
      isUnlimited: false,
      isPastDue,
      subscriptionStatus: subscription?.status,
    };
  }

  // 5. Custom/unrecognized tier with explicit valid SKU limit is honored
  if (hasRawLimit && storeProfile.skuLimit !== LEGACY_STALE_DEFAULT_SKU_LIMIT) {
    return {
      isValid: true,
      tier: rawTier || 'Custom',
      skuLimit: storeProfile.skuLimit!,
      isUnlimited: false,
      isPastDue,
      subscriptionStatus: subscription?.status,
    };
  }

  // 6. Unrecognized tier fails safely if no authoritative limit exists
  return {
    isValid: false,
    tier: rawTier || 'Unknown',
    skuLimit: 0,
    isUnlimited: false,
    error: `Unrecognized plan tier "${rawTier}" with no authoritative SKU limit.`,
  };
}

/**
 * Counts existing catalog usage using the authoritative definition of a SKU (Variant).
 * Each variant represents 1 merchant SKU.
 */
export function countCatalogSkus(products: Product[]): number {
  if (!Array.isArray(products)) return 0;
  return products.reduce((sum, p) => {
    if (!p) return sum;
    const variants = Array.isArray(p.variants) ? p.variants : [];
    return sum + (variants.length > 0 ? variants.length : 1);
  }, 0);
}

/**
 * Calculates additional SKU usage represented by an incoming candidate batch
 * using the domain's existing deduplication, conflict preservation, and validation rules.
 * Existing or duplicate SKUs are never double-counted.
 */
export function calculateImportUsage(
  candidates: ProductCandidate[],
  existingProducts: Product[]
): {
  additionalSkus: number;
  eligibleProducts: Product[];
  candidateDetails: CandidateProductStatus[];
} {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      additionalSkus: 0,
      eligibleProducts: [],
      candidateDetails: [],
    };
  }

  const { candidateDetails, eligibleProducts } = evaluateCandidateProducts(
    candidates,
    existingProducts || []
  );

  const additionalSkus = eligibleProducts.reduce((sum, p) => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    return sum + (variants.length > 0 ? variants.length : 1);
  }, 0);

  return {
    additionalSkus,
    eligibleProducts,
    candidateDetails,
  };
}

/**
 * Evaluates whether proposed catalog usage exceeds the workspace's authoritative plan limit.
 */
export function checkPlanQuota(
  storeProfile: StoreProfile | null | undefined,
  existingProducts: Product[],
  additionalSkus: number,
  subscription?: SubscriptionRecord | null
): QuotaCheckResult {
  const entitlement = resolveWorkspacePlanEntitlement(storeProfile, subscription);
  const currentUsage = countCatalogSkus(existingProducts);
  const projectedUsage = currentUsage + additionalSkus;

  if (!entitlement.isValid) {
    return {
      allowed: false,
      limit: 0,
      currentUsage,
      additionalUsage: additionalSkus,
      projectedUsage,
      tier: entitlement.tier,
      isUnlimited: false,
      error: entitlement.error || 'Invalid or missing workspace entitlement data',
    };
  }

  if (entitlement.isPastDue && additionalSkus > 0) {
    return {
      allowed: false,
      limit: entitlement.skuLimit,
      currentUsage,
      additionalUsage: additionalSkus,
      projectedUsage,
      tier: entitlement.tier,
      isUnlimited: entitlement.isUnlimited,
      error: `Subscription payment is past due for workspace on plan "${entitlement.tier}". Please update payment details before importing or adding new SKUs.`,
    };
  }

  if (entitlement.isUnlimited) {
    return {
      allowed: true,
      limit: Infinity,
      currentUsage,
      additionalUsage: additionalSkus,
      projectedUsage,
      tier: entitlement.tier,
      isUnlimited: true,
    };
  }

  const allowed = projectedUsage <= entitlement.skuLimit;

  return {
    allowed,
    limit: entitlement.skuLimit,
    currentUsage,
    additionalUsage: additionalSkus,
    projectedUsage,
    tier: entitlement.tier,
    isUnlimited: false,
    error: allowed
      ? undefined
      : `Plan quota exceeded: importing ${additionalSkus} additional SKU(s) would increase catalog to ${projectedUsage} SKUs, exceeding your workspace limit of ${entitlement.skuLimit} SKUs on the "${entitlement.tier}" plan.`,
  };
}

/**
 * In-process asynchronous mutex per workspace to serialize simultaneous import/catalog
 * operations and eliminate concurrent quota race conditions across endpoints.
 * Includes complete cleanup of completed promise chains to prevent memory leaks.
 */
const workspaceLocks = new Map<string, Promise<unknown>>();

export async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prevLock = workspaceLocks.get(workspaceId) || Promise.resolve();

  let releaseCurrent: () => void;
  const currentTurnPromise = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  const chainTail = prevLock.catch(() => {}).then(() => currentTurnPromise);
  workspaceLocks.set(workspaceId, chainTail);

  try {
    await prevLock.catch(() => {});
    return await fn();
  } finally {
    releaseCurrent!();
    if (workspaceLocks.get(workspaceId) === chainTail) {
      workspaceLocks.delete(workspaceId);
    }
  }
}

/**
 * Test inspection helper to verify workspace lock cleanup
 */
export function getActiveWorkspaceLockCount(): number {
  return workspaceLocks.size;
}

export type ReportAccessReasonCode =
  | 'ACTIVE_PAID_SUBSCRIPTION'
  | 'TRIALING_PAID_SUBSCRIPTION'
  | 'FREE_AUDIT_PRELIMINARY_ONLY'
  | 'SUBSCRIPTION_PAST_DUE'
  | 'SUBSCRIPTION_CANCELED'
  | 'SUBSCRIPTION_UNPAID'
  | 'SUBSCRIPTION_INCOMPLETE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'STORE_PROFILE_UNAVAILABLE';

export interface ReportEntitlement {
  hasFullReportAccess: boolean;
  accessLevel: 'full' | 'preliminary';
  activeTier: string;
  subscriptionStatus: string;
  reasonCode: ReportAccessReasonCode;
  reasonMessage: string;
  upgradeRequired: boolean;
}

export interface PreliminaryAuditSummary {
  totalFindingsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  actionsCount: number;
  recommendedTier: 'Starter' | 'Growth' | 'Enterprise';
  skuCount: number;
  note: string;
}

export interface CommercialPlanSummaryItem {
  tier: string;
  priceCents: number;
  billingInterval: 'month' | 'year';
  skuLimit: number | null;
  isUnlimited: boolean;
  quotaSemantics: 'preliminary_evaluation_capacity' | 'verified_monthly_catalog_skus';
  reportAccess: 'preliminary_only' | 'full_report_and_remediation';
  explanation: string;
}

function isPaidTierName(tier: string): boolean {
  const norm = (tier || '').trim().toLowerCase();
  return (
    norm === 'starter' ||
    norm === 'starter tier' ||
    norm === 'growth' ||
    norm === 'growth tier' ||
    norm === 'enterprise' ||
    norm === 'enterprise tier'
  );
}

function canonicalTierDisplayName(tier: string): string {
  const norm = (tier || '').trim().toLowerCase();
  if (norm === 'starter' || norm === 'starter tier') return 'Starter';
  if (norm === 'growth' || norm === 'growth tier') return 'Growth';
  if (norm === 'enterprise' || norm === 'enterprise tier') return 'Enterprise';
  if (norm === 'free audit' || norm === '') return 'Free Audit';
  return tier.trim();
}

/**
 * Authoritative server-side commercial entitlement check for Full Report Access,
 * detailed Findings/Evidence disclosure, Remediation Actions, Historical Snapshots, and Feed Exports.
 *
 * Fail-closed rules:
 * - Free Audit ($0) provides preliminary screening only (no full findings, evidence, remediation, or exports).
 * - Only paid plans ('Starter', 'Growth', 'Enterprise') backed by a verified 'active' or 'trialing'
 *   subscription record grant full report access.
 * - past_due, canceled, unpaid, incomplete, expired, pending, or missing subscription records fail closed.
 */
export function resolveReportEntitlement(
  storeProfile: StoreProfile | null | undefined,
  subscription?: SubscriptionRecord | null
): ReportEntitlement {
  if (!storeProfile) {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: 'Free Audit',
      subscriptionStatus: 'none',
      reasonCode: 'STORE_PROFILE_UNAVAILABLE',
      reasonMessage: 'Store profile unavailable. Full audit reports require a verified paid subscription.',
      upgradeRequired: true,
    };
  }

  if (!subscription) {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: 'Free Audit',
      subscriptionStatus: 'none',
      reasonCode: 'FREE_AUDIT_PRELIMINARY_ONLY',
      reasonMessage:
        'Free Audit provides a preliminary catalog check only. Upgrade to a paid plan to unlock full findings, evidence trails, remediation actions, and feed exports.',
      upgradeRequired: true,
    };
  }

  const normalizedStatus = typeof subscription.status === 'string'
    ? subscription.status.trim().toLowerCase()
    : 'incomplete';
  const tierName = canonicalTierDisplayName(subscription.tier || storeProfile.tier || 'Free Audit');
  const paidTier = isPaidTierName(tierName);

  if (!paidTier) {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: 'Free Audit',
      subscriptionStatus: normalizedStatus || 'none',
      reasonCode: 'FREE_AUDIT_PRELIMINARY_ONLY',
      reasonMessage:
        'Free Audit provides a preliminary catalog check only. Upgrade to a paid plan to unlock full findings, evidence trails, remediation actions, and feed exports.',
      upgradeRequired: true,
    };
  }

  if (normalizedStatus === 'active') {
    return {
      hasFullReportAccess: true,
      accessLevel: 'full',
      activeTier: tierName,
      subscriptionStatus: 'active',
      reasonCode: 'ACTIVE_PAID_SUBSCRIPTION',
      reasonMessage: `Full audit report and remediation unlocked under active ${tierName} plan.`,
      upgradeRequired: false,
    };
  }

  if (normalizedStatus === 'trialing') {
    return {
      hasFullReportAccess: true,
      accessLevel: 'full',
      activeTier: tierName,
      subscriptionStatus: 'trialing',
      reasonCode: 'TRIALING_PAID_SUBSCRIPTION',
      reasonMessage: `Full audit report and remediation unlocked under ${tierName} trial.`,
      upgradeRequired: false,
    };
  }

  if (normalizedStatus === 'past_due') {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: tierName,
      subscriptionStatus: 'past_due',
      reasonCode: 'SUBSCRIPTION_PAST_DUE',
      reasonMessage: `Your ${tierName} subscription payment is past due. Update your billing method to restore full audit reports and remediation access.`,
      upgradeRequired: true,
    };
  }

  if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled') {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: 'Free Audit',
      subscriptionStatus: 'canceled',
      reasonCode: 'SUBSCRIPTION_CANCELED',
      reasonMessage:
        'Your paid subscription has been canceled or refunded. Resubscribe to unlock full audit findings, evidence trails, and exports.',
      upgradeRequired: true,
    };
  }

  if (normalizedStatus === 'unpaid') {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: tierName,
      subscriptionStatus: 'unpaid',
      reasonCode: 'SUBSCRIPTION_UNPAID',
      reasonMessage: 'Your subscription is unpaid. Complete payment to restore full report access.',
      upgradeRequired: true,
    };
  }

  if (normalizedStatus === 'expired' || normalizedStatus === 'incomplete_expired') {
    return {
      hasFullReportAccess: false,
      accessLevel: 'preliminary',
      activeTier: 'Free Audit',
      subscriptionStatus: 'expired',
      reasonCode: 'SUBSCRIPTION_EXPIRED',
      reasonMessage: 'Your subscription has expired. Renew or upgrade your plan to unlock full audit reports.',
      upgradeRequired: true,
    };
  }

  return {
    hasFullReportAccess: false,
    accessLevel: 'preliminary',
    activeTier: 'Free Audit',
    subscriptionStatus: normalizedStatus || 'incomplete',
    reasonCode: 'SUBSCRIPTION_INCOMPLETE',
    reasonMessage:
      'Payment verification is still pending or incomplete. Complete checkout to unlock full audit reports.',
    upgradeRequired: true,
  };
}

export function recommendPaidTierForSkuCount(skuCount: number): 'Starter' | 'Growth' | 'Enterprise' {
  if (skuCount <= 250) return 'Starter';
  if (skuCount <= 2500) return 'Growth';
  return 'Enterprise';
}

export function buildPreliminaryAuditSummary(
  catalog: import('../../domain/storage/storageTypes').StoragePayloadV1 | null | undefined,
  auditRun?: { summary?: Record<string, any> } | null
): PreliminaryAuditSummary {
  const findings = catalog?.findings || [];
  const actions = catalog?.actions || [];
  const skuCount = countCatalogSkus(catalog?.products || []);
  const criticalCount = findings.length > 0
    ? findings.filter(f => f.severity === 'critical').length
    : Number(auditRun?.summary?.criticalCount || 0);
  const highCount = findings.length > 0
    ? findings.filter(f => f.severity === 'high').length
    : Number(auditRun?.summary?.highCount || 0);
  const mediumCount = findings.length > 0
    ? findings.filter(f => f.severity === 'medium').length
    : Number(auditRun?.summary?.mediumCount || 0);
  const lowCount = findings.length > 0
    ? findings.filter(f => f.severity === 'low').length
    : Number(auditRun?.summary?.lowCount || 0);
  const totalFindingsCount = findings.length > 0
    ? findings.length
    : Number(auditRun?.summary?.findingsCount || (criticalCount + highCount + mediumCount + lowCount));

  return {
    totalFindingsCount,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    actionsCount: actions.length,
    recommendedTier: recommendPaidTierForSkuCount(skuCount),
    skuCount,
    note:
      'Preliminary check only. Detailed findings, evidence provenance, recommended fixes, historical comparisons, and feed exports require an active paid plan.',
  };
}

/**
 * Redacts paid report deliverables (detailed findings and remediation actions) from a catalog response
 * while keeping the merchant's own catalog inventory (products, variants, offers, evidence, storeProfile) intact.
 */
export function redactCatalogForPreliminaryAccess(
  catalog: import('../../domain/storage/storageTypes').StoragePayloadV1,
  entitlement: ReportEntitlement,
  auditRun?: { summary?: Record<string, any> } | null
): {
  catalog: import('../../domain/storage/storageTypes').StoragePayloadV1;
  preliminarySummary: PreliminaryAuditSummary;
} {
  const preliminarySummary = buildPreliminaryAuditSummary(catalog, auditRun);

  if (entitlement.hasFullReportAccess) {
    return {
      catalog,
      preliminarySummary,
    };
  }

  return {
    catalog: {
      ...catalog,
      findings: [],
      actions: [],
      products: (catalog.products || []).map(p => ({
        ...p,
        findingsCount: typeof p.findingsCount === 'number' ? p.findingsCount : 0,
      })),
    },
    preliminarySummary,
  };
}

export function getCommercialPlanSummary(): CommercialPlanSummaryItem[] {
  return [
    {
      tier: 'Free Audit',
      priceCents: 0,
      billingInterval: 'month',
      skuLimit: 2500,
      isUnlimited: false,
      quotaSemantics: 'preliminary_evaluation_capacity',
      reportAccess: 'preliminary_only',
      explanation:
        'Free Audit ($0) permits preliminary screening for up to 2,500 SKUs so stores with larger catalogs can gauge eligibility and issue severity counts without receiving full audit findings, evidence, remediation actions, or feed exports.',
    },
    {
      tier: 'Starter',
      priceCents: 4900,
      billingInterval: 'month',
      skuLimit: 250,
      isUnlimited: false,
      quotaSemantics: 'verified_monthly_catalog_skus',
      reportAccess: 'full_report_and_remediation',
      explanation: 'Starter ($49/month) unlocks full audit reports, remediation actions, and feed exports for up to 250 verified SKUs.',
    },
    {
      tier: 'Growth',
      priceCents: 14900,
      billingInterval: 'month',
      skuLimit: 2500,
      isUnlimited: false,
      quotaSemantics: 'verified_monthly_catalog_skus',
      reportAccess: 'full_report_and_remediation',
      explanation: 'Growth ($149/month) unlocks full audit reports, remediation actions, and feed exports for up to 2,500 verified SKUs.',
    },
    {
      tier: 'Enterprise',
      priceCents: 49900,
      billingInterval: 'month',
      skuLimit: null,
      isUnlimited: true,
      quotaSemantics: 'verified_monthly_catalog_skus',
      reportAccess: 'full_report_and_remediation',
      explanation: 'Enterprise ($499/month) unlocks full audit reports, remediation actions, and feed exports for unlimited verified SKUs.',
    },
  ];
}

