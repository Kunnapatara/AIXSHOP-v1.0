import { Product, Variant } from '../../types';
import { isValidGtin13 } from '../validation/gtin';
import { WorkspaceBusinessProfile, BusinessHubChecklistResult } from '../businessProfile/types';

export interface DiscoveryDimensionScore {
  dimension: string;
  name: string;
  score: number;
  maxScore: number;
  weight: number;
  passedCount: number;
  failedCount: number;
  notAssessedCount: number;
  rulesEvaluated: number;
  evidence: string[];
}

export interface DiscoveryFinding {
  id: string;
  ruleId: string;
  dimension: string;
  productId: string;
  productTitle: string;
  variantId?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  observedValue: string;
  expectedCondition: string;
  evidence: string;
  recommendation: string;
  needsMerchantInput: boolean;
  recheckStatus: 'unverified' | 'verified_in_catalog';
}

export interface DiscoveryAuditResult {
  overallScore: number; // 0-100 deterministic
  totalProductsAssessed: number;
  totalVariantsAssessed: number;
  dimensions: Record<string, DiscoveryDimensionScore>;
  findings: DiscoveryFinding[];
  auditedAt: string;
  ruleVersion: string;
  dataOrigin: 'measured_catalog_data' | 'unavailable_empty_catalog';
  limitationsNotice: string;
}

export const DISCOVERY_RULE_VERSION = 'v1.0-deterministic';

/**
 * Deterministically evaluates catalog products against 8 AI discovery & shopping readiness dimensions.
 * Computes transparent, explainable scores based on genuine product metadata without synthetic values.
 */
export function evaluateDiscoveryReadiness(
  products: Product[],
  storeDomain?: string
): DiscoveryAuditResult {
  const auditedAt = new Date().toISOString();
  const findings: DiscoveryFinding[] = [];
  let totalVariants = 0;

  // Dimension accumulators: { passed, failed, notAssessed, evidence }
  const dimStats: Record<string, { passed: number; failed: number; notAssessed: number; evidence: string[] }> = {
    productIdentity: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    productContent: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    structuredAttributes: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    productIdentifiers: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    images: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    priceAndAvailability: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    urlAndSourceConsistency: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
    dataFreshness: { passed: 0, failed: 0, notAssessed: 0, evidence: [] },
  };

  for (const product of products) {
    const variants = product.variants || [];
    totalVariants += variants.length;

    // 1. Product Identity (Title & Brand)
    const title = (product.title || '').trim();
    if (title.length >= 10 && title.length <= 150) {
      dimStats.productIdentity.passed++;
    } else {
      dimStats.productIdentity.failed++;
      findings.push({
        id: `disc_title_${product.id}`,
        ruleId: 'DISC_TITLE_STRUCTURE',
        dimension: 'productIdentity',
        productId: product.id,
        productTitle: title,
        severity: title.length < 5 ? 'critical' : 'medium',
        title: 'Product Title Length Sub-optimal for Search',
        observedValue: `Length: ${title.length} chars ("${title.slice(0, 40)}...")`,
        expectedCondition: 'Title length between 10 and 150 characters with distinct product identity',
        evidence: `Product "${title}" has length ${title.length}.`,
        recommendation: 'Expand product title with defining characteristics (brand, type, key feature) under 150 chars.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    const brand = (product.brand || '').trim();
    const isGenericBrand = !brand || brand.toLowerCase() === 'unspecified' || brand.toLowerCase() === 'unknown brand';
    if (!isGenericBrand) {
      dimStats.productIdentity.passed++;
    } else {
      dimStats.productIdentity.failed++;
      findings.push({
        id: `disc_brand_${product.id}`,
        ruleId: 'DISC_BRAND_IDENTITY',
        dimension: 'productIdentity',
        productId: product.id,
        productTitle: title,
        severity: 'high',
        title: 'Missing or Generic Brand Identifier',
        observedValue: brand || '(empty)',
        expectedCondition: 'Canonical manufacturer or authentic brand name specified',
        evidence: `Brand attribute is "${brand || '(empty)'}".`,
        recommendation: 'Merchant input required: provide authentic brand/vendor for commerce clustering.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    // 2. Product Content (Description Quality)
    const desc = (product.description || '').trim();
    if (desc.length >= 60) {
      dimStats.productContent.passed++;
    } else {
      dimStats.productContent.failed++;
      findings.push({
        id: `disc_desc_${product.id}`,
        ruleId: 'DISC_DESCRIPTION_SUBSTANCE',
        dimension: 'productContent',
        productId: product.id,
        productTitle: title,
        severity: desc.length === 0 ? 'high' : 'medium',
        title: 'Thin Product Description for Conversational Search',
        observedValue: `${desc.length} characters`,
        expectedCondition: 'At least 60 characters of descriptive text covering features and specifications',
        evidence: `Description is ${desc.length} characters long.`,
        recommendation: 'Merchant input required: expand product description with detailed physical specs and use cases.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    // 3. Structured Attributes (Materials, Specs)
    const attrs = product.attributes || {};
    const hasCustomAttrs = Object.keys(attrs).some(
      k => !['sourcePlatform', 'sourceProductId', 'shopifyGid', 'provenance'].includes(k) && attrs[k]?.trim()
    );
    if (hasCustomAttrs) {
      dimStats.structuredAttributes.passed++;
    } else {
      dimStats.structuredAttributes.failed++;
      findings.push({
        id: `disc_attr_${product.id}`,
        ruleId: 'DISC_STRUCTURED_ATTRIBUTES',
        dimension: 'structuredAttributes',
        productId: product.id,
        productTitle: title,
        severity: 'medium',
        title: 'No Structured Technical Specifications',
        observedValue: 'No custom attributes present',
        expectedCondition: 'Structured attributes (e.g., material, dimensions, color, weight) attached',
        evidence: 'Only default provenance metadata found in product attributes.',
        recommendation: 'Attach structured technical attributes to power precise conversational queries.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    // 4. Product Identifiers (SKU & GTIN Check Digit)
    for (const v of variants) {
      const sku = (v.sku || '').trim();
      if (sku) {
        dimStats.productIdentifiers.passed++;
      } else {
        dimStats.productIdentifiers.failed++;
        findings.push({
          id: `disc_sku_${product.id}_${v.id}`,
          ruleId: 'DISC_VARIANT_SKU',
          dimension: 'productIdentifiers',
          productId: product.id,
          productTitle: title,
          variantId: v.id,
          severity: 'high',
          title: `Missing SKU on Variant (${v.title || v.id})`,
          observedValue: '(empty)',
          expectedCondition: 'Unique merchant SKU code assigned to every variant',
          evidence: `Variant "${v.title || v.id}" has empty SKU.`,
          recommendation: 'Merchant input required: assign a unique inventory tracking SKU.',
          needsMerchantInput: true,
          recheckStatus: 'unverified',
        });
      }

      const barcode = (v.barcode || '').trim();
      if (barcode) {
        if (isValidGtin13(barcode)) {
          dimStats.productIdentifiers.passed++;
        } else {
          dimStats.productIdentifiers.failed++;
          findings.push({
            id: `disc_gtin_${product.id}_${v.id}`,
            ruleId: 'DISC_GTIN_CHECK_DIGIT',
            dimension: 'productIdentifiers',
            productId: product.id,
            productTitle: title,
            variantId: v.id,
            severity: 'critical',
            title: `Invalid GTIN Check Digit on Barcode "${barcode}"`,
            observedValue: barcode,
            expectedCondition: 'Valid GS1 Modulo-10 checksum verified',
            evidence: `Barcode "${barcode}" fails GS1 checksum calculation.`,
            recommendation: 'Merchant input required: correct barcode check digit against GS1 allocation.',
            needsMerchantInput: true,
            recheckStatus: 'unverified',
          });
        }
      } else {
        dimStats.productIdentifiers.notAssessed++;
      }
    }

    // 5. Product Images (Valid URL & Presence)
    const imgUrl = (product.image || '').trim();
    if (imgUrl && (imgUrl.startsWith('https://') || imgUrl.startsWith('http://'))) {
      dimStats.images.passed++;
    } else {
      dimStats.images.failed++;
      findings.push({
        id: `disc_img_${product.id}`,
        ruleId: 'DISC_IMAGE_ASSET',
        dimension: 'images',
        productId: product.id,
        productTitle: title,
        severity: 'high',
        title: 'Missing or Invalid Primary Image Asset URL',
        observedValue: imgUrl || '(none)',
        expectedCondition: 'Accessible absolute HTTPS image URL provided',
        evidence: `Primary image URL is "${imgUrl || '(empty)'}".`,
        recommendation: 'Merchant input required: upload high-resolution product photography.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    // 6. Price & Availability
    const offers = product.offers || [];
    const validOffer = offers.find(o => typeof o.price === 'number' && o.price > 0 && o.currency);
    if (validOffer) {
      dimStats.priceAndAvailability.passed++;
    } else {
      dimStats.priceAndAvailability.failed++;
      findings.push({
        id: `disc_price_${product.id}`,
        ruleId: 'DISC_OFFER_PRICE',
        dimension: 'priceAndAvailability',
        productId: product.id,
        productTitle: title,
        severity: 'critical',
        title: 'No Valid Explicit Price Offer Found',
        observedValue: offers.length > 0 ? `Price: ${offers[0].price}` : 'No offers listed',
        expectedCondition: 'Explicit non-zero price with ISO 4217 currency code',
        evidence: 'Active catalog listing lacks a positive price offer.',
        recommendation: 'Merchant input required: set verified retail price in store management.',
        needsMerchantInput: true,
        recheckStatus: 'unverified',
      });
    }

    // 7. URL & Source Consistency
    const offerUrl = offers[0]?.url || product.attributes?.canonicalProductUrl || '';
    const urlProvenance = product.attributes?.urlProvenance || '';
    const normalizedExpectedDomain = storeDomain ? storeDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase() : '';
    let isValidCanonicalUrl = false;
    if (offerUrl.startsWith('https://') && urlProvenance !== 'unavailable_store_domain') {
      if (normalizedExpectedDomain && normalizedExpectedDomain !== 'store.myshopify.com') {
        isValidCanonicalUrl = offerUrl.toLowerCase().includes(normalizedExpectedDomain);
      } else {
        isValidCanonicalUrl = !offerUrl.includes('store.myshopify.com');
      }
    }

    if (isValidCanonicalUrl) {
      dimStats.urlAndSourceConsistency.passed++;
    } else {
      dimStats.urlAndSourceConsistency.failed++;
      findings.push({
        id: `disc_url_${product.id}`,
        ruleId: 'DISC_CANONICAL_URL',
        dimension: 'urlAndSourceConsistency',
        productId: product.id,
        productTitle: title,
        severity: 'medium',
        title: 'Missing or Unverified Canonical Storefront Product URL',
        observedValue: offerUrl || '(none)',
        expectedCondition: 'Explicit HTTPS storefront URL pointing to verified merchant store domain',
        evidence: `Product offer URL is "${offerUrl || '(empty)'}" (provenance: ${urlProvenance || 'unknown'}).`,
        recommendation: 'Ensure catalog sync uses verified Shopify storefront domain and valid product handle.',
        needsMerchantInput: false,
        recheckStatus: 'unverified',
      });
    }

    // 8. Data Freshness
    const lastAudited = product.lastAudited ? new Date(product.lastAudited).getTime() : 0;
    const isFresh = (Date.now() - lastAudited) < (30 * 24 * 60 * 60 * 1000);
    if (isFresh) {
      dimStats.dataFreshness.passed++;
    } else {
      dimStats.dataFreshness.failed++;
    }
  }

  // Weight definitions (total = 100)
  const weights: Record<string, { weight: number; name: string }> = {
    productIdentity: { weight: 15, name: 'Product Identity' },
    productContent: { weight: 20, name: 'Product Content & Substance' },
    structuredAttributes: { weight: 15, name: 'Structured Specifications' },
    productIdentifiers: { weight: 15, name: 'Trade Identifiers (SKU/GTIN)' },
    images: { weight: 10, name: 'Visual Media Assets' },
    priceAndAvailability: { weight: 15, name: 'Price & Stock Availability' },
    urlAndSourceConsistency: { weight: 5, name: 'Canonical URL Consistency' },
    dataFreshness: { weight: 5, name: 'Catalog Data Freshness' },
  };

  const dimensions: Record<string, DiscoveryDimensionScore> = {};
  let weightedSum = 0;

  for (const [key, meta] of Object.entries(weights)) {
    const stats = dimStats[key];
    const rulesEvaluated = stats.passed + stats.failed;
    // Empty catalogs or dimensions with 0 assessed rules MUST NOT score 100%
    const ratio = rulesEvaluated > 0 ? stats.passed / rulesEvaluated : 0;
    const dimScore = Math.round(ratio * meta.weight);
    weightedSum += dimScore;

    dimensions[key] = {
      dimension: key,
      name: meta.name,
      score: dimScore,
      maxScore: meta.weight,
      weight: meta.weight,
      passedCount: stats.passed,
      failedCount: stats.failed,
      notAssessedCount: stats.notAssessed,
      rulesEvaluated,
      evidence: [
        rulesEvaluated === 0
          ? 'No products or rules assessed yet (0 / 0).'
          : `${stats.passed} rules passed out of ${rulesEvaluated} assessed.`,
        stats.failed > 0 ? `${stats.failed} defect(s) detected.` : rulesEvaluated > 0 ? 'No critical defects found.' : 'Requires catalog data to assess.',
      ],
    };
  }

  const overallScore = products.length === 0 ? 0 : Math.min(100, Math.max(0, weightedSum));

  return {
    overallScore,
    totalProductsAssessed: products.length,
    totalVariantsAssessed: totalVariants,
    dimensions,
    findings,
    auditedAt,
    ruleVersion: DISC_RULE_VERSION,
    dataOrigin: products.length > 0 ? 'measured_catalog_data' : 'unavailable_empty_catalog',
    limitationsNotice:
      'Local deterministic structural check of catalog fields only. Does not query live external AI search rankings, citations, or official ChatGPT Business Hub enrollment.',
  };
}

const DISC_RULE_VERSION = 'v1.0-deterministic';

/**
 * Builds an actionable ChatGPT & AI Commerce Business Hub Readiness Checklist
 * evaluating merchant business identity, policy URLs, domain verification, and catalog export.
 */
export function buildBusinessHubChecklist(
  profile: WorkspaceBusinessProfile | null,
  catalogProductsCount: number,
  discoveryScore: number
): BusinessHubChecklistResult {
  const items: BusinessHubChecklistResult['checklistItems'] = [];

  const profileOrigin: 'independently_verified' | 'merchant_self_declared' =
    profile?.verificationStatus === 'independently_verified' ? 'independently_verified' : 'merchant_self_declared';

  // 1. Legal & Brand Identity
  const hasLegalName = Boolean(profile?.legalBusinessName?.trim());
  items.push({
    id: 'hub_legal_name',
    category: 'identity',
    title: 'Legal Business Entity Name',
    status: hasLegalName ? 'ready' : 'action_required',
    dataOrigin: profileOrigin,
    currentValue: profile?.legalBusinessName || undefined,
    requirementDescription: 'Official registered business name matching commercial registration or tax records.',
  });

  const hasBrandName = Boolean(profile?.publicBrandName?.trim());
  items.push({
    id: 'hub_brand_name',
    category: 'identity',
    title: 'Public Commerce Brand Name',
    status: hasBrandName ? 'ready' : 'action_required',
    dataOrigin: profileOrigin,
    currentValue: profile?.publicBrandName || undefined,
    requirementDescription: 'Public consumer-facing trademark or brand name.',
  });

  // 2. Official Website & Domain Ownership
  const hasWebsite = Boolean(profile?.officialWebsite?.startsWith('https://'));
  items.push({
    id: 'hub_website',
    category: 'identity',
    title: 'Official Website URL (HTTPS)',
    status: hasWebsite ? 'ready' : 'action_required',
    dataOrigin: profileOrigin,
    currentValue: profile?.officialWebsite || undefined,
    requirementDescription: 'Primary secure storefront domain owned and operated by the merchant.',
  });

  // 3. Contact Details
  const hasEmail = Boolean(profile?.contactEmail?.includes('@'));
  items.push({
    id: 'hub_email',
    category: 'contact',
    title: 'Official Business Contact Email',
    status: hasEmail ? 'ready' : 'action_required',
    dataOrigin: profileOrigin,
    currentValue: profile?.contactEmail || undefined,
    requirementDescription: 'Corporate business email address on company domain for owner verification.',
  });

  const hasPhone = Boolean(profile?.contactPhone?.trim());
  items.push({
    id: 'hub_phone',
    category: 'contact',
    title: 'Customer Support Telephone Number',
    status: hasPhone ? 'ready' : 'action_required',
    dataOrigin: profileOrigin,
    currentValue: profile?.contactPhone || undefined,
    requirementDescription: 'Direct customer contact or service desk telephone number.',
  });

  // 4. Policy URLs
  const hasPrivacy = Boolean(profile?.privacyPolicyUrl?.startsWith('https://'));
  items.push({
    id: 'hub_privacy',
    category: 'policies',
    title: 'Public Privacy Policy URL',
    status: hasPrivacy ? 'ready' : 'missing',
    dataOrigin: profileOrigin,
    currentValue: profile?.privacyPolicyUrl || undefined,
    requirementDescription: 'Legally compliant privacy disclosure accessible to consumers and web crawlers.',
  });

  const hasReturns = Boolean(profile?.returnPolicyUrl?.startsWith('https://'));
  items.push({
    id: 'hub_returns',
    category: 'policies',
    title: 'Return & Refund Policy URL',
    status: hasReturns ? 'ready' : 'missing',
    dataOrigin: profileOrigin,
    currentValue: profile?.returnPolicyUrl || undefined,
    requirementDescription: 'Explicit terms covering returns, exchanges, refunds, and merchant warranty.',
  });

  const hasShipping = Boolean(profile?.shippingPolicyUrl?.startsWith('https://'));
  items.push({
    id: 'hub_shipping',
    category: 'policies',
    title: 'Shipping & Delivery Policy URL',
    status: hasShipping ? 'ready' : 'missing',
    dataOrigin: profileOrigin,
    currentValue: profile?.shippingPolicyUrl || undefined,
    requirementDescription: 'Clear delivery timeframes, rates, and international shipping specifications.',
  });

  // 5. Product Catalog Readiness
  const hasCatalog = catalogProductsCount > 0;
  items.push({
    id: 'hub_catalog',
    category: 'catalog',
    title: 'Synchronized Product Catalog',
    status: hasCatalog ? 'ready' : 'action_required',
    dataOrigin: 'measured_catalog_data',
    currentValue: `${catalogProductsCount} products in catalog`,
    requirementDescription: 'Active product catalog with structured pricing, inventory, and GTINs.',
  });

  const isDiscoveryReady = hasCatalog && discoveryScore >= 70;
  items.push({
    id: 'hub_discovery_score',
    category: 'catalog',
    title: 'AI Discovery Readiness Score Threshold (≥70%)',
    status: isDiscoveryReady ? 'ready' : 'action_required',
    dataOrigin: 'measured_catalog_data',
    currentValue: `${discoveryScore}%`,
    requirementDescription: 'Minimum deterministic local catalog readiness score for conversational discovery.',
  });

  const readyCount = items.filter(i => i.status === 'ready').length;
  const overallReadinessScore = Math.round((readyCount / items.length) * 100);
  const limitationsNotice =
    'Merchant Preparation Checklist Only: No official ChatGPT Business Hub or external AI platform registration API is connected. Self-declared merchant profile entries do not represent independent external verification.';

  const exportableMerchantPackage = {
    packageType: 'merchant_preparation_checklist',
    officialIntegrationConnected: false,
    profileVerificationStatus: profile?.verificationStatus || 'not_verified',
    brandIdentity: {
      legalName: profile?.legalBusinessName || '',
      publicBrand: profile?.publicBrandName || '',
      description: profile?.brandDescription || '',
      officialWebsite: profile?.officialWebsite || '',
      logoUrl: profile?.logoUrl || '',
    },
    contact: {
      email: profile?.contactEmail || '',
      phone: profile?.contactPhone || '',
      address: profile?.businessAddress || '',
      supportUrl: profile?.supportUrl || '',
    },
    policies: {
      shipping: profile?.shippingPolicyUrl || '',
      returns: profile?.returnPolicyUrl || '',
      refunds: profile?.refundPolicyUrl || '',
      privacy: profile?.privacyPolicyUrl || '',
      terms: profile?.termsOfServiceUrl || '',
    },
    catalogReadiness: {
      productsCount: catalogProductsCount,
      aiDiscoveryScore: discoveryScore,
      evaluatedAt: new Date().toISOString(),
    },
    disclaimer: limitationsNotice,
  };

  return {
    checklistItems: items,
    overallReadinessScore,
    checklistType: 'merchant_preparation_checklist',
    officialIntegrationConnected: false,
    limitationsNotice,
    exportableMerchantPackage,
  };
}
