import { Product } from '../../types';

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
  evaluations: ProductFeedEvaluation[];
  summaryErrors: Record<string, number>;
}

export interface GmcFeedRow {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder';
  price: string; // e.g. "29.99 USD"
  brand: string;
  gtin?: string;
  mpn?: string;
  identifier_exists: 'yes' | 'no';
  item_group_id?: string;
}

export interface MetaFeedRow {
  id: string;
  title: string;
  description: string;
  availability: 'in stock' | 'out of stock' | 'available for order';
  condition: 'new' | 'refurbished' | 'used';
  price: string; // e.g. "29.99 USD"
  link: string;
  image_link: string;
  brand: string;
  item_group_id?: string;
  fb_product_category?: string;
}

export interface SchemaOrgProductJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Product';
  name: string;
  description: string;
  image?: string;
  sku: string;
  brand?: {
    '@type': 'Brand';
    name: string;
  };
  offers: {
    '@type': 'Offer';
    price: number | string;
    priceCurrency: string;
    availability: string;
    url: string;
    itemCondition?: string;
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
  return (offerUrl || canonicalAttr || '').trim();
}

function resolveProductPrice(product: Product): number | null {
  const vPrice = product.variants?.[0]?.price;
  if (typeof vPrice === 'number' && !isNaN(vPrice)) return vPrice;
  const oPrice = product.offers?.[0]?.price;
  if (typeof oPrice === 'number' && !isNaN(oPrice)) return oPrice;
  return null;
}

function resolveProductAvailability(product: Product): boolean {
  const firstOffer = product.offers?.[0];
  if (firstOffer?.availability) {
    return firstOffer.availability === 'in_stock';
  }
  const variants = product.variants || [];
  if (variants.some((v) => typeof v.inventoryCount === 'number')) {
    return variants.some((v) => (v.inventoryCount ?? 0) > 0);
  }
  return product.status === 'active';
}

/**
 * Validates a single product for Google Merchant Center specifications.
 */
export function validateForGmc(product: Product): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product);

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

  if (price === null || price <= 0) {
    errors.push({ field: 'price', message: 'Valid positive price is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  const barcode = (mainVariant?.barcode || '').trim();
  if (!brand || brand.toLowerCase() === 'unspecified' || brand.toLowerCase() === 'unknown brand') {
    warnings.push({ field: 'brand', message: 'Brand is missing or generic. Required unless custom-made goods.', severity: 'warning' });
  }

  if (!barcode) {
    warnings.push({ field: 'gtin', message: 'GTIN/Barcode missing. High priority for AI shopping search engines.', severity: 'warning' });
  }

  return {
    productId: product.id,
    sku: mainVariant?.sku || product.id,
    title: product.title || 'Untitled Product',
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product for Meta Commerce Catalog specifications.
 */
export function validateForMeta(product: Product): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product);

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

  if (price === null || price <= 0) {
    errors.push({ field: 'price', message: 'Valid positive price is required', severity: 'error' });
  }

  const brand = (product.brand || '').trim();
  if (!brand || brand.toLowerCase() === 'unspecified' || brand.toLowerCase() === 'unknown brand') {
    warnings.push({ field: 'brand', message: 'Brand name is recommended for Meta Commerce', severity: 'warning' });
  }

  return {
    productId: product.id,
    sku: mainVariant?.sku || product.id,
    title: product.title || 'Untitled Product',
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a single product for Schema.org Product (JSON-LD) structured data.
 */
export function validateForSchemaOrg(product: Product): ProductFeedEvaluation {
  const errors: FeedValidationError[] = [];
  const warnings: FeedValidationError[] = [];

  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product);

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

  if (price === null || price <= 0) {
    errors.push({ field: 'offers.price', message: 'Valid offer price is required', severity: 'error' });
  }

  const imageLink = (product.image || '').trim();
  if (!imageLink || !isValidHttpUrl(imageLink)) {
    warnings.push({ field: 'image', message: 'Image URL recommended for visual AI search cards', severity: 'warning' });
  }

  return {
    productId: product.id,
    sku: mainVariant?.sku || product.id,
    title: product.title || 'Untitled Product',
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Evaluates full catalog readiness for a given platform.
 */
export function evaluateFeedReadiness(products: Product[], platform: FeedPlatform): FeedReadinessReport {
  const evaluations: ProductFeedEvaluation[] = [];
  const summaryErrors: Record<string, number> = {};

  for (const product of products) {
    let evalResult: ProductFeedEvaluation;
    if (platform === 'google_merchant_center') {
      evalResult = validateForGmc(product);
    } else if (platform === 'meta_commerce') {
      evalResult = validateForMeta(product);
    } else {
      evalResult = validateForSchemaOrg(product);
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
    evaluations,
    summaryErrors,
  };
}

/**
 * Maps product to Google Merchant Center CSV row object
 */
export function mapProductToGmcRow(product: Product, currency: string = 'USD'): GmcFeedRow {
  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product) ?? 0;
  const brand = (product.brand || '').trim();
  const gtin = (mainVariant?.barcode || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();

  const inStock = resolveProductAvailability(product);
  const availability: GmcFeedRow['availability'] = inStock ? 'in_stock' : 'out_of_stock';

  return {
    id: product.id,
    title: product.title || '',
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    link,
    image_link: imageLink,
    availability,
    price: `${Number(price).toFixed(2)} ${product.offers?.[0]?.currency || currency}`,
    brand,
    gtin: gtin || undefined,
    mpn: mainVariant?.sku || undefined,
    identifier_exists: brand && gtin ? 'yes' : 'no',
    item_group_id: product.id,
  };
}

/**
 * Maps product to Meta Commerce CSV row object
 */
export function mapProductToMetaRow(product: Product, currency: string = 'USD'): MetaFeedRow {
  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product) ?? 0;
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();

  const inStock = resolveProductAvailability(product);
  const availability: MetaFeedRow['availability'] = inStock ? 'in stock' : 'out of stock';

  return {
    id: product.id,
    title: product.title || '',
    description: (product.description || '').replace(/[\r\n]+/g, ' ').trim(),
    availability,
    condition: product.offers?.[0]?.condition || 'new',
    price: `${Number(price).toFixed(2)} ${product.offers?.[0]?.currency || currency}`,
    link,
    image_link: imageLink,
    brand,
    item_group_id: product.id,
  };
}

/**
 * Maps product to Schema.org JSON-LD object
 */
export function mapProductToSchemaOrgJsonLd(product: Product, currency: string = 'USD'): SchemaOrgProductJsonLd {
  const mainVariant = product.variants?.[0];
  const price = resolveProductPrice(product) ?? 0;
  const brand = (product.brand || '').trim();
  const link = resolveProductLink(product);
  const imageLink = (product.image || '').trim();

  const inStock = resolveProductAvailability(product);
  const availabilityUrl = inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';

  const result: SchemaOrgProductJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title || '',
    description: product.description || '',
    sku: mainVariant?.sku || product.id,
    offers: {
      '@type': 'Offer',
      price: Number(price).toFixed(2),
      priceCurrency: product.offers?.[0]?.currency || currency,
      availability: availabilityUrl,
      url: link,
      itemCondition: 'https://schema.org/NewCondition',
    },
  };

  if (imageLink) {
    result.image = imageLink;
  }

  if (brand) {
    result.brand = {
      '@type': 'Brand',
      name: brand,
    };
  }

  return result;
}

/**
 * Converts array of flat objects to CSV string
 */
export function exportToCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerRow = headers.map(escapeCsv).join(',');
  const dataRows = rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return [headerRow, ...dataRows].join('\n');
}
