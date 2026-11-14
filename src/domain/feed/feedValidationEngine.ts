import { Product, Variant } from '../../types';
import { isValidGtin13 } from '../validation/gtin';

export type FeedPlatform = 'google_merchant_center' | 'meta_commerce' | 'schema_org';

export interface FeedValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  variantId?: string;
}

export interface ProductFeedEvaluation {
  productId: string;
  sku: string;
  title: string;
  variantCount?: number;
  isValid: boolean;
  errors: FeedValidationError[];
  warnings: FeedValidationError[];
}

export interface FeedReadinessReport {
  platform: FeedPlatform;
  totalProducts: number;
  validProductsCount: number;
  invalidProductsCount: number;
  readinessScore: number; // 0 - 100
  evaluatedAt: string;
  validationScope: 'local_structural_check_only';
  externalPlatformAccepted: false;
  limitationsNotice: string;
  evaluations: ProductFeedEvaluation[];
  summaryErrors: Record<string, number>;
}

export interface GmcFeedRow {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder' | '';
  price: string; // e.g. "29.99 USD" or "" when missing
  brand: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  identifier_exists: 'yes' | 'no';
  item_group_id?: string;
  validation_status?: 'valid' | 'invalid';
  validation_errors?: string;
}

export interface MetaFeedRow {
  id: string;
  title: string;
  description: string;
  availability: 'in stock' | 'out of stock' | 'available for order' | '';
  condition: 'new' | 'refurbished' | 'used' | '';
  price: string; // e.g. "29.99 USD" or "" when missing
  link: string;
  image_link: string;
  brand: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  item_group_id?: string;
  fb_product_category?: string;
  validation_status?: 'valid' | 'invalid';
  validation_errors?: string;
}

export interface SchemaOrgProductJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Product';
  name: string;
  description: string;
  image?: string;
  sku?: string;
  mpn?: string;
  gtin13?: string;
  brand?: {
    '@type': 'Brand';
    name: string;
  };
  offers?: {
    '@type': 'Offer';
    price?: number | string;
    priceCurrency?: string;
    availability?: string;
    url?: string;
    itemCondition?: string;
  };
  aixshopValidation?: {
    validationScope: 'local_structural_check_only';
    externalPlatformAccepted: false;
    status: 'valid' | 'invalid';
    errors: string[];
  };
}

const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> | null = (() => {
  try {
    const intlAny = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    if (typeof intlAny.supportedValuesOf === 'function') {
      return new Set(intlAny.supportedValuesOf('currency').map((c) => c.toUpperCase()));
    }
  } catch {
    // Fallback to regex below if Intl.supportedValuesOf is unavailable
  }
  return null;
})();

const GENERIC_VALUES = new Set(['unspecified', 'unknown brand', 'unknown', 'n/a', 'none', 'na', 'null']);

function isValidHttpUrl(stringUrl?: string): boolean {
  if (!stringUrl) return false;
  try {
    const url = new URL(stringUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveProductLink(product: Product): string {
  const offerUrl = product.offers?.[0]?.url;
  const canonicalAttr = product.attributes?.canonicalProductUrl;
  const url = (offerUrl || canonicalAttr || '').trim();
  if (product.attributes?.urlProvenance === 'unavailable_store_domain') {
    return '';
  }
  return url;
}

function resolveVariantPrice(product: Product, variant?: Variant): number | null {
  const variants = product.variants || [];
  if (variant) {
    if (typeof variant.price === 'number' && Number.isFinite(variant.price)) {
      return variant.price;
    }
    // Multi-variant products must never inherit another variant's or top-level offer's price
    if (variants.length > 1) {
      return null;
    }
  }
  if (!variant) {
    const vPrice = variants[0]?.price;
    if (typeof vPrice === 'number' && Number.isFinite(vPrice)) return vPrice;
  }
  const oPrice = product.offers?.[0]?.price;
  if (typeof oPrice === 'number' && Number.isFinite(oPrice)) return oPrice;
  return null;
}

function resolveProductCurrency(product: Product, defaultCurrency = 'USD'): string {
  const firstOffer = product.offers?.[0];
  if (firstOffer && firstOffer.currency !== undefined) {
    return String(firstOffer.currency).trim().toUpperCase();
  }
  return (defaultCurrency || '').trim().toUpperCase();
}

function isValidIsoCurrency(currency: string): boolean {
  if (!/^[A-Z]{3}$/.test(currency)) return false;
  if (SUPPORTED_ISO_CURRENCIES) {
    return SUPPORTED_ISO_CURRENCIES.has(currency);
  }
  return true;
}

/**
 * Resolves explicit stock availability from numeric variant inventory or single-variant offer only.
 * Returns null when availability data is missing rather than fabricating in_stock from status.
 */
function resolveVariantAvailability(
  product: Product,
  variant?: Variant
): 'in_stock' | 'out_of_stock' | 'preorder' | null {
  const variants = product.variants || [];
  if (variant && typeof variant.inventoryCount === 'number' && Number.isFinite(variant.inventoryCount)) {
    return variant.inventoryCount > 0 ? 'in_stock' : 'out_of_stock';
  }

  // Only allow offer-level availability fallback when product has 0 or 1 variants
  if (!variant || variants.length <= 1) {
    const firstOffer = product.offers?.[0];
    if (
      firstOffer?.availability === 'in_stock' ||
      firstOffer?.availability === 'out_of_stock' ||
      firstOffer?.availability === 'preorder'
    ) {
      return firstOffer.availability;
    }
    if (!variant && variants.some((v) => typeof v.inventoryCount === 'number' && Number.isFinite(v.inventoryCount))) {
      return variants.some((v) => (v.inventoryCount ?? 0) > 0) ? 'in_stock' : 'out_of_stock';
    }
  }

  return null;
}

function isGenericOrMissingBrand(brand: string): boolean {
  const lower = brand.trim().toLowerCase();
  return !lower || GENERIC_VALUES.has(lower);
}

const MPN_ATTRIBUTE_KEYS = ['mpn', 'MPN', 'manufacturerPartNumber', 'manufacturer_part_number'] as const;

/**
 * Resolves an authentic Manufacturer Part Number (MPN) solely from explicit MPN attributes.
 * NEVER fabricates or falls back to merchant SKU, variant ID, product ID, or barcode.
 */
export function resolveVariantMpn(product: Product, variant?: Variant): string {
  const variantAttrs = variant?.attributes || {};
  for (const key of MPN_ATTRIBUTE_KEYS) {
    const raw = variantAttrs[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed && !GENERIC_VALUES.has(trimmed.toLowerCase())) {
        return trimmed;
      }
    }
  }

  // Product-level MPN attribute is only safe to apply when there is at most 1 variant,
  // preventing distinct size/color variants from silently sharing a single product-level MPN.
  if (!variant || (product.variants || []).length <= 1) {
    const prodAttrs = product.attributes || {};
    for (const key of MPN_ATTRIBUTE_KEYS) {
      const raw = prodAttrs[key];
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed && !GENERIC_VALUES.has(trimmed.toLowerCase())) {
          return trimmed;
        }
      }
    }
  }

  return '';
}

function isValidMpnFormat(mpn: string): boolean {
  return mpn.length > 0 && mpn.length <= 70 && /^[\x21-\x7E\s]+$/.test(mpn);
}

function resolveOfferCondition(product: Product): 'new' | 'refurbished' | 'used' | '' {
  const raw = (product.offers?.[0]?.condition || '').trim().toLowerCase();
  if (raw === 'new' || raw === 'refurbished' || raw === 'used') {
    return raw;
  }
  return '';
}

function validateVariantsCommon(
  product: Product,
  currency: string,
  errors: FeedValidationError[],
  warnings: FeedValidationError[],
  options: { requireGtinWarning: boolean; priceField: string; gtinField: string; availabilityField: string }
): void {
  const variants = product.variants || [];
  if (variants.length === 0) {
    errors.push({ field: 'sku', message: 'Product has no variants or merchant SKU', severity: 'error' });
    const offerPrice = resolveVariantPrice(product);
    if (offerPrice === null || !Number.isFinite(offerPrice) || offerPrice <= 0) {
      errors.push({ field: options.priceField, message: 'Valid positive price is required', severity: 'error' });
    }
    const avail = resolveVariantAvailability(product);
    if (avail === null) {
      errors.push({
        field: options.availabilityField,
        message: 'Explicit stock availability or inventory count is required',
        severity: 'error',
      });
    }
    if (!isValidIsoCurrency(currency)) {
      errors.push({ field: 'currency', message: 'Valid ISO 4217 3-letter currency code is required', severity: 'error' });
    }
    return;
  }

  if (!isValidIsoCurrency(currency)) {
    errors.push({ field: 'currency', message: 'Valid ISO 4217 3-letter currency code is required', severity: 'error' });
  }

  const seenSkus = new Set<string>();
  const seenVariantIds = new Set<string>();

  for (const variant of variants) {
    const vLabel = variant.id || variant.title || 'unknown';
    if (variant.id) {
      if (seenVariantIds.has(variant.id)) {
        errors.push({
          field: 'variant_id',
          variantId: variant.id,
          message: `Duplicate variant ID "${variant.id}" detected in product "${product.id}"`,
          severity: 'error',
        });
      }
      seenVariantIds.add(variant.id);
    }

    const vSku = (variant.sku || '').trim();
    if (!vSku) {
      errors.push({
        field: 'sku',
        variantId: variant.id,
        message: `Merchant variant SKU is missing (variant: ${vLabel})`,
        severity: 'error',
      });
    } else if (seenSkus.has(vSku.toLowerCase())) {
      errors.push({
        field: 'sku',
        variantId: variant.id,
        message: `Duplicate variant SKU "${vSku}" within product "${product.id}"`,
        severity: 'error',
      });
    } else {
      seenSkus.add(vSku.toLowerCase());
    }

    const vPrice = resolveVariantPrice(product, variant);
    if (vPrice === null || !Number.isFinite(vPrice) || vPrice <= 0) {
      errors.push({
        field: options.priceField,
        variantId: variant.id,
        message: `Valid positive price is required (variant: ${vLabel})`,
        severity: 'error',
      });
    }

    const vAvailability = resolveVariantAvailability(product, variant);
    if (vAvailability === null) {
      errors.push({
        field: options.availabilityField,
        variantId: variant.id,
        message: `Explicit stock availability or numeric inventory count is required (variant: ${vLabel})`,
        severity: 'error',
      });
    }

    const barcode = (variant.barcode || '').trim();
    const mpn = resolveVariantMpn(product, variant);

    if (mpn && !isValidMpnFormat(mpn)) {
      errors.push({
        field: 'mpn',
        variantId: variant.id,
        message: `MPN "${mpn}" exceeds 70 ASCII characters or contains unsupported characters (variant: ${vLabel})`,
        severity: 'error',
      });
    }

    if (!barcode) {
      if (options.requireGtinWarning && !mpn) {
        warnings.push({
          field: options.gtinField,
          variantId: variant.id,
          message: `GTIN/Barcode and MPN missing on variant "${vLabel}". High priority for AI shopping search engines.`,
          severity: 'warning',
        });
      }
    } else if (!isValidGtin13(barcode)) {
      errors.push({
        field: options.gtinField,
        variantId: variant.id,
        message: `Barcode "${barcode}" fails GS1 GTIN check-digit validation (variant: ${vLabel})`,
        severity: 'error',
      });
    }
  }
}

/**
 * Validates a single product (and all of its variants) for Google Merchant Center specifications.
 */
export function validateForGmc(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const currency = resolveProductCurrency(product, defaultCurrency);

  if (!product.id) {
    errors.push({ field: 'id', message: 'Product ID is missing', severity: 'error' });
  }

  if (!product.title || product.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Product title is required', severity: 'error' });
  } else if (product.title.length > 150) {
    warnings.push({ field: 'title', message: 'Title exceeds 150 characters recommended maximum', severity: 'warning' });
  }

  if (!product.description || product.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'Product description is required', severity: 'error' });
  } else if (product.description.length < 30) {
    warnings.push({ field: 'description', message: 'Description is very short (under 30 characters)', severity: 'warning' });
  }

  const link = resolveProductLink(product);
  if (!link || !isValidHttpUrl(link)) {
    errors.push({ field: 'link', message: 'Valid canonical product link URL is required', severity: 'error' });
  }

  const imageLink = (product.image || '').trim();
  if (!imageLink || !isValidHttpUrl(imageLink)) {
    errors.push({ field: 'image_link', message: 'Valid primary image link URL is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  if (isGenericOrMissingBrand(brand)) {
    warnings.push({ field: 'brand', message: 'Brand is missing or generic. Required unless custom-made goods.', severity: 'warning' });
  }

  validateVariantsCommon(product, currency, errors, warnings, {
    requireGtinWarning: true,
    priceField: 'price',
    gtinField: 'gtin',
    availabilityField: 'availability',
  });

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
    variantCount: product.variants?.length || 0,
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product (and all of its variants) for Meta Commerce Catalog specifications.
 */
export function validateForMeta(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const currency = resolveProductCurrency(product, defaultCurrency);

  if (!product.id) {
    errors.push({ field: 'id', message: 'Product ID is missing', severity: 'error' });
  }

  if (!product.title || product.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Title is required', severity: 'error' });
  }

  if (!product.description || product.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'Description is required', severity: 'error' });
  }

  const link = resolveProductLink(product);
  if (!link || !isValidHttpUrl(link)) {
    errors.push({ field: 'link', message: 'Valid product URL is required', severity: 'error' });
  }

  const imageLink = (product.image || '').trim();
  if (!imageLink || !isValidHttpUrl(imageLink)) {
    errors.push({ field: 'image_link', message: 'Valid image URL is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  if (isGenericOrMissingBrand(brand)) {
    errors.push({ field: 'brand', message: 'Authentic brand name is required for Meta Commerce Catalog', severity: 'error' });
  }

  if (!resolveOfferCondition(product)) {
    warnings.push({ field: 'condition', message: 'Explicit product condition (new, refurbished, used) recommended for Meta Commerce', severity: 'warning' });
  }

  validateVariantsCommon(product, currency, errors, warnings, {
    requireGtinWarning: false,
    priceField: 'price',
    gtinField: 'gtin',
    availabilityField: 'availability',
  });

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
    variantCount: product.variants?.length || 0,
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product (and all of its variants) for Schema.org Product (JSON-LD) structured data.
 */
export function validateForSchemaOrg(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const currency = resolveProductCurrency(product, defaultCurrency);

  if (!product.title || product.title.trim().length === 0) {
    errors.push({ field: 'name', message: 'Schema.org name is required', severity: 'error' });
  }

  if (!product.description || product.description.trim().length === 0) {
    warnings.push({ field: 'description', message: 'Schema.org description recommended for rich snippets', severity: 'warning' });
  }

  const link = resolveProductLink(product);
  if (!link || !isValidHttpUrl(link)) {
    errors.push({ field: 'offers.url', message: 'Valid canonical offer URL is required', severity: 'error' });
  }

  const imageLink = (product.image || '').trim();
  if (!imageLink || !isValidHttpUrl(imageLink)) {
    warnings.push({ field: 'image', message: 'Image URL recommended for visual AI search cards', severity: 'warning' });
  }

  validateVariantsCommon(product, currency, errors, warnings, {
    requireGtinWarning: false,
    priceField: 'offers.price',
    gtinField: 'gtin13',
    availabilityField: 'offers.availability',
  });

  // Map currency error field to offers.priceCurrency for Schema.org backwards compatibility
  for (const err of errors) {
    if (err.field === 'currency') {
      err.field = 'offers.priceCurrency';
    }
  }

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
    variantCount: product.variants?.length || 0,
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Evaluates full catalog readiness for a given platform.
 */
export function evaluateFeedReadiness(
  products: Product[],
  platform: FeedPlatform,
  defaultCurrency = 'USD'
): FeedReadinessReport {
  const evaluations: ProductFeedEvaluation[] = [];
  const summaryErrors: Record<string, number> = {};

  for (const product of products) {
    let evalResult: ProductFeedEvaluation;
    if (platform === 'google_merchant_center') {
      evalResult = validateForGmc(product, defaultCurrency);
    } else if (platform === 'meta_commerce') {
      evalResult = validateForMeta(product, defaultCurrency);
    } else {
      evalResult = validateForSchemaOrg(product, defaultCurrency);
    }

    evaluations.push(evalResult);

    for (const err of evalResult.errors) {
      summaryErrors[err.field] = (summaryErrors[err.field] || 0) + 1;
    }
  }

  const validProductsCount = evaluations.filter((e) => e.isValid).length;
  const invalidProductsCount = evaluations.length - validProductsCount;
  const readinessScore = evaluations.length > 0
    ? Math.round((validProductsCount / evaluations.length) * 100)
    : 0;

  return {
    platform,
    totalProducts: evaluations.length,
    validProductsCount,
    invalidProductsCount,
    readinessScore,
    evaluatedAt: new Date().toISOString(),
    validationScope: 'local_structural_check_only',
    externalPlatformAccepted: false,
    limitationsNotice:
      'Local structural validation only. Passing these checks does not verify approval or acceptance by Google Merchant Center, Meta Commerce, or external search platforms.',
    evaluations,
    summaryErrors,
  };
}

/**
 * Maps product (or a specific variant) to a Google Merchant Center CSV row without fabricating identifiers.
 * Keeps SKU and MPN strictly separate; never derives MPN from SKU or product/variant IDs.
 */
export function mapProductToGmcRow(
  product: Product,
  currency: string = 'USD',
  variant?: Variant
): GmcFeedRow {
  const targetVariant = variant || product.variants?.[0];
  const isMultiVariant = (product.variants || []).length > 1;
  const price = resolveVariantPrice(product, targetVariant);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const cleanBrand = isGenericOrMissingBrand(brand) ? '' : brand;

  const rawBarcode = (targetVariant?.barcode || '').trim();
  const validGtin = rawBarcode && isValidGtin13(rawBarcode) ? rawBarcode : undefined;
  const sku = (targetVariant?.sku || '').trim();
  const mpn = resolveVariantMpn(product, targetVariant);
  const validMpn = mpn && isValidMpnFormat(mpn) ? mpn : undefined;

  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const availability = resolveVariantAvailability(product, targetVariant) || '';

  const baseTitle = (product.title || '').trim();
  const variantTitle = (targetVariant?.title || '').trim();
  const fullTitle =
    isMultiVariant && variantTitle && variantTitle.toLowerCase() !== 'default title'
      ? `${baseTitle} - ${variantTitle}`
      : baseTitle;

  const hasValidIdentifier = Boolean(validGtin || validMpn);

  return {
    id: isMultiVariant && targetVariant?.id ? targetVariant.id : product.id,
    title: fullTitle,
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    link: isValidHttpUrl(link) ? link : '',
    image_link: isValidHttpUrl(imageLink) ? imageLink : '',
    availability,
    price:
      price !== null && Number.isFinite(price) && price > 0 && isValidIsoCurrency(effectiveCurrency)
        ? `${Number(price).toFixed(2)} ${effectiveCurrency}`
        : '',
    brand: cleanBrand,
    sku: sku || undefined,
    gtin: validGtin,
    mpn: validMpn,
    identifier_exists: cleanBrand && hasValidIdentifier ? 'yes' : 'no',
    item_group_id: product.id,
  };
}

/**
 * Expands a product into deterministic deduplicated GMC rows (one per unique variant).
 */
export function mapProductVariantsToGmcRows(product: Product, currency: string = 'USD'): GmcFeedRow[] {
  const variants = product.variants || [];
  if (variants.length === 0) {
    return [mapProductToGmcRow(product, currency)];
  }
  const seenIds = new Set<string>();
  const rows: GmcFeedRow[] = [];
  for (const variant of variants) {
    const dedupeKey = variant.id || `${product.id}_${rows.length}`;
    if (seenIds.has(dedupeKey)) continue;
    seenIds.add(dedupeKey);
    rows.push(mapProductToGmcRow(product, currency, variant));
  }
  return rows;
}

/**
 * Maps product (or a specific variant) to Meta Commerce CSV row object without fabricating missing values.
 */
export function mapProductToMetaRow(
  product: Product,
  currency: string = 'USD',
  variant?: Variant
): MetaFeedRow {
  const targetVariant = variant || product.variants?.[0];
  const isMultiVariant = (product.variants || []).length > 1;
  const price = resolveVariantPrice(product, targetVariant);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const rawAvailability = resolveVariantAvailability(product, targetVariant);
  const availability: MetaFeedRow['availability'] =
    rawAvailability === 'in_stock'
      ? 'in stock'
      : rawAvailability === 'out_of_stock'
        ? 'out of stock'
        : rawAvailability === 'preorder'
          ? 'available for order'
          : '';

  const sku = (targetVariant?.sku || '').trim();
  const rawBarcode = (targetVariant?.barcode || '').trim();
  const validGtin = rawBarcode && isValidGtin13(rawBarcode) ? rawBarcode : undefined;
  const mpn = resolveVariantMpn(product, targetVariant);
  const validMpn = mpn && isValidMpnFormat(mpn) ? mpn : undefined;

  const baseTitle = (product.title || '').trim();
  const variantTitle = (targetVariant?.title || '').trim();
  const fullTitle =
    isMultiVariant && variantTitle && variantTitle.toLowerCase() !== 'default title'
      ? `${baseTitle} - ${variantTitle}`
      : baseTitle;

  return {
    id: isMultiVariant && targetVariant?.id ? targetVariant.id : product.id,
    title: fullTitle,
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    availability,
    condition: resolveOfferCondition(product),
    price:
      price !== null && Number.isFinite(price) && price > 0 && isValidIsoCurrency(effectiveCurrency)
        ? `${Number(price).toFixed(2)} ${effectiveCurrency}`
        : '',
    link: isValidHttpUrl(link) ? link : '',
    image_link: isValidHttpUrl(imageLink) ? imageLink : '',
    brand: isGenericOrMissingBrand(brand) ? '' : brand,
    sku: sku || undefined,
    gtin: validGtin,
    mpn: validMpn,
    item_group_id: product.id,
  };
}

/**
 * Expands a product into deterministic deduplicated Meta Commerce rows (one per unique variant).
 */
export function mapProductVariantsToMetaRows(product: Product, currency: string = 'USD'): MetaFeedRow[] {
  const variants = product.variants || [];
  if (variants.length === 0) {
    return [mapProductToMetaRow(product, currency)];
  }
  const seenIds = new Set<string>();
  const rows: MetaFeedRow[] = [];
  for (const variant of variants) {
    const dedupeKey = variant.id || `${product.id}_${rows.length}`;
    if (seenIds.has(dedupeKey)) continue;
    seenIds.add(dedupeKey);
    rows.push(mapProductToMetaRow(product, currency, variant));
  }
  return rows;
}

/**
 * Maps product to Schema.org JSON-LD object without fabricating missing prices, SKUs, MPNs, or availability.
 */
export function mapProductToSchemaOrgJsonLd(product: Product, currency: string = 'USD'): SchemaOrgProductJsonLd {
  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const gtin = (mainVariant?.barcode || '').trim();
  const mpn = resolveVariantMpn(product, mainVariant);
  const price = resolveVariantPrice(product, mainVariant);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const rawAvailability = resolveVariantAvailability(product, mainVariant);

  const result: SchemaOrgProductJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: (product.title || '').trim(),
    description: (product.description || '').trim(),
  };

  if (sku) {
    result.sku = sku;
  }

  if (mpn && isValidMpnFormat(mpn)) {
    result.mpn = mpn;
  }

  if (gtin && isValidGtin13(gtin)) {
    result.gtin13 = gtin;
  }

  if (isValidHttpUrl(imageLink)) {
    result.image = imageLink;
  }

  if (!isGenericOrMissingBrand(brand)) {
    result.brand = {
      '@type': 'Brand',
      name: brand,
    };
  }

  const offer: SchemaOrgProductJsonLd['offers'] = {
    '@type': 'Offer',
  };
  let hasOfferField = false;

  if (price !== null && Number.isFinite(price) && price > 0) {
    offer.price = Number(price).toFixed(2);
    hasOfferField = true;
  }
  if (isValidIsoCurrency(effectiveCurrency)) {
    offer.priceCurrency = effectiveCurrency;
    hasOfferField = true;
  }
  if (rawAvailability) {
    offer.availability =
      rawAvailability === 'in_stock'
        ? 'https://schema.org/InStock'
        : rawAvailability === 'preorder'
          ? 'https://schema.org/PreOrder'
          : 'https://schema.org/OutOfStock';
    hasOfferField = true;
  }
  if (isValidHttpUrl(link)) {
    offer.url = link;
    hasOfferField = true;
  }
  const condition = resolveOfferCondition(product);
  if (condition === 'new') {
    offer.itemCondition = 'https://schema.org/NewCondition';
    hasOfferField = true;
  } else if (condition === 'refurbished') {
    offer.itemCondition = 'https://schema.org/RefurbishedCondition';
    hasOfferField = true;
  } else if (condition === 'used') {
    offer.itemCondition = 'https://schema.org/UsedCondition';
    hasOfferField = true;
  }

  if (hasOfferField) {
    result.offers = offer;
  }

  return result;
}

const FORMULA_INJECTION_REGEX = /^[\t\r ]*[=+\-@]|^[\t\r]/;

/**
 * Neutralizes spreadsheet formula injection (OWASP CSV injection prevention)
 * by prefixing leading =, +, -, @, tab, or CR characters with a single quote.
 */
export function sanitizeCsvCell(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (FORMULA_INJECTION_REGEX.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Converts array of flat objects to CSV string with formula injection protection.
 * Preserves a deterministic union of headers across all rows so optional fields on later rows are never dropped.
 */
export function exportToCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const headers: string[] = [];
  const headerSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headerSet.has(key)) {
        headerSet.add(key);
        headers.push(key);
      }
    }
  }

  const escapeCsv = (val: any) => {
    const safe = sanitizeCsvCell(val).replace(/"/g, '""');
    return `"${safe}"`;
  };

  const headerRow = headers.map(escapeCsv).join(',');
  const dataRows = rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return [headerRow, ...dataRows].join('\n');
}
