import { Product, Finding, ActionItem, StoreProfile, CatalogImportResult } from '../../types';
import { isValidGtin13 } from '../validation/gtin';
import { evaluateCandidateProducts } from '../ingestion/storeIngestion';
import { DECIMAL_PRICE_REGEX, parseDecimalPrice } from '../validation/price';
import { calculateProductCompleteness, calculateStoreCompletenessAvg } from './completeness';

export { calculateProductCompleteness, calculateStoreCompletenessAvg };

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

  const valueToApply = customApprovedValue !== undefined
    ? customApprovedValue
    : (item.proposedChange.to ?? (item.proposedChange as any)?.proposed);

  let nextProducts = ctx.products;
  let nextStoreProfile: StoreProfile = {
    ...ctx.storeProfile,
  };

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
      const match = changeField.match(/^variants\[(\d+)\]\.(barcode|sku|price|title)$/);
      if (!match) {
        return {
          success: false,
          errorCode: 'INVALID_VARIANT_TARGET',
          message: `Could not parse variant target index and property from "${changeField}".`,
          nextProducts: ctx.products,
          nextFindings: ctx.findings,
          nextActions: ctx.actionItems,
          nextStoreProfile: ctx.storeProfile,
        };
      }

      const targetIndex = parseInt(match[1], 10);
      const targetProperty = match[2] as 'barcode' | 'sku' | 'price' | 'title';

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

      let numericPrice: number | undefined;
      if (targetProperty === 'price') {
        const parsed = parseDecimalPrice(valueToApply);
        if (!parsed.isValid || parsed.price === null) {
          return {
            success: false,
            errorCode: 'UNSUPPORTED_FIELD',
            message: parsed.reason || `Invalid price "${valueToApply}".`,
            nextProducts: ctx.products,
            nextFindings: ctx.findings,
            nextActions: ctx.actionItems,
            nextStoreProfile: ctx.storeProfile,
          };
        }
        numericPrice = parsed.price;
      } else if (targetProperty === 'sku' || targetProperty === 'title') {
        if (!valueToApply || valueToApply.trim() === '') {
          return {
            success: false,
            errorCode: 'UNSUPPORTED_FIELD',
            message: `Variant ${targetProperty} cannot be empty.`,
            nextProducts: ctx.products,
            nextFindings: ctx.findings,
            nextActions: ctx.actionItems,
            nextStoreProfile: ctx.storeProfile,
          };
        }
      }

      nextProducts = ctx.products.map(p => {
        if (p.id !== item.productId) return p;
        const updatedVariants = p.variants.map((v, idx) => {
          if (idx === targetIndex) {
            if (targetProperty === 'barcode') {
              return { ...v, barcode: valueToApply };
            } else if (targetProperty === 'sku') {
              return { ...v, sku: valueToApply.trim() };
            } else if (targetProperty === 'title') {
              return { ...v, title: valueToApply.trim() };
            } else if (targetProperty === 'price' && numericPrice !== undefined) {
              return { ...v, price: numericPrice };
            }
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
      if (!SUPPORTED_ATTRIBUTES_ALLOWLIST.has(attrKey)) {
        return {
          success: false,
          errorCode: 'UNSUPPORTED_FIELD',
          message: `Attribute "${attrKey}" is not a recognized structured attribute.`,
          nextProducts: ctx.products,
          nextFindings: ctx.findings,
          nextActions: ctx.actionItems,
          nextStoreProfile: ctx.storeProfile,
        };
      }

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
    } else if (changeField === 'title / marketing claims') {
      // Explicit marketing claim reconciliation
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
    } else {
      return {
        success: false,
        errorCode: 'UNSUPPORTED_FIELD',
        message: `Field "${changeField}" is not supported for product mutation.`,
        nextProducts: ctx.products,
        nextFindings: ctx.findings,
        nextActions: ctx.actionItems,
        nextStoreProfile: ctx.storeProfile,
      };
    }
  } else {
    // Global / store-level mutation
    const changeField = item.proposedChange.field;
    if (changeField === 'store.catalogPolicy.units') {
      nextStoreProfile = {
        ...nextStoreProfile,
        catalogPolicy: {
          ...nextStoreProfile.catalogPolicy,
          units: valueToApply,
        },
      };
    } else if (changeField === 'connectors.gmc.shipping_sla') {
      nextStoreProfile = {
        ...nextStoreProfile,
        shippingSla: {
          ...nextStoreProfile.shippingSla,
          gmc: valueToApply,
        },
      };
    } else {
      return {
        success: false,
        errorCode: 'UNSUPPORTED_FIELD',
        message: `Global field "${changeField}" is not supported for store mutation.`,
        nextProducts: ctx.products,
        nextFindings: ctx.findings,
        nextActions: ctx.actionItems,
        nextStoreProfile: ctx.storeProfile,
      };
    }
  }

  nextStoreProfile.catalogCompletenessAvg = calculateStoreCompletenessAvg(nextProducts);

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
        const match = changeField.match(/^variants\[(\d+)\]\.(barcode|sku|price|title)$/);
        if (!match) {
          isValid = false;
          failureReason = `Could not parse variant field "${changeField}".`;
        } else {
          const targetIndex = parseInt(match[1], 10);
          const targetProperty = match[2] as 'barcode' | 'sku' | 'price' | 'title';
          const targetVariant = targetProd.variants[targetIndex];

          if (!targetVariant) {
            isValid = false;
            failureReason = `Target variant index [${targetIndex}] does not exist on product.`;
          } else if (targetProperty === 'barcode') {
            if (targetVariant.barcode !== expectedValue) {
              isValid = false;
              failureReason = `Variant barcode "${targetVariant.barcode || '(empty)'}" does not match approved value "${expectedValue}".`;
            } else if (!isValidGtin13(targetVariant.barcode)) {
              isValid = false;
              failureReason = `Variant barcode "${targetVariant.barcode}" fails GTIN-13 check digit validation.`;
            }
          } else if (targetProperty === 'sku') {
            if (targetVariant.sku !== expectedValue) {
              isValid = false;
              failureReason = `Variant SKU "${targetVariant.sku || '(empty)'}" does not match approved value "${expectedValue}".`;
            }
          } else if (targetProperty === 'title') {
            if (targetVariant.title !== expectedValue) {
              isValid = false;
              failureReason = `Variant title "${targetVariant.title || '(empty)'}" does not match approved value "${expectedValue}".`;
            }
          } else if (targetProperty === 'price') {
            const parsed = parseDecimalPrice(expectedValue);
            if (!parsed.isValid || parsed.price === null) {
              isValid = false;
              failureReason = parsed.reason || `Expected price is empty or invalid.`;
            } else {
              const expectedPrice = parsed.price;
              if (targetVariant.price !== expectedPrice) {
                isValid = false;
                failureReason = `Variant price "${targetVariant.price}" does not match approved value "${expectedPrice}".`;
              }
            }
          }
        }
      } else if (changeField.startsWith('attributes.')) {
        const attrKey = changeField.replace('attributes.', '');
        const currentVal = targetProd.attributes[attrKey];
        if (currentVal !== expectedValue) {
          isValid = false;
          failureReason = `Attribute "${attrKey}" (${currentVal || '(none)'}) does not match approved value "${expectedValue}".`;
        }
      } else if (changeField === 'title / marketing claims') {
        if (targetProd.attributes.verifiedBurnTime !== expectedValue) {
          isValid = false;
          failureReason = `Specification claim reconciliation not found in attributes. Expected "${expectedValue}".`;
        }
      } else {
        isValid = false;
        failureReason = `Unsupported field "${changeField}" for product re-check.`;
      }
    }
  } else {
    // Global / store-level re-check
    const changeField = item.proposedChange.field;
    const expectedValue = item.proposedChange.to;

    if (changeField === 'store.catalogPolicy.units') {
      const currentUnits = ctx.storeProfile.catalogPolicy?.units;
      if (currentUnits !== expectedValue) {
        isValid = false;
        failureReason = `Store catalog units policy "${currentUnits || '(none)'}" does not match approved value "${expectedValue}".`;
      }
    } else if (changeField === 'connectors.gmc.shipping_sla') {
      const currentSla = ctx.storeProfile.shippingSla?.gmc;
      if (currentSla !== expectedValue) {
        isValid = false;
        failureReason = `Connector GMC shipping SLA "${currentSla || '(none)'}" does not match approved value "${expectedValue}".`;
      }
    } else {
      isValid = false;
      failureReason = `Unrecognized global field "${changeField}" for store re-check.`;
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

export interface CatalogImportContext {
  products: Product[];
  findings: Finding[];
  actionItems: ActionItem[];
  storeProfile: StoreProfile;
  isReadOnly: boolean;
}

/**
 * Safely imports validated candidate products into the merchant catalog.
 * - Idempotent: Skips duplicates based on stable source identifiers.
 * - Non-destructive: Never overwrites merchant-edited fields (conflicts are preserved).
 * - Enforces read-only mode and domain validation rules.
 * - Recalculates catalog completeness and SKU metrics accurately.
 * - Explicitly notes that internal import does not modify the external merchant store.
 */
export function executeCatalogImport(
  candidates: Product[],
  ctx: CatalogImportContext
): CatalogImportResult {
  if (ctx.isReadOnly) {
    return {
      success: false,
      importedCount: 0,
      skippedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      message: 'Catalog is in read-only mode. Import aborted.',
      importedProducts: [],
      nextProducts: ctx.products,
      nextStoreProfile: ctx.storeProfile,
      details: [],
    };
  }

  if (!candidates || candidates.length === 0) {
    return {
      success: true,
      importedCount: 0,
      skippedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      message: 'No candidate products provided for import.',
      importedProducts: [],
      nextProducts: ctx.products,
      nextStoreProfile: ctx.storeProfile,
      details: [],
    };
  }

  const { candidateDetails, eligibleProducts } = evaluateCandidateProducts(candidates, ctx.products);

  let skippedCount = 0;
  let rejectedCount = 0;
  let conflictCount = 0;

  candidateDetails.forEach(d => {
    if (d.status === 'duplicate') skippedCount++;
    else if (d.status === 'rejected') rejectedCount++;
    else if (d.status === 'conflict') conflictCount++;
  });

  if (eligibleProducts.length === 0) {
    return {
      success: true,
      importedCount: 0,
      skippedCount,
      rejectedCount,
      conflictCount,
      message: `0 products imported (${skippedCount} duplicates skipped, ${rejectedCount} rejected, ${conflictCount} conflicts preserved).`,
      importedProducts: [],
      nextProducts: ctx.products,
      nextStoreProfile: ctx.storeProfile,
      details: candidateDetails,
    };
  }

  // Ensure each newly imported product has valid completeness score calculated
  const newProductsWithScores = eligibleProducts.map(p => ({
    ...p,
    completenessScore: calculateProductCompleteness(p),
  }));

  const nextProducts = [...ctx.products, ...newProductsWithScores];
  const addedVariantCount = newProductsWithScores.reduce((sum, p) => sum + (p.variants?.length || 0), 0);
  const nextStoreProfile: StoreProfile = {
    ...ctx.storeProfile,
    skuCount: ctx.storeProfile.skuCount + addedVariantCount,
    catalogCompletenessAvg: calculateStoreCompletenessAvg(nextProducts),
    lastAuditDate: new Date().toISOString(),
  };

  return {
    success: true,
    importedCount: newProductsWithScores.length,
    skippedCount,
    rejectedCount,
    conflictCount,
    message: `Successfully imported ${newProductsWithScores.length} products into catalog (${skippedCount} duplicates skipped, ${rejectedCount} rejected, ${conflictCount} conflicts preserved). Note: No external store write-back was performed.`,
    importedProducts: newProductsWithScores,
    nextProducts,
    nextStoreProfile,
    details: candidateDetails,
  };
}

