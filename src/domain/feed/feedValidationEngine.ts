import { Product } from '../../types';
import { isValidGtin13 } from '../validation/gtin';

export type FeedPlatform = 'google_merchant_center' | 'meta_commerce' | 'schema_org';

export interface FeedValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ProductFeedEvaluation {
  productId: string;
  sku: string;
  title: string;
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

function resolveProductPrice(product: Product): number | null {
  const vPrice = product.variants?.[0]?.price;
  if (typeof vPrice === 'number' && !isNaN(vPrice)) return vPrice;
  const oPrice = product.offers?.[0]?.price;
  if (typeof oPrice === 'number' && !isNaN(oPrice)) return oPrice;
  return null;
}

function resolveProductCurrency(product: Product, defaultCurrency = 'USD'): string {
  return (product.offers?.[0]?.currency || defaultCurrency || '').trim().toUpperCase();
}

function isValidIsoCurrency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

/**
 * Resolves explicit stock availability from offer or numeric variant inventory only.
 * Returns null when availability data is missing rather than fabricating in_stock from status.
 */
function resolveProductAvailability(product: Product): 'in_stock' | 'out_of_stock' | null {
  const firstOffer = product.offers?.[0];
  if (firstOffer?.availability === 'in_stock' || firstOffer?.availability === 'out_of_stock') {
    return firstOffer.availability;
  }
  const variants = product.variants || [];
  if (variants.some((v) => typeof v.inventoryCount === 'number' && !isNaN(v.inventoryCount))) {
    return variants.some((v) => (v.inventoryCount ?? 0) > 0) ? 'in_stock' : 'out_of_stock';
  }
  return null;
}

function isGenericOrMissingBrand(brand: string): boolean {
  const lower = brand.trim().toLowerCase();
  return !lower || lower === 'unspecified' || lower === 'unknown brand' || lower === 'n/a' || lower === 'none';
}

/**
 * Validates a single product for Google Merchant Center specifications.
 */
export function validateForGmc(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const price = resolveProductPrice(product);
  const currency = resolveProductCurrency(product, defaultCurrency);
  const availability = resolveProductAvailability(product);

  if (!product.id) {
    errors.push({ field: 'id', message: 'Product ID is missing', severity: 'error' });
  }

  if (!sku) {
    errors.push({ field: 'sku', message: 'Merchant variant SKU is missing', severity: 'error' });
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

  if (price === null || price <= 0) {
    errors.push({ field: 'price', message: 'Valid positive price is required', severity: 'error' });
  }

  if (!isValidIsoCurrency(currency)) {
    errors.push({ field: 'currency', message: 'Valid ISO 4217 3-letter currency code is required', severity: 'error' });
  }

  if (availability === null) {
    errors.push({ field: 'availability', message: 'Explicit stock availability or inventory count is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  const barcode = (mainVariant?.barcode || '').trim();
  if (isGenericOrMissingBrand(brand)) {
    warnings.push({ field: 'brand', message: 'Brand is missing or generic. Required unless custom-made goods.', severity: 'warning' });
  }

  if (!barcode) {
    warnings.push({ field: 'gtin', message: 'GTIN/Barcode missing. High priority for AI shopping search engines.', severity: 'warning' });
  } else if (!isValidGtin13(barcode)) {
    errors.push({ field: 'gtin', message: `Barcode "${barcode}" fails GS1 GTIN check-digit validation`, severity: 'error' });
  }

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product for Meta Commerce Catalog specifications.
 */
export function validateForMeta(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const price = resolveProductPrice(product);
  const currency = resolveProductCurrency(product, defaultCurrency);
  const availability = resolveProductAvailability(product);

  if (!product.id) {
    errors.push({ field: 'id', message: 'Product ID is missing', severity: 'error' });
  }

  if (!sku) {
    errors.push({ field: 'sku', message: 'Merchant variant SKU is missing', severity: 'error' });
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

  if (price === null || price <= 0) {
    errors.push({ field: 'price', message: 'Valid positive price is required', severity: 'error' });
  }

  if (!isValidIsoCurrency(currency)) {
    errors.push({ field: 'currency', message: 'Valid ISO 4217 3-letter currency code is required', severity: 'error' });
  }

  if (availability === null) {
    errors.push({ field: 'availability', message: 'Explicit stock availability or inventory count is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  if (isGenericOrMissingBrand(brand)) {
    errors.push({ field: 'brand', message: 'Authentic brand name is required for Meta Commerce Catalog', severity: 'error' });
  }

  const barcode = (mainVariant?.barcode || '').trim();
  if (barcode && !isValidGtin13(barcode)) {
    errors.push({ field: 'gtin', message: `Barcode "${barcode}" fails GS1 GTIN check-digit validation`, severity: 'error' });
  }

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product for Schema.org Product (JSON-LD) structured data.
 */
export function validateForSchemaOrg(product: Product, defaultCurrency = 'USD'): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const price = resolveProductPrice(product);
  const currency = resolveProductCurrency(product, defaultCurrency);
  const availability = resolveProductAvailability(product);

  if (!product.title || product.title.trim().length === 0) {
    errors.push({ field: 'name', message: 'Schema.org name is required', severity: 'error' });
  }

  if (!sku) {
    errors.push({ field: 'sku', message: 'Merchant variant SKU is missing', severity: 'error' });
  }

  if (!product.description || product.description.trim().length === 0) {
    warnings.push({ field: 'description', message: 'Schema.org description recommended for rich snippets', severity: 'warning' });
  }

  const link = resolveProductLink(product);
  if (!link || !isValidHttpUrl(link)) {
    errors.push({ field: 'offers.url', message: 'Valid canonical offer URL is required', severity: 'error' });
  }

  if (price === null || price <= 0) {
    errors.push({ field: 'offers.price', message: 'Valid positive offer price is required', severity: 'error' });
  }

  if (!isValidIsoCurrency(currency)) {
    errors.push({ field: 'offers.priceCurrency', message: 'Valid ISO 4217 currency code is required', severity: 'error' });
  }

  if (availability === null) {
    errors.push({ field: 'offers.availability', message: 'Explicit stock availability is required for Schema.org Offer', severity: 'error' });
  }

  const barcode = (mainVariant?.barcode || '').trim();
  if (barcode && !isValidGtin13(barcode)) {
    errors.push({ field: 'gtin13', message: `Barcode "${barcode}" fails GS1 GTIN check-digit validation`, severity: 'error' });
  }

  const imageLink = (product.image || '').trim();
  if (!imageLink || !isValidHttpUrl(imageLink)) {
    warnings.push({ field: 'image', message: 'Image URL recommended for visual AI search cards', severity: 'warning' });
  }

  return {
    productId: product.id,
    sku,
    title: product.title || 'Untitled Product',
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
 * Maps product to Google Merchant Center CSV row object without fabricating missing values.
 */
export function mapProductToGmcRow(product: Product, currency: string = 'USD'): GmcFeedRow {
  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const gtin = (mainVariant?.barcode || '').trim();
  const sku = (mainVariant?.sku || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const availability = resolveProductAvailability(product) || '';

  return {
    id: product.id,
    title: (product.title || '').trim(),
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    link: isValidHttpUrl(link) ? link : '',
    image_link: isValidHttpUrl(imageLink) ? imageLink : '',
    availability,
    price: price !== null && price > 0 && effectiveCurrency ? `${Number(price).toFixed(2)} ${effectiveCurrency}` : '',
    brand: isGenericOrMissingBrand(brand) ? '' : brand,
    gtin: gtin || undefined,
    mpn: sku || undefined,
    identifier_exists: !isGenericOrMissingBrand(brand) && (Boolean(gtin) || Boolean(sku)) ? 'yes' : 'no',
    item_group_id: product.id,
  };
}

/**
 * Maps product to Meta Commerce CSV row object without fabricating missing values.
 */
export function mapProductToMetaRow(product: Product, currency: string = 'USD'): MetaFeedRow {
  const price = resolveProductPrice(product);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const rawAvailability = resolveProductAvailability(product);
  const availability: MetaFeedRow['availability'] =
    rawAvailability === 'in_stock' ? 'in stock' : rawAvailability === 'out_of_stock' ? 'out of stock' : '';

  return {
    id: product.id,
    title: (product.title || '').trim(),
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    availability,
    condition: product.offers?.[0]?.condition || '',
    price: price !== null && price > 0 && effectiveCurrency ? `${Number(price).toFixed(2)} ${effectiveCurrency}` : '',
    link: isValidHttpUrl(link) ? link : '',
    image_link: isValidHttpUrl(imageLink) ? imageLink : '',
    brand: isGenericOrMissingBrand(brand) ? '' : brand,
    item_group_id: product.id,
  };
}

/**
 * Maps product to Schema.org JSON-LD object without fabricating missing prices, SKUs, or availability.
 */
export function mapProductToSchemaOrgJsonLd(product: Product, currency: string = 'USD'): SchemaOrgProductJsonLd {
  const mainVariant = product.variants?.[0];
  const sku = (mainVariant?.sku || '').trim();
  const gtin = (mainVariant?.barcode || '').trim();
  const price = resolveProductPrice(product);
  const effectiveCurrency = resolveProductCurrency(product, currency);
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();
  const rawAvailability = resolveProductAvailability(product);

  const result: SchemaOrgProductJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: (product.title || '').trim(),
    description: (product.description || '').trim(),
  };

  if (sku) {
    result.sku = sku;
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

  if (price !== null && price > 0) {
    offer.price = Number(price).toFixed(2);
    hasOfferField = true;
  }
  if (effectiveCurrency) {
    offer.priceCurrency = effectiveCurrency;
    hasOfferField = true;
  }
  if (rawAvailability) {
    offer.availability =
      rawAvailability === 'in_stock' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
    hasOfferField = true;
  }
  if (isValidHttpUrl(link)) {
    offer.url = link;
    hasOfferField = true;
  }
  if (product.offers?.[0]?.condition === 'new') {
    offer.itemCondition = 'https://schema.org/NewCondition';
    hasOfferField = true;
  } else if (product.offers?.[0]?.condition === 'refurbished') {
    offer.itemCondition = 'https://schema.org/RefurbishedCondition';
    hasOfferField = true;
  } else if (product.offers?.[0]?.condition === 'used') {
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
 */
export function exportToCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escapeCsv = (val: any) => {
    const safe = sanitizeCsvCell(val).replace(/"/g, '""');
    return `"${safe}"`;
  };

  const headerRow = headers.map(escapeCsv).join(',');
  const dataRows = rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return [headerRow, ...dataRows].join('\n');
}
