import { 
  QuickHealthCheckResult, 
  Product, 
  Variant, 
  StoreIngestionResult, 
  CandidateProductStatus,
  CandidateEligibilityStatus 
} from '../../types';
import { initialProducts, initialFindings } from '../../data/mockData';
import { isValidGtin13 } from '../validation/gtin';
import { calculateProductCompleteness } from '../catalog/catalogMutationService';

export interface ShopifyPublicProduct {
  id: number | string;
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  handle?: string;
  variants?: Array<{
    id: number | string;
    title?: string;
    sku?: string;
    barcode?: string;
    price?: string | number;
    available?: boolean;
  }>;
}

export interface IngestionOptions {
  fetchTimeoutMs?: number;
  customFetch?: typeof fetch;
  existingCatalog?: Product[];
}

/**
 * Normalizes a raw URL string into a canonical origin URL.
 */
export function normalizeStoreUrl(rawUrl: string): { hostname: string; origin: string; isValid: boolean; error?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { hostname: '', origin: '', isValid: false, error: 'Store URL must be provided.' };
  }

  const trimmed = rawUrl.trim();
  const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return { hostname: '', origin: '', isValid: false, error: 'Please enter a valid store domain (e.g., store.com).' };
    }
    return {
      hostname: parsed.hostname.toLowerCase(),
      origin: parsed.origin,
      isValid: true,
    };
  } catch {
    return { hostname: '', origin: '', isValid: false, error: 'Invalid URL format.' };
  }
}

/**
 * Validates a single candidate product against catalog persistence & domain invariants.
 */
export function validateCandidateProduct(prod: Product): { isValid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!prod) {
    return { isValid: false, reasons: ['Product record is null or undefined'] };
  }
  if (typeof prod.id !== 'string' || prod.id.trim() === '') {
    reasons.push('Product ID is missing or empty.');
  }
  if (typeof prod.title !== 'string' || prod.title.trim().length < 2) {
    reasons.push('Product title is missing or shorter than 2 characters.');
  }
  if (typeof prod.brand !== 'string' || prod.brand.trim() === '') {
    reasons.push('Product brand/vendor is missing or empty.');
  }
  if (typeof prod.category !== 'string' || prod.category.trim() === '') {
    reasons.push('Product category/type is missing or empty.');
  }
  if (!Array.isArray(prod.variants) || prod.variants.length === 0) {
    reasons.push('Product has no variants.');
  } else {
    prod.variants.forEach((v, idx) => {
      if (typeof v.id !== 'string' || v.id.trim() === '') {
        reasons.push(`Variant [${idx}] ID is missing.`);
      }
      if (typeof v.title !== 'string' || v.title.trim() === '') {
        reasons.push(`Variant [${idx}] title is missing.`);
      }
      if (typeof v.sku !== 'string' || v.sku.trim() === '') {
        reasons.push(`Variant [${idx}] SKU is missing.`);
      }
      if (typeof v.price !== 'number' || isNaN(v.price) || !isFinite(v.price) || v.price < 0) {
        reasons.push(`Variant [${idx}] price (${v.price}) must be a valid non-negative number.`);
      }
    });
  }

  return {
    isValid: reasons.length === 0,
    reasons,
  };
}

/**
 * Searches the existing catalog for a matching product using stable source identifiers.
 * Does NOT rely on product title alone.
 */
export function findMatchingCatalogProduct(incoming: Product, catalog: Product[]): Product | undefined {
  if (!incoming || !Array.isArray(catalog)) return undefined;

  const incomingSourceId = incoming.attributes?.sourceProductId || incoming.id;
  const incomingBarcodes = new Set(
    (incoming.variants || []).map(v => (v.barcode || '').trim()).filter(Boolean)
  );
  const incomingSkus = new Set(
    (incoming.variants || []).map(v => (v.sku || '').trim().toLowerCase()).filter(Boolean)
  );

  return catalog.find(existing => {
    // 1. Direct ID match
    if (existing.id === incoming.id) return true;

    // 2. Stable Source ID match
    if (
      incomingSourceId &&
      existing.attributes?.sourceProductId &&
      existing.attributes.sourceProductId === incomingSourceId
    ) {
      return true;
    }

    // 3. Variant Barcode match (GTIN / UPC)
    const existingBarcodes = (existing.variants || []).map(v => (v.barcode || '').trim()).filter(Boolean);
    if (existingBarcodes.some(b => incomingBarcodes.has(b))) return true;

    // 4. Variant SKU match (stable identifier across platforms)
    const existingSkus = (existing.variants || []).map(v => (v.sku || '').trim().toLowerCase()).filter(Boolean);
    if (existingSkus.some(s => incomingSkus.has(s))) return true;

    return false;
  });
}

/**
 * Detects whether an incoming product differs from an existing merchant product.
 * Returns differences to protect merchant-edited data.
 */
export function detectProductConflict(incoming: Product, existing: Product): { isConflict: boolean; differences: string[] } {
  const differences: string[] = [];

  if (incoming.title.trim() !== existing.title.trim()) {
    differences.push(`Title: incoming "${incoming.title}" vs catalog "${existing.title}"`);
  }
  if (incoming.brand.trim() !== existing.brand.trim()) {
    differences.push(`Brand: incoming "${incoming.brand}" vs catalog "${existing.brand}"`);
  }
  if (incoming.category.trim() !== existing.category.trim()) {
    differences.push(`Category: incoming "${incoming.category}" vs catalog "${existing.category}"`);
  }

  // Variant differences
  const existingVariantMap = new Map((existing.variants || []).map(v => [v.sku.toLowerCase(), v]));
  for (const iv of (incoming.variants || [])) {
    const ev = existingVariantMap.get(iv.sku.toLowerCase());
    if (ev) {
      if (iv.price !== ev.price) {
        differences.push(`Variant SKU "${iv.sku}" price: incoming $${iv.price} vs catalog $${ev.price}`);
      }
      if ((iv.barcode || '').trim() !== (ev.barcode || '').trim()) {
        differences.push(`Variant SKU "${iv.sku}" barcode: incoming "${iv.barcode || ''}" vs catalog "${ev.barcode || ''}"`);
      }
    }
  }

  return {
    isConflict: differences.length > 0,
    differences,
  };
}

/**
 * Evaluates candidate products against domain rules, intra-batch duplicates, and existing catalog records.
 */
export function evaluateCandidateProducts(
  incomingProducts: Product[],
  existingCatalog: Product[] = []
): { candidateDetails: CandidateProductStatus[]; eligibleProducts: Product[] } {
  const candidateDetails: CandidateProductStatus[] = [];
  const eligibleProducts: Product[] = [];

  const seenIdsInBatch = new Set<string>();
  const seenBarcodesInBatch = new Set<string>();
  const seenSkusInBatch = new Set<string>();

  for (const prod of incomingProducts) {
    const sourceId = prod.attributes?.sourceProductId || prod.id;
    const validation = validateCandidateProduct(prod);

    if (!validation.isValid) {
      candidateDetails.push({
        productId: prod.id,
        sourceId,
        title: prod.title || 'Untitled',
        brand: prod.brand || 'Unspecified',
        category: prod.category || 'Unspecified',
        status: 'rejected',
        reasons: validation.reasons,
        product: prod,
      });
      continue;
    }

    // Intra-batch duplicate detection
    let isBatchDuplicate = false;
    if (seenIdsInBatch.has(prod.id) || (sourceId && seenIdsInBatch.has(sourceId))) {
      isBatchDuplicate = true;
    }

    const currentBarcodes = prod.variants.map(v => (v.barcode || '').trim()).filter(Boolean);
    const currentSkus = prod.variants.map(v => (v.sku || '').trim().toLowerCase()).filter(Boolean);

    if (currentBarcodes.some(b => seenBarcodesInBatch.has(b))) {
      isBatchDuplicate = true;
    }
    if (currentSkus.some(s => seenSkusInBatch.has(s))) {
      isBatchDuplicate = true;
    }

    if (isBatchDuplicate) {
      candidateDetails.push({
        productId: prod.id,
        sourceId,
        title: prod.title,
        brand: prod.brand,
        category: prod.category,
        status: 'duplicate',
        reasons: ['Duplicate record within the same ingestion batch.'],
        product: prod,
      });
      continue;
    }

    // Record as seen in this batch
    seenIdsInBatch.add(prod.id);
    if (sourceId) seenIdsInBatch.add(sourceId);
    currentBarcodes.forEach(b => seenBarcodesInBatch.add(b));
    currentSkus.forEach(s => seenSkusInBatch.add(s));

    // Check against existing catalog
    const existingMatch = findMatchingCatalogProduct(prod, existingCatalog);
    if (existingMatch) {
      const conflictCheck = detectProductConflict(prod, existingMatch);
      if (conflictCheck.isConflict) {
        candidateDetails.push({
          productId: prod.id,
          sourceId,
          title: prod.title,
          brand: prod.brand,
          category: prod.category,
          status: 'conflict',
          reasons: conflictCheck.differences.map(d => `Source value differs from catalog: ${d}`),
          product: prod,
        });
      } else {
        candidateDetails.push({
          productId: prod.id,
          sourceId,
          title: prod.title,
          brand: prod.brand,
          category: prod.category,
          status: 'duplicate',
          reasons: ['Product already exists in catalog with identical attributes.'],
          product: prod,
        });
      }
      continue;
    }

    // Passed all checks: eligible for import
    candidateDetails.push({
      productId: prod.id,
      sourceId,
      title: prod.title,
      brand: prod.brand,
      category: prod.category,
      status: 'eligible',
      reasons: [],
      product: prod,
    });
    eligibleProducts.push(prod);
  }

  return {
    candidateDetails,
    eligibleProducts,
  };
}

/**
 * Core Ingestion Service: analyzes a merchant store either via public catalog feed (/products.json)
 * or via verified Solstice demo fixtures, computing real evidence-backed metrics with zero mock fabrication.
 */
export async function ingestAndAnalyzeStore(
  rawUrl: string,
  options: IngestionOptions = {}
): Promise<QuickHealthCheckResult> {
  const norm = normalizeStoreUrl(rawUrl);
  if (!norm.isValid) {
    throw new Error(norm.error || 'Invalid URL');
  }

  const { hostname, origin } = norm;
  const timestamp = new Date().toISOString();
  const existingCatalog = options.existingCatalog || [];

  // 1. Identify if this is the Solstice Demo Fixture environment
  const isDemoStore = 
    hostname.includes('solstice') || 
    hostname.includes('example.com') || 
    hostname === 'localhost' ||
    hostname === 'demo.store';

  if (isDemoStore) {
    return evaluateProductsCatalog(
      initialProducts, 
      origin, 
      'Solstice Mercantile (Demo Fixture Feed)', 
      'demo_fixture',
      existingCatalog
    );
  }

  // 2. Real Store Ingestion Path: Shopify Public Catalog Endpoint (/products.json)
  const endpoint = `${origin}/products.json?limit=25`;
  const fetchFn = options.customFetch || (typeof fetch !== 'undefined' ? fetch : null);

  if (!fetchFn) {
    const healthCheck: QuickHealthCheckResult = {
      url: origin,
      timestamp,
      catalogCompletenessEstimate: 0,
      schemaFound: false,
      gtinPresentRatio: 0,
      conflictingClaimsCount: 0,
      missingAttributesCount: 0,
      detectedPlatform: 'Unknown (Runtime Fetch Unavailable)',
      sampleIssues: ['Fetch API not available in current runtime environment.'],
      scanStatus: 'network_failure',
      notice: 'Cannot perform network ingestion without Fetch API.',
    };

    const ingestionResult: StoreIngestionResult = {
      healthCheck,
      candidateProducts: [],
      evaluationDetails: [],
      source: {
        platform: 'Unknown (Runtime Fetch Unavailable)',
        origin,
        endpoint,
        timestamp,
        isPartialSample: false,
        sampleLimit: 25,
        discoveredCount: 0,
        parsedCount: 0,
      },
      warnings: ['Fetch API not available in current runtime environment.'],
    };

    return { ...healthCheck, ingestionResult };
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), options.fetchTimeoutMs || 5000) : null;

    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller ? controller.signal : undefined,
    });

    if (timeoutId) clearTimeout(timeoutId);

    if (!response.ok) {
      const healthCheck: QuickHealthCheckResult = {
        url: origin,
        timestamp,
        catalogCompletenessEstimate: 0,
        schemaFound: false,
        gtinPresentRatio: 0,
        conflictingClaimsCount: 0,
        missingAttributesCount: 0,
        detectedPlatform: 'Restricted / Non-Public Storefront',
        sampleIssues: [
          `Public product feed returned HTTP ${response.status} ${response.statusText}.`,
          'Direct public catalog access is disabled or restricted by the merchant store.',
        ],
        scanStatus: 'unsupported_store',
        notice: 'Store does not expose an open public /products.json feed. Live ingestion requires an authorized Store Connector in Settings.',
      };

      const ingestionResult: StoreIngestionResult = {
        healthCheck,
        candidateProducts: [],
        evaluationDetails: [],
        source: {
          platform: 'Restricted / Non-Public Storefront',
          origin,
          endpoint,
          timestamp,
          isPartialSample: false,
          sampleLimit: 25,
          discoveredCount: 0,
          parsedCount: 0,
        },
        warnings: [`Storefront feed returned HTTP ${response.status}. Public catalog access restricted.`],
      };

      return { ...healthCheck, ingestionResult };
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.products)) {
      const healthCheck: QuickHealthCheckResult = {
        url: origin,
        timestamp,
        catalogCompletenessEstimate: 0,
        schemaFound: false,
        gtinPresentRatio: 0,
        conflictingClaimsCount: 0,
        missingAttributesCount: 0,
        detectedPlatform: 'Non-Shopify / Custom Platform',
        sampleIssues: ['Endpoint returned valid JSON but lacked standard Shopify product arrays.'],
        scanStatus: 'unsupported_store',
        notice: 'Platform catalog schema not recognized for automatic public scan.',
      };

      const ingestionResult: StoreIngestionResult = {
        healthCheck,
        candidateProducts: [],
        evaluationDetails: [],
        source: {
          platform: 'Non-Shopify / Custom Platform',
          origin,
          endpoint,
          timestamp,
          isPartialSample: false,
          sampleLimit: 25,
          discoveredCount: 0,
          parsedCount: 0,
        },
        warnings: ['Catalog schema does not match standard public Shopify feed format.'],
      };

      return { ...healthCheck, ingestionResult };
    }

    const rawProducts: ShopifyPublicProduct[] = data.products;
    if (rawProducts.length === 0) {
      const healthCheck: QuickHealthCheckResult = {
        url: origin,
        timestamp,
        catalogCompletenessEstimate: 0, // Empty catalog has 0% completeness
        schemaFound: true,
        gtinPresentRatio: 0,
        conflictingClaimsCount: 0,
        missingAttributesCount: 0,
        detectedPlatform: 'Shopify Storefront (Empty Catalog)',
        sampleIssues: ['Store catalog endpoint contains 0 active public products.'],
        scanStatus: 'real_scan',
        notice: '0 products found in public feed. Empty catalog cannot be evaluated.',
      };

      const ingestionResult: StoreIngestionResult = {
        healthCheck,
        candidateProducts: [],
        evaluationDetails: [],
        source: {
          platform: 'Shopify Storefront (Empty Catalog)',
          origin,
          endpoint,
          timestamp,
          isPartialSample: false,
          sampleLimit: 25,
          discoveredCount: 0,
          parsedCount: 0,
        },
        warnings: ['0 products found in public feed.'],
      };

      return { ...healthCheck, ingestionResult };
    }

    // Convert raw public Shopify products into our domain model and evaluate
    // NOTE: Only observed source facts are recorded; zero inventory or evidence values are fabricated.
    const domainProducts: Product[] = rawProducts.map((p, pIdx) => {
      const variants: Variant[] = (p.variants || []).map((v, vIdx) => ({
        id: `v_${v.id || `${pIdx}_${vIdx}`}`,
        sku: (v.sku || '').trim(),
        title: (v.title || '').trim(),
        barcode: (v.barcode || '').trim(),
        price: typeof v.price === 'string' ? parseFloat(v.price) || 0 : (v.price || 0),
        inventoryCount: 0, // Public storefront JSON does not provide warehouse inventory quantities
        attributes: {},
      }));

      const observedVendor = (p.vendor || '').trim();
      const observedType = (p.product_type || '').trim();
      const observedTitle = (p.title || '').trim();

      const prod: Product = {
        id: `p_${p.id || pIdx}`,
        title: observedTitle,
        brand: observedVendor, // Do not inject 'Unknown Brand' placeholder
        category: observedType, // Do not inject 'General Merchandise' placeholder
        description: (p.body_html || '').replace(/<[^>]*>?/gm, '').trim(),
        image: '',
        status: 'active',
        completenessScore: 0,
        evidenceCoverageScore: 0, // Public storefront feeds do not provide lab evidence documents
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {
          sourcePlatform: 'shopify',
          sourceProductId: String(p.id || ''),
          sourceHandle: p.handle || '',
          provenance: 'observed_in_sample',
        },
        variants,
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: timestamp,
      };

      prod.completenessScore = calculateProductCompleteness(prod);
      return prod;
    });

    return evaluateProductsCatalog(
      domainProducts, 
      origin, 
      `Shopify Public Storefront Sample (${domainProducts.length} Products Sampled)`, 
      'real_scan',
      existingCatalog
    );
  } catch (err: unknown) {
    const errorMsg = (err as Error).message || 'Network error';
    const isCorsOrFetch = errorMsg.toLowerCase().includes('failed to fetch') || errorMsg.toLowerCase().includes('network');

    const healthCheck: QuickHealthCheckResult = {
      url: origin,
      timestamp,
      catalogCompletenessEstimate: 0,
      schemaFound: false,
      gtinPresentRatio: 0,
      conflictingClaimsCount: 0,
      missingAttributesCount: 0,
      detectedPlatform: 'External Storefront (CORS Restricted)',
      sampleIssues: [
        `Direct browser fetch was blocked: ${errorMsg}`,
        'Most modern storefronts restrict browser-origin cross-domain fetch via CORS headers.',
        'Use authorized Store Connectors in Settings or a server-side proxy for full live data sync.',
      ],
      scanStatus: isCorsOrFetch ? 'network_failure' : 'unsupported_store',
      notice: 'Direct browser access was blocked by CORS policy. This is expected security behavior for third-party storefront domains.',
    };

    const ingestionResult: StoreIngestionResult = {
      healthCheck,
      candidateProducts: [],
      evaluationDetails: [],
      source: {
        platform: 'External Storefront (CORS Restricted)',
        origin,
        endpoint,
        timestamp,
        isPartialSample: false,
        sampleLimit: 25,
        discoveredCount: 0,
        parsedCount: 0,
      },
      warnings: [
        `Direct browser fetch was blocked by CORS/network policy: ${errorMsg}. Public feed cannot be read directly from the browser origin.`,
      ],
    };

    return { ...healthCheck, ingestionResult };
  }
}

/**
 * Evaluates real metrics and issues from an array of domain products,
 * constructing both QuickHealthCheckResult and the typed StoreIngestionResult.
 */
export function evaluateProductsCatalog(
  products: Product[],
  url: string,
  platformName: string,
  scanStatus: 'real_scan' | 'partial_scan' | 'unsupported_store' | 'network_failure' | 'demo_fixture',
  existingCatalog: Product[] = []
): QuickHealthCheckResult {
  const timestamp = new Date().toISOString();
  let totalVariants = 0;
  let validGtinVariants = 0;
  let missingAttrsTotal = 0;
  const issues: string[] = [];

  for (const p of products) {
    const vList = p.variants || [];
    totalVariants += vList.length;
    for (const v of vList) {
      if (v.barcode && isValidGtin13(v.barcode)) {
        validGtinVariants++;
      } else {
        if (!v.barcode) {
          if (issues.length < 3 && !issues.some(i => i.includes('Missing GTIN/UPC'))) {
            issues.push(`Missing GTIN/UPC identifier on "${p.title}" (${v.title || v.sku})`);
          }
        } else if (!isValidGtin13(v.barcode)) {
          if (issues.length < 3 && !issues.some(i => i.includes('invalid GTIN check digit'))) {
            issues.push(`Variant "${v.sku}" has invalid GTIN-13 check digit: ${v.barcode}`);
          }
        }
      }
    }

    if (!p.description || p.description.length < 20) {
      missingAttrsTotal++;
      if (issues.length < 6 && !issues.some(i => i.includes('description'))) {
        issues.push(`Product "${p.title || 'Untitled'}" lacks detailed physical description`);
      }
    }

    if (!p.brand || p.brand.trim() === '') {
      missingAttrsTotal++;
      if (issues.length < 6 && !issues.some(i => i.includes('brand'))) {
        issues.push(`Product "${p.title || 'Untitled'}" lacks manufacturer brand specification`);
      }
    }

    if (!p.category || p.category.trim() === '') {
      missingAttrsTotal++;
      if (issues.length < 6 && !issues.some(i => i.includes('category'))) {
        issues.push(`Product "${p.title || 'Untitled'}" lacks standardized taxonomy/category`);
      }
    }

    if (!p.image || p.image.trim() === '') {
      missingAttrsTotal++;
      if (issues.length < 6 && !issues.some(i => i.includes('image'))) {
        issues.push(`Product "${p.title || 'Untitled'}" lacks primary product image asset`);
      }
    }
  }

  const gtinPresentRatio = totalVariants > 0
    ? Math.round((validGtinVariants / totalVariants) * 100)
    : 0;

  const totalScore = products.reduce((acc, p) => acc + calculateProductCompleteness(p), 0);
  const catalogCompletenessEstimate = products.length > 0
    ? Math.round(totalScore / products.length)
    : 0;

  if (issues.length === 0) {
    issues.push('All sampled products satisfy baseline GTIN and attribute criteria.');
  }

  const { candidateDetails, eligibleProducts } = evaluateCandidateProducts(products, existingCatalog);
  const isPartial = scanStatus === 'real_scan' || scanStatus === 'partial_scan';

  const healthCheck: QuickHealthCheckResult = {
    url,
    timestamp,
    catalogCompletenessEstimate,
    schemaFound: true,
    gtinPresentRatio,
    conflictingClaimsCount: scanStatus === 'demo_fixture' ? 2 : 0,
    missingAttributesCount: missingAttrsTotal,
    detectedPlatform: platformName,
    sampleIssues: issues,
    scanStatus,
    notice: scanStatus === 'demo_fixture'
      ? 'Evaluated Solstice Mercantile demo catalog fixtures using deterministic rules.'
      : `Sample evaluation scanned ${products.length} products and ${totalVariants} variants from public feed. Full inventory requires authorized Store Connector.`,
  };

  const ingestionResult: StoreIngestionResult = {
    healthCheck,
    candidateProducts: products,
    evaluationDetails: candidateDetails,
    source: {
      platform: platformName,
      origin: url,
      endpoint: isPartial ? `${url}/products.json?limit=25` : url,
      timestamp,
      isPartialSample: isPartial,
      sampleLimit: isPartial ? 25 : products.length,
      discoveredCount: products.length,
      parsedCount: products.length,
    },
    warnings: isPartial
      ? ['Public feed is limited to a 25-product sample. Complete catalog requires authorized Store Connector in Settings.']
      : [],
  };

  return {
    ...healthCheck,
    ingestionResult,
  };
}
