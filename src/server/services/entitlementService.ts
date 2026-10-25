import { StoreProfile, Product, ProductCandidate, CandidateProductStatus } from '../../types';
import { evaluateCandidateProducts } from '../../domain/ingestion/storeIngestion';

export interface WorkspacePlanEntitlement {
  isValid: boolean;
  tier: string;
  skuLimit: number;
  isUnlimited: boolean;
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
  storeProfile: StoreProfile | null | undefined
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

  const rawTier = (storeProfile.tier || '').trim();
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
      };
    }
    return {
      isValid: true,
      tier: 'Enterprise',
      skuLimit: Infinity,
      isUnlimited: true,
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
      };
    }
    return {
      isValid: true,
      tier: 'Starter',
      skuLimit: DEFAULT_TIER_LIMITS['starter'],
      isUnlimited: false,
    };
  }

  // 3. Growth Tier
  if (normTier === 'growth' || normTier === 'growth tier') {
    return {
      isValid: true,
      tier: 'Growth',
      skuLimit: hasRawLimit ? storeProfile.skuLimit! : DEFAULT_TIER_LIMITS['growth'],
      isUnlimited: false,
    };
  }

  // 4. Free Audit
  if (normTier === 'free audit' || normTier === '') {
    return {
      isValid: true,
      tier: 'Free Audit',
      skuLimit: hasRawLimit ? storeProfile.skuLimit! : DEFAULT_TIER_LIMITS['free audit'],
      isUnlimited: false,
    };
  }

  // 5. Custom/unrecognized tier with explicit valid SKU limit is honored
  if (hasRawLimit && storeProfile.skuLimit !== LEGACY_STALE_DEFAULT_SKU_LIMIT) {
    return {
      isValid: true,
      tier: rawTier || 'Custom',
      skuLimit: storeProfile.skuLimit!,
      isUnlimited: false,
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
  additionalSkus: number
): QuotaCheckResult {
  const entitlement = resolveWorkspacePlanEntitlement(storeProfile);
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
