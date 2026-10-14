import { Product, Finding, ActionItem, StoreProfile } from '../../types';
import { isValidGtin13 } from '../validation/gtin';

/**
 * Explicit allowlist of fields that may be mutated by an Action Item.
 */
export const ALLOWED_FIELD_PREFIXES = [
  'variants[',
  'attributes.',
  'title / marketing claims',
  'store.catalogPolicy.units',
  'connectors.gmc.shipping_sla',
] as const;

export const SUPPORTED_ATTRIBUTES_ALLOWLIST = new Set([
  'microwaveSafe',
  'dishwasherSafe',
  'oekoTexCertified',
  'recommendedBrewMethods',
  'verifiedBurnTime',
  'material',
  'dimensions',
  'careInstructions',
  'burnTime_claim',
  'origin',
  'allergens',
  'capacity',
  'weight',
]);

/**
 * Calculates a deterministic catalog completeness score (0-100) based on actual product fields.
 */
export function calculateProductCompleteness(product: Product): number {
  if (!product) return 0;
  let score = 0;

  // 1. Core entity properties (up to 40 pts)
  if (product.title && product.title.trim().length >= 3) score += 10;
  if (product.brand && product.brand.trim().length > 0) score += 8;
  if (product.category && product.category.trim().length > 0) score += 8;
  if (product.description && product.description.trim().length >= 10) score += 8;
  if (product.image && product.image.trim().length > 0) score += 6;

  // 2. Structured attributes (up to 30 pts)
  const attributes = product.attributes || {};
  const filledAttrs = Object.entries(attributes).filter(([, v]) => {
    if (!v || typeof v !== 'string') return false;
    const trimmed = v.trim();
    return trimmed !== '' && trimmed !== 'Unspecified' && trimmed !== '(none)';
  });
  score += Math.min(30, filledAttrs.length * 6);

  // 3. Variant integrity (up to 20 pts)
  if (product.variants && product.variants.length > 0) {
    const validVariants = product.variants.filter(
      v => v.barcode && isValidGtin13(v.barcode)
    ).length;
    const ratio = validVariants / product.variants.length;
    score += Math.round(ratio * 20);
  }

  // 4. Evidence documents (up to 10 pts)
  if (product.evidenceDocuments && product.evidenceDocuments.length > 0) {
    const verifiedDocs = product.evidenceDocuments.filter(d => d.status === 'verified').length;
    score += Math.min(10, verifiedDocs * 5);
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Calculates the average completeness score across all canonical products in the catalog.
 */
export function calculateStoreCompletenessAvg(products: Product[]): number {
  if (!products || products.length === 0) return 0;
  const total = products.reduce((acc, p) => acc + calculateProductCompleteness(p), 0);
  return Math.round(total / products.length);
}

export interface MutationContext {
  products: Product[];
  findings: Finding[];
  actionItems: ActionItem[];
  storeProfile: StoreProfile;
  isReadOnly: boolean;
}

export interface MutationExecutionResult {
  success: boolean;
  errorCode?: 
    | 'READ_ONLY_MODE'
    | 'ACTION_NOT_FOUND'
    | 'ACTION_INELIGIBLE'
    | 'UNSUPPORTED_FIELD'
    | 'PRODUCT_NOT_FOUND'
    | 'VARIANT_OUT_OF_BOUNDS'
    | 'INVALID_VARIANT_TARGET'
    | 'NOOP_MUTATION';
  message: string;
  nextProducts: Product[];
  nextFindings: Finding[];
  nextActions: ActionItem[];
  nextStoreProfile: StoreProfile;
  targetAction?: ActionItem;
}

export interface RecheckExecutionResult {
  success: boolean;
  isVerified: boolean;
  errorCode?: 'READ_ONLY_MODE' | 'ACTION_NOT_FOUND' | 'ACTION_PENDING' | 'VERIFICATION_FAILED';
  verificationStatus: 'unverified' | 'recheck_required' | 'verified_in_catalog' | 'verification_failed';
  recheckNotes: string;
  message: string;
  nextActions: ActionItem[];
  nextFindings: Finding[];
}

export interface ProductRecheckResult {
  success: boolean;
  message: string;
  hasInvalidBarcode: boolean;
  hasMissingBarcode: boolean;
  nextProducts: Product[];
}

/**
 * Validates whether a proposed mutation field is in the allowlist.
 */
export function validateMutationField(field: string): { isValid: boolean; error?: string } {
  if (!field || typeof field !== 'string') {
    return { isValid: false, error: 'Field specification must be a non-empty string.' };
  }

  const isAllowedPrefix = ALLOWED_FIELD_PREFIXES.some(prefix => field.startsWith(prefix));
  if (!isAllowedPrefix) {
    return {
      isValid: false,
      error: `Field "${field}" is not in the mutation allowlist.`,
    };
  }

  if (field.startsWith('variants[')) {
    const match = field.match(/^variants\[(\d+)\]\.(barcode|sku|price|title)$/);
    if (!match) {
      return {
        isValid: false,
        error: `Variant field "${field}" is invalid. Must specify a valid variant property (e.g. variants[0].barcode).`,
      };
    }
  }

  if (field.startsWith('attributes.')) {
    const attrKey = field.replace('attributes.', '');
    if (!SUPPORTED_ATTRIBUTES_ALLOWLIST.has(attrKey)) {
      return {
        isValid: false,
        error: `Attribute "${attrKey}" is not a recognized structured attribute.`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Executes action approval and local catalog mutation.
 * CRITICAL DOMAIN RULE: Approval DOES NOT imply catalog verification!
 * The action transitions to 'approved', but its verificationStatus remains 'recheck_required'
 * until a genuine re-check verifies the mutated state.
 */
export function executeActionApproval(
  actionId: string,
  customApprovedValue: string | undefined,
  ctx: MutationContext
): MutationExecutionResult {
  if (ctx.isReadOnly) {
    return {
      success: false,
      errorCode: 'READ_ONLY_MODE',
      message: 'Catalog is in read-only mode to protect your store data.',
      nextProducts: ctx.products,
      nextFindings: ctx.findings,
      nextActions: ctx.actionItems,
      nextStoreProfile: ctx.storeProfile,
    };
  }

  const item = ctx.actionItems.find(a => a.id === actionId);
  if (!item) {
    return {
      success: false,
      errorCode: 'ACTION_NOT_FOUND',
      message: `Action with ID "${actionId}" was not found.`,
      nextProducts: ctx.products,
      nextFindings: ctx.findings,
      nextActions: ctx.actionItems,
      nextStoreProfile: ctx.storeProfile,
    };
  }

  if (item.status !== 'pending_review') {
    return {
      success: false,
      errorCode: 'ACTION_INELIGIBLE',
      message: `Action "${item.title}" is already ${item.status.replace(/_/g, ' ')}.`,
      nextProducts: ctx.products,
      nextFindings: ctx.findings,
      nextActions: ctx.actionItems,
      nextStoreProfile: ctx.storeProfile,
    };
  }

  const fieldValidation = validateMutationField(item.proposedChange.field);
  if (!fieldValidation.isValid) {
    return {
      success: false,
      errorCode: 'UNSUPPORTED_FIELD',
      message: fieldValidation.error || 'Unsupported mutation field.',
      nextProducts: ctx.products,
      nextFindings: ctx.findings,
      nextActions: ctx.actionItems,
      nextStoreProfile: ctx.storeProfile,
    };
  }

  const valueToApply = customApprovedValue !== undefined && customApprovedValue.trim() !== ''
    ? customApprovedValue.trim()
    : item.proposedChange.to;

  let nextProducts = ctx.products;

  // If the action targets a specific canonical product
  if (item.productId) {
    const targetProduct = ctx.products.find(p => p.id === item.productId);
    if (!targetProduct) {
      return {
        success: false,
        errorCode: 'PRODUCT_NOT_FOUND',
        message: `Target product "${item.productId}" was not found in catalog.`,
        nextProducts: ctx.products,
        nextFindings: ctx.findings,
        nextActions: ctx.actionItems,
        nextStoreProfile: ctx.storeProfile,
      };
    }

    const changeField = item.proposedChange.field;

    // Variant-specific mutation
    if (changeField.startsWith('variants[')) {
      const match = changeField.match(/variants\[(\d+)\]/);
      if (!match) {
        return {
          success: false,
          errorCode: 'INVALID_VARIANT_TARGET',
          message: `Could not parse variant target index from "${changeField}".`,
          nextProducts: ctx.products,
          nextFindings: ctx.findings,
          nextActions: ctx.actionItems,
          nextStoreProfile: ctx.storeProfile,
        };
      }

      const targetIndex = parseInt(match[1], 10);
      if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= targetProduct.variants.length) {
        return {
          success: false,
          errorCode: 'VARIANT_OUT_OF_BOUNDS',
          message: `Variant target index [${targetIndex}] is out of bounds for product "${targetProduct.id}" (${targetProduct.variants.length} variants).`,
          nextProducts: ctx.products,
          nextFindings: ctx.findings,
          nextActions: ctx.actionItems,
          nextStoreProfile: ctx.storeProfile,
        };
      }

      nextProducts = ctx.products.map(p => {
        if (p.id !== item.productId) return p;
        const updatedVariants = p.variants.map((v, idx) => {
          if (idx === targetIndex) {
            return { ...v, barcode: valueToApply };
          }
          return v;
        });
        const updatedProduct: Product = {
          ...p,
          variants: updatedVariants,
          completenessScore: 0, // Recalculated below
        };
        updatedProduct.completenessScore = calculateProductCompleteness(updatedProduct);
        return updatedProduct;
      });
    } else if (changeField.startsWith('attributes.')) {
      const attrKey = changeField.replace('attributes.', '');
      nextProducts = ctx.products.map(p => {
        if (p.id !== item.productId) return p;
        const updatedProduct: Product = {
          ...p,
          attributes: {
            ...p.attributes,
            [attrKey]: valueToApply,
          },
          completenessScore: 0, // Recalculated below
        };
        updatedProduct.completenessScore = calculateProductCompleteness(updatedProduct);
        return updatedProduct;
      });
    } else if (changeField.includes('title')) {
      // Marketing claim reconciliation
      nextProducts = ctx.products.map(p => {
        if (p.id !== item.productId) return p;
        const updatedProduct: Product = {
          ...p,
          attributes: {
            ...p.attributes,
            verifiedBurnTime: valueToApply,
          },
          completenessScore: 0, // Recalculated below
        };
        updatedProduct.completenessScore = calculateProductCompleteness(updatedProduct);
        return updatedProduct;
      });
    }
  }

  // Update Action Item state
  // CRITICAL: verificationStatus remains 'recheck_required'! Approval does NOT equal verification!
  const nextActions = ctx.actionItems.map(act => {
    if (act.id === actionId) {
      return {
        ...act,
        status: 'approved' as const,
        approvedAt: new Date().toISOString(),
        proposedChange: {
          ...act.proposedChange,
          to: valueToApply,
        },
        verificationStatus: 'recheck_required' as const,
        recheckNotes: 'Merchant approved correction. Re-check required to verify catalog schema compliance.',
      };
    }
    return act;
  });

  // Preserve finding status: finding.merchantVerified is false until re-check confirms verification
  const nextFindings = ctx.findings.map(f => {
    if (f.actionItemId === actionId) {
      return { ...f, merchantVerified: false };
    }
    return f;
  });

  const nextStoreProfile: StoreProfile = {
    ...ctx.storeProfile,
    catalogCompletenessAvg: calculateStoreCompletenessAvg(nextProducts),
  };

  const updatedAction = nextActions.find(a => a.id === actionId);

  return {
    success: true,
    message: `Approved change for "${item.title}". Internal catalog model updated. Re-check required for verification.`,
    nextProducts,
    nextFindings,
    nextActions,
    nextStoreProfile,
    targetAction: updatedAction,
  };
}

/**
 * Executes action dismissal.
 */
export function executeActionDismissal(
  actionId: string,
  ctx: MutationContext
): MutationExecutionResult {
  if (ctx.isReadOnly) {
    return {
      success: false,
      errorCode: 'READ_ONLY_MODE',
      message: 'Catalog is in read-only mode to protect your store data.',
      nextProducts: ctx.products,
      nextFindings: ctx.findings,
      nextActions: ctx.actionItems,
      nextStoreProfile: ctx.storeProfile,
    };
  }

  const nextActions = ctx.actionItems.map(act => {
    if (act.id === actionId) {
      return {
        ...act,
        status: 'dismissed' as const,
        dismissedAt: new Date().toISOString(),
        verificationStatus: 'unverified' as const,
        recheckNotes: 'Action was dismissed by merchant.',
      };
    }
    return act;
  });

  return {
    success: true,
    message: 'Action moved to dismissed queue.',
    nextProducts: ctx.products,
    nextFindings: ctx.findings,
    nextActions,
    nextStoreProfile: ctx.storeProfile,
  };
}

/**
 * Executes genuine validation against actual catalog state.
 * Evaluates target product presence, variant barcode check digits, and attribute equality.
 */
export function executeActionRecheck(
  actionId: string,
  ctx: MutationContext
): RecheckExecutionResult {
  if (ctx.isReadOnly) {
    return {
      success: false,
      isVerified: false,
      errorCode: 'READ_ONLY_MODE',
      verificationStatus: 'unverified',
      recheckNotes: 'Catalog is in read-only mode.',
      message: 'Re-check disabled: Catalog is in read-only mode.',
      nextActions: ctx.actionItems,
      nextFindings: ctx.findings,
    };
  }

  const item = ctx.actionItems.find(a => a.id === actionId);
  if (!item) {
    return {
      success: false,
      isVerified: false,
      errorCode: 'ACTION_NOT_FOUND',
      verificationStatus: 'unverified',
      recheckNotes: 'Action not found.',
      message: `Action "${actionId}" was not found for re-check.`,
      nextActions: ctx.actionItems,
      nextFindings: ctx.findings,
    };
  }

  if (item.status !== 'approved') {
    const nextActions = ctx.actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          verificationStatus: 'recheck_required' as const,
          lastRecheckTimestamp: new Date().toISOString(),
          recheckNotes: 'Re-check failed: Action has not been approved or applied yet. Human review required.',
        };
      }
      return act;
    });

    return {
      success: true,
      isVerified: false,
      errorCode: 'ACTION_PENDING',
      verificationStatus: 'recheck_required',
      recheckNotes: 'Action has not been approved or applied yet. Human review required.',
      message: `Re-check observed that "${item.title}" still requires merchant review.`,
      nextActions,
      nextFindings: ctx.findings,
    };
  }

  // Action is approved: perform genuine verification against the current catalog
  let isValid = true;
  let failureReason = '';

  if (item.productId) {
    const targetProd = ctx.products.find(p => p.id === item.productId);
    if (!targetProd) {
      isValid = false;
      failureReason = `Target product "${item.productId}" not found in catalog.`;
    } else {
      const changeField = item.proposedChange.field;
      const expectedValue = item.proposedChange.to;

      if (changeField.startsWith('variants[')) {
        const match = changeField.match(/variants\[(\d+)\]/);
        const targetIndex = match ? parseInt(match[1], 10) : 0;
        const targetVariant = targetProd.variants[targetIndex];

        if (!targetVariant) {
          isValid = false;
          failureReason = `Target variant index [${targetIndex}] does not exist on product.`;
        } else if (targetVariant.barcode !== expectedValue) {
          isValid = false;
          failureReason = `Variant barcode "${targetVariant.barcode || '(empty)'}" does not match approved value "${expectedValue}".`;
        } else if (!isValidGtin13(targetVariant.barcode)) {
          isValid = false;
          failureReason = `Variant barcode "${targetVariant.barcode}" fails GTIN-13 check digit validation.`;
        }
      } else if (changeField.startsWith('attributes.')) {
        const attrKey = changeField.replace('attributes.', '');
        const currentVal = targetProd.attributes[attrKey];
        if (currentVal !== expectedValue) {
          isValid = false;
          failureReason = `Attribute "${attrKey}" (${currentVal || '(none)'}) does not match approved value "${expectedValue}".`;
        }
      } else if (changeField.includes('title')) {
        if (targetProd.attributes.verifiedBurnTime !== expectedValue) {
          isValid = false;
          failureReason = `Specification claim reconciliation not found in attributes. Expected "${expectedValue}".`;
        }
      }
    }
  }

  const nextVerificationStatus = isValid
    ? ('verified_in_catalog' as const)
    : ('verification_failed' as const);

  const recheckNotes = isValid
    ? 'Re-check validated against local catalog schema rules: All format requirements met.'
    : `Re-check failed: ${failureReason}`;

  const nextActions = ctx.actionItems.map(act => {
    if (act.id === actionId) {
      return {
        ...act,
        verificationStatus: nextVerificationStatus,
        lastRecheckTimestamp: new Date().toISOString(),
        recheckNotes,
      };
    }
    return act;
  });

  // When re-check verifies successfully, update finding.merchantVerified to true
  const nextFindings = ctx.findings.map(f => {
    if (f.actionItemId === actionId) {
      return { ...f, merchantVerified: isValid };
    }
    return f;
  });

  return {
    success: true,
    isVerified: isValid,
    errorCode: isValid ? undefined : 'VERIFICATION_FAILED',
    verificationStatus: nextVerificationStatus,
    recheckNotes,
    message: isValid
      ? `Catalog consistency confirmed for "${item.title}". Meets schema requirements.`
      : `Verification failed for "${item.title}": ${failureReason}`,
    nextActions,
    nextFindings,
  };
}

/**
 * Validates a single product's variants and GTIN codes.
 */
export function executeProductRecheck(
  productId: string,
  ctx: MutationContext
): ProductRecheckResult {
  if (ctx.isReadOnly) {
    return {
      success: false,
      message: 'Catalog is in read-only mode to protect your store data.',
      hasInvalidBarcode: false,
      hasMissingBarcode: false,
      nextProducts: ctx.products,
    };
  }

  const prod = ctx.products.find(p => p.id === productId);
  if (!prod) {
    return {
      success: false,
      message: `Product "${productId}" not found for re-check.`,
      hasInvalidBarcode: false,
      hasMissingBarcode: false,
      nextProducts: ctx.products,
    };
  }

  const hasInvalidBarcode = prod.variants.some(v => v.barcode && !isValidGtin13(v.barcode));
  const hasMissingBarcode = prod.variants.some(v => !v.barcode);

  const nextProducts = ctx.products.map(p => {
    if (p.id === productId) {
      const updated = {
        ...p,
        lastAudited: new Date().toISOString(),
      };
      updated.completenessScore = calculateProductCompleteness(updated);
      return updated;
    }
    return p;
  });

  let message = `Re-analyzed schema consistency for "${prod.title}". All variant identifiers valid.`;
  if (hasInvalidBarcode) {
    message = `Validation Warning: Variant on "${prod.title}" has invalid GTIN check digit.`;
  } else if (hasMissingBarcode) {
    message = `Re-analyzed schema consistency for "${prod.title}". Missing GTIN detected on variant.`;
  }

  return {
    success: true,
    message,
    hasInvalidBarcode,
    hasMissingBarcode,
    nextProducts,
  };
}
