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

/**
 * Resolves the effective plan and applicable SKU limits from trusted server-side data.
 * Does not trust any client-supplied request fields.
 * Fails safely if store data is missing, corrupted, or invalid.
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

  // If explicit numeric skuLimit is defined on the server store profile
  if (typeof storeProfile.skuLimit === 'number' && !isNaN(storeProfile.skuLimit)) {
    if (storeProfile.skuLimit < 0) {
      return {
        isValid: false,
        tier: rawTier || 'Unknown',
        skuLimit: 0,
        isUnlimited: false,
        error: 'Invalid negative SKU quota configured on workspace.',
      };
    }

    if (rawTier === 'Enterprise' || rawTier === 'Enterprise Tier') {
      if (storeProfile.skuLimit === 0) {
        return {
          isValid: true,
          tier: 'Enterprise',
          skuLimit: Infinity,
          isUnlimited: true,
        };
      }
      return {
        isValid: true,
        tier: 'Enterprise',
        skuLimit: storeProfile.skuLimit,
        isUnlimited: false,
      };
    }

    return {
      isValid: true,
      tier: rawTier || 'Free Audit',
      skuLimit: storeProfile.skuLimit,
      isUnlimited: false,
    };
  }

  // Authoritative plan fallbacks based on existing tier definitions in codebase
  if (rawTier === 'Enterprise' || rawTier === 'Enterprise Tier') {
    return {
      isValid: true,
      tier: 'Enterprise',
      skuLimit: Infinity,
      isUnlimited: true,
    };
  }

  if (rawTier === 'Starter' || rawTier === 'Starter Tier') {
    return {
      isValid: true,
      tier: 'Starter',
      skuLimit: 250,
      isUnlimited: false,
    };
  }

  if (rawTier === 'Growth' || rawTier === 'Growth Tier') {
    return {
      isValid: true,
      tier: 'Growth',
      skuLimit: 2500,
      isUnlimited: false,
    };
  }

  if (rawTier === 'Free Audit' || rawTier === '') {
    // Default baseline for newly initialized workspaces (matches postgresRepository baseline)
    return {
      isValid: true,
      tier: 'Free Audit',
      skuLimit: 2500,
      isUnlimited: false,
    };
  }

  // Unrecognized tier without explicit skuLimit fails safely
  return {
    isValid: false,
    tier: rawTier,
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
 * operations and eliminate concurrent quota race conditions.
 */
const workspaceLocks = new Map<string, Promise<unknown>>();

export async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = workspaceLocks.get(workspaceId) || Promise.resolve();
  let release: () => void;
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  workspaceLocks.set(
    workspaceId,
    currentLock.then(() => newLock, () => newLock)
  );

  try {
    await currentLock;
    return await fn();
  } finally {
    release!();
    if (workspaceLocks.get(workspaceId) === newLock) {
      workspaceLocks.delete(workspaceId);
    }
  }
}
