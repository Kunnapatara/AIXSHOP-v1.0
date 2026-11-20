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

const VERIFIED_GTIN_EXEMPTION_DOC_REGEX =
  /\b(gtin|barcode|upc|ean|gs1|gtin[- ]?exempt(?:ion)?|identifier[- ]?exempt(?:ion)?|custom[- ]?made|bespoke|handmade|vintage|antique|digital[- ]?(?:download|good|product)|gift[- ]?card)\b/i;

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

function hasAuthoritativeVerifiedGtinExemption(product: Product): { verified: boolean; reason?: string } {
  const attrs = product.attributes || {};

  // Authoritative Shopify platform gift card boolean flag synced from Admin GraphQL `isGiftCard`
  if (normalizedAttrBool(attrs.shopifyIsGiftCard)) {
    return {
      verified: true,
      reason: 'Shopify Admin API marks product as an authoritative Gift Card (isGiftCard=true).',
    };
  }

  // Verified merchant exemption backing reference (requires explicit verified flag + evidence reference)
  if (normalizedAttrBool(attrs.gtinExemptionVerified) && Boolean((attrs.gtinExemptionEvidenceRef || '').trim())) {
    return {
      verified: true,
      reason: `Verified GTIN exemption evidence reference supplied (${attrs.gtinExemptionEvidenceRef.trim()}).`,
    };
  }

  // Verified evidence document attached to product establishing GS1/marketplace GTIN exemption
  const matchingVerifiedDoc = (product.evidenceDocuments || []).find((doc) => {
    if (!doc || doc.status !== 'verified') return false;
    const text = `${doc.title || ''} ${doc.issuer || ''} ${doc.type || ''}`;
    return VERIFIED_GTIN_EXEMPTION_DOC_REGEX.test(text);
  });

  if (matchingVerifiedDoc) {
    return {
      verified: true,
      reason: `Verified evidence document "${matchingVerifiedDoc.title}" (${matchingVerifiedDoc.issuer}) documents GTIN exemption eligibility.`,
    };
  }

  return { verified: false };
}

/**
 * Classifies a product into explicit domain & category applicability buckets
 * so category-specific audit rules never trigger false positives on unrelated goods.
 *
 * GTIN exemption uses strict evidence-based eligibility:
 * - Keyword matches in title/category (e.g. "Handmade", "Vintage", "Digital") are NEVER treated as proof of exemption.
 * - Missing barcodes are NEVER treated as proof of exemption.
 * - Only verified exemption evidence grants `verified_exempt`.
 * - Explicit merchant identifier-absence declarations (`identifierExists=no/false`) are classified distinctly as `declared_identifier_absence`.
 * - Missing evidence defaults to `insufficient_evidence` (NEEDS_REVIEW).
 */
export function classifyProductDomain(product: Product): ProductDomainClassification {
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
  const verifiedExemption = hasAuthoritativeVerifiedGtinExemption(product);
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
      'NEEDS_REVIEW: Insufficient evidence for GTIN exemption; listing title keywords or a missing barcode do not establish exemption.';
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
