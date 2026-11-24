import { GtinEligibilityStatus, Product } from '../../types';

export interface ProductDomainClassification {
  isGtinExempt: boolean;
  gtinEligibilityStatus: GtinEligibilityStatus;
  gtinExemptionReason?: string;
  isDrinkwareOrTableware: boolean;
  isConsumableCoffeeOrTea: boolean;
  isCandleOrHomeFragrance: boolean;
  isTextileOrApparel: boolean;
}

export interface TrustedGtinExemptionProof {
  evidenceId: string;
  reference: string;
  verifiedBy: string;
  reviewedAt: string;
  integrityHash: string;
  sourceType: 'server_reviewer' | 'external_registry';
}

export interface TrustedShopifyGiftCardProof {
  shopDomain: string;
  shopifyProductId: string;
  shopifyGid: string;
  isGiftCard: true;
  sourceType: 'shopify_graphql_admin_api' | 'shopify_webhook';
  verifiedAt: string;
  shopifyUpdatedAt?: string | null;
}

export interface TrustedGtinVerificationContext {
  workspaceId?: string;
  verifiedExemptionByProductId?: ReadonlyMap<string, TrustedGtinExemptionProof>;
  verifiedGiftCardByProductId?: ReadonlyMap<string, TrustedShopifyGiftCardProof>;
}

const THERMAL_FOODWARE_CATEGORY_REGEX = /\b(drinkware|tableware|dinnerware|cookware|bakeware|kitchenware)\b/i;

const THERMAL_FOODWARE_INCLUDE_REGEX = /\b(drinkware|tableware|dinnerware|cookware|bakeware|kitchenware|mug|mugs|teacup|cup|cups|tumbler|glassware|pitcher|teapot|carafe|bowl|bowls|plate|plates|dish|dishes|platter|ramekin|casserole|food container|meal prep)\b/i;

const THERMAL_FOODWARE_NON_FOOD_REGEX = /\b(planter|flower pot|plant pot|cachepot|vase|lamp|figurine|statue|ornament|soap dispenser|bath|sink|tile|decor|wall art|apparel|workwear|apron|shirt|footwear|shoe|sneaker|slipper|fragrance|perfume|cosmetic|skincare|bag|backpack|furniture|electronics)\b/i;

const COFFEE_TEA_CATEGORY_REGEX = /\b(coffee|espresso|roast|whole bean|ground coffee|matcha|loose leaf tea|herbal tea|tea & coffee|coffee & tea)\b/i;

const NON_CONSUMABLE_COFFEE_CONTEXT_REGEX = /\b(mug|cup|tumbler|table|candle|wax|scent|fragrance|scrub|soap|lotion|apron|grinder|kettle|maker|brewer|filter|carafe|machine|scale)\b/i;

const CANDLE_REGEX = /\b(candle|candles|soy wax|beeswax|tealight|votive|pillar candle|wax melt)\b/i;

const TEXTILE_APPAREL_REGEX = /\b(textile|apparel|clothing|workwear|apron|linen|cotton|wool|merino|flax|bedding|towel|blanket|fabric|shirt|jacket|pants|dress|garment)\b/i;

function normalizedAttrBool(value?: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

/**
 * Resolves GTIN exemption ONLY from server-owned TrustedGtinVerificationContext.
 * Raw client-editable product attributes (e.g. shopifyIsGiftCard, gtinExemptionVerified,
 * gtinExemptionEvidenceRef) and raw unbacked evidenceDocuments[].status === 'verified'
 * are NEVER trusted without server-owned proof.
 */
function hasAuthoritativeVerifiedGtinExemption(
  product: Product,
  trustedContext?: TrustedGtinVerificationContext
): { verified: boolean; reason?: string } {
  if (!trustedContext) {
    return { verified: false };
  }

  // 1. Authoritative server-owned Shopify provenance bound to workspace, shop domain, and Shopify IDs
  const giftCardProof = trustedContext.verifiedGiftCardByProductId?.get(product.id);
  if (
    giftCardProof &&
    giftCardProof.isGiftCard === true &&
    Boolean(giftCardProof.shopDomain?.trim()) &&
    Boolean(giftCardProof.shopifyProductId?.trim()) &&
    Boolean(giftCardProof.shopifyGid?.trim()) &&
    Boolean(giftCardProof.verifiedAt?.trim())
  ) {
    const attrProdId = (product.attributes?.sourceProductId || '').trim();
    const attrGid = (product.attributes?.shopifyGid || '').trim();
    const idsCompatible =
      (!attrProdId || attrProdId === giftCardProof.shopifyProductId) &&
      (!attrGid || attrGid === giftCardProof.shopifyGid);

    if (idsCompatible) {
      return {
        verified: true,
        reason: `Shopify Admin provenance (${giftCardProof.sourceType}, shop ${giftCardProof.shopDomain}) verifies product as Gift Card (verifiedAt=${giftCardProof.verifiedAt}).`,
      };
    }
  }

  // 2. Authoritative server-reviewed GTIN exemption evidence belonging to this workspace & non-deleted product
  const exemptionProof = trustedContext.verifiedExemptionByProductId?.get(product.id);
  if (
    exemptionProof &&
    Boolean(exemptionProof.evidenceId?.trim()) &&
    Boolean(exemptionProof.verifiedBy?.trim()) &&
    Boolean(exemptionProof.reviewedAt?.trim()) &&
    Boolean(exemptionProof.integrityHash?.trim()) &&
    (exemptionProof.sourceType === 'server_reviewer' || exemptionProof.sourceType === 'external_registry')
  ) {
    const matchingDoc = (product.evidenceDocuments || []).find(
      (doc) => {
        if (
          !doc ||
          doc.id !== exemptionProof.evidenceId ||
          doc.status !== 'verified' ||
          doc.decision !== 'approved' ||
          doc.evidencePurpose !== 'gtin_exemption' ||
          doc.integrityHash !== exemptionProof.integrityHash
        ) {
          return false;
        }
        if (doc.verificationSource === 'external_registry') {
          return (
            doc.externalVerificationStatus === 'external_registry_verified' &&
            Boolean(doc.externalProviderName?.trim()) &&
            Boolean(doc.externalProviderRef?.trim())
          );
        }
        return doc.verificationSource === 'server_reviewer';
      }
    );

    if (matchingDoc) {
      return {
        verified: true,
        reason: `Server-verified GTIN exemption evidence "${matchingDoc.title}" (reviewer=${exemptionProof.verifiedBy}, ref=${exemptionProof.reference}).`,
      };
    }
  }

  return { verified: false };
}

/**
 * Classifies a product into explicit domain & category applicability buckets
 * so category-specific audit rules never trigger false positives on unrelated goods.
 *
 * GTIN exemption uses strict server-owned evidence-based eligibility:
 * - Keyword matches in title/category (e.g. "Handmade", "Vintage", "Digital") are NEVER treated as proof of exemption.
 * - Missing barcodes are NEVER treated as proof of exemption.
 * - Client-supplied flags (shopifyIsGiftCard, gtinExemptionVerified, status: 'verified') are NEVER trusted without TrustedGtinVerificationContext.
 * - Only server-verified exemption proof or server-owned Shopify provenance grants `verified_exempt`.
 * - Explicit merchant identifier-absence declarations (`identifierExists=no/false` / `gtinExemption=true`) classify distinctly as `declared_identifier_absence`.
 * - Missing or unverified evidence defaults to `insufficient_evidence` (NEEDS_REVIEW).
 */
export function classifyProductDomain(
  product: Product,
  trustedContext?: TrustedGtinVerificationContext
): ProductDomainClassification {
  const title = (product.title || '').trim();
  const category = (product.category || '').trim();
  const description = (product.description || '').trim();
  const attrs = product.attributes || {};
  const variants = product.variants || [];

  // 1. Evidence-based GTIN eligibility assessment
  let isGtinExempt = false;
  let gtinEligibilityStatus: GtinEligibilityStatus = 'insufficient_evidence';
  let gtinExemptionReason: string | undefined;

  const hasAnySuppliedBarcode = variants.some((v) => Boolean((v.barcode || '').trim()));
  const verifiedExemption = hasAuthoritativeVerifiedGtinExemption(product, trustedContext);
  const identifierExists = (attrs.identifierExists || attrs.identifier_exists || '').trim().toLowerCase();
  const hasExplicitAbsenceDeclaration =
    identifierExists === 'no' ||
    identifierExists === 'false' ||
    normalizedAttrBool(attrs.gtinExemption);

  if (verifiedExemption.verified) {
    isGtinExempt = true;
    gtinEligibilityStatus = 'verified_exempt';
    gtinExemptionReason = verifiedExemption.reason;
  } else if (hasExplicitAbsenceDeclaration) {
    isGtinExempt = false;
    gtinEligibilityStatus = 'declared_identifier_absence';
    gtinExemptionReason =
      'Merchant explicitly declared identifier absence / exemption without verified supporting documentation.';
  } else if (hasAnySuppliedBarcode) {
    isGtinExempt = false;
    gtinEligibilityStatus = 'gtin_present';
  } else {
    isGtinExempt = false;
    gtinEligibilityStatus = 'insufficient_evidence';
    gtinExemptionReason =
      'NEEDS_REVIEW: Insufficient evidence for GTIN exemption; listing title keywords, missing barcodes, or unverified client fields do not establish exemption.';
  }

  // 2. Drinkware / Tableware / Cookware applicability
  // Material "ceramic" alone must NOT trigger microwave/dishwasher safety (e.g. planters, vases, lamps, decor)
  const categoryLower = category.toLowerCase();
  const titleLower = title.toLowerCase();
  const explicitFoodwareCategory = THERMAL_FOODWARE_CATEGORY_REGEX.test(categoryLower);
  const hasFoodwareSignal = THERMAL_FOODWARE_INCLUDE_REGEX.test(`${categoryLower} ${titleLower}`);
  const hasNonFoodExclusion = THERMAL_FOODWARE_NON_FOOD_REGEX.test(`${categoryLower} ${titleLower}`);

  const isDrinkwareOrTableware =
    explicitFoodwareCategory ||
    (hasFoodwareSignal && !hasNonFoodExclusion && !COFFEE_TEA_CATEGORY_REGEX.test(categoryLower));

  // 3. Consumable Coffee / Tea beans & leaves (excludes coffee mugs, coffee tables, coffee scrubs)
  const explicitCoffeeCategory = COFFEE_TEA_CATEGORY_REGEX.test(categoryLower);
  const looksLikeCoffeeConsumableTitle = COFFEE_TEA_CATEGORY_REGEX.test(titleLower);
  const titleOrCatIsNonConsumableCoffeeItem =
    NON_CONSUMABLE_COFFEE_CONTEXT_REGEX.test(titleLower) && !explicitCoffeeCategory && categoryLower !== '';
  const hasExplicitBrewAttr = attrs.recommendedBrewMethods !== undefined;

  const isConsumableCoffeeOrTea =
    explicitCoffeeCategory ||
    (looksLikeCoffeeConsumableTitle && !titleOrCatIsNonConsumableCoffeeItem) ||
    hasExplicitBrewAttr;

  // 4. Candle / Home Fragrance
  const isCandleOrHomeFragrance = CANDLE_REGEX.test(`${categoryLower} ${titleLower}`);

  // 5. Textile / Apparel
  const isTextileOrApparel = TEXTILE_APPAREL_REGEX.test(`${categoryLower} ${titleLower} ${description.toLowerCase()}`);

  return {
    isGtinExempt,
    gtinEligibilityStatus,
    gtinExemptionReason,
    isDrinkwareOrTableware,
    isConsumableCoffeeOrTea,
    isCandleOrHomeFragrance,
    isTextileOrApparel,
  };
}
