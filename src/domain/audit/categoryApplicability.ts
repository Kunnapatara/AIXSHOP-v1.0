import { Product } from '../../types';

export interface ProductDomainClassification {
  isGtinExempt: boolean;
  gtinExemptionReason?: string;
  isDrinkwareOrTableware: boolean;
  isConsumableCoffeeOrTea: boolean;
  isCandleOrHomeFragrance: boolean;
  isTextileOrApparel: boolean;
}

const GTIN_EXEMPT_REGEX = /\b(handmade|hand-made|handcrafted|custom[- ]made|bespoke|made[- ]to[- ]order|one[- ]of[- ]a[- ]kind|vintage|antique|digital[- ]download|gift[- ]card)\b/i;

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
 * Classifies a product into explicit domain & category applicability buckets
 * so category-specific audit rules never trigger false positives on unrelated goods.
 */
export function classifyProductDomain(product: Product): ProductDomainClassification {
  const title = (product.title || '').trim();
  const category = (product.category || '').trim();
  const description = (product.description || '').trim();
  const attrs = product.attributes || {};

  // 1. GTIN Exemption check (explicit merchant flags or handmade/custom/bespoke goods)
  let isGtinExempt = false;
  let gtinExemptionReason: string | undefined;

  const identifierExists = (attrs.identifierExists || attrs.identifier_exists || '').trim().toLowerCase();
  if (
    normalizedAttrBool(attrs.gtinExemption) ||
    normalizedAttrBool(attrs.handmade) ||
    normalizedAttrBool(attrs.customMade) ||
    normalizedAttrBool(attrs.bespoke) ||
    normalizedAttrBool(attrs.madeToOrder) ||
    identifierExists === 'no' ||
    identifierExists === 'false'
  ) {
    isGtinExempt = true;
    gtinExemptionReason = 'Product metadata declares GTIN exemption / custom-made goods.';
  } else {
    const match = `${title} ${category}`.match(GTIN_EXEMPT_REGEX);
    if (match) {
      isGtinExempt = true;
      gtinExemptionReason = `Listing title or category indicates ${match[0].toLowerCase()} goods exempt from mandatory manufacturer GTIN.`;
    }
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
    gtinExemptionReason,
    isDrinkwareOrTableware,
    isConsumableCoffeeOrTea,
    isCandleOrHomeFragrance,
    isTextileOrApparel,
  };
}
