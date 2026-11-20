import { Product, Finding, ActionItem, StoreProfile } from '../../types';
import { validateGtin } from '../validation/gtin';
import { classifyProductDomain } from './categoryApplicability';
import { calculateProductCompleteness, calculateStoreCompletenessAvg } from '../catalog/completeness';

export type AuditRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AuditRunSummary {
  catalogCompletenessAvg: number;
  totalProducts: number;
  totalVariants: number;
  criticalFindingsCount: number;
  highFindingsCount: number;
  mediumFindingsCount: number;
  lowFindingsCount: number;
  totalFindingsCount: number;
  totalActionsCount: number;
  rulesEvaluated: number;
  ruleBreakdown: Record<string, number>;
}

export interface AuditExecutionResult {
  findings: Finding[];
  actionItems: ActionItem[];
  summary: AuditRunSummary;
  updatedStoreProfile: StoreProfile;
  updatedProducts: Product[];
  rulesEvaluated: number;
}

export const AUDIT_RULES = [
  'RULE_VARIANT_GTIN_CHECK_DIGIT',
  'RULE_VARIANT_PRICE_PRESENCE',
  'RULE_PRODUCT_DESCRIPTION_LENGTH',
  'RULE_PRODUCT_BRAND_SPECIFICATION',
  'RULE_PRODUCT_CATEGORY_TAXONOMY',
  'RULE_PRODUCT_IMAGE_ASSET',
  'RULE_DISHWASHER_MICROWAVE_SAFETY',
  'RULE_UNVERIFIED_EVIDENCE_CLAIMS',
  'RULE_DUAL_UNIT_MEASUREMENT_POLICY',
  'RULE_STRUCTURED_BREW_METHODS',
  'RULE_SHIPPING_SLA_RECONCILIATION',
  'RULE_MARKETING_BURN_TIME_CONFLICT',
] as const;

export type AuditRuleCode = typeof AUDIT_RULES[number];

export const MAX_AUDIT_IDENTIFIER_LENGTH = 64;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function encodeUtf8Bytes(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure TypeScript synchronous FIPS 180-4 SHA-256 implementation (browser & Node compatible).
 */
export function sha256Hex(input: string): string {
  const bytes = encodeUtf8Bytes(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return Array.from(hash)
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

export interface AuditEntityIdParams {
  ruleSlug: string;
  productId?: string;
  variantId?: string;
  variantIndex?: number;
}

/**
 * Generates deterministic, namespace-separated Finding & Action identifiers
 * guaranteed to fit within PostgreSQL VARCHAR(64) constraints (<= 64 chars).
 * Preserves legacy human-readable format when both IDs fit within 64 chars,
 * and falls back to collision-resistant SHA-256 digests when concatenated
 * product/variant IDs exceed 64 chars (e.g. Shopify 13–16+ digit numeric IDs).
 */
export function buildAuditEntityIds(params: AuditEntityIdParams): { findingId: string; actionId: string } {
  const safeSlug = params.ruleSlug.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20) || 'rule';
  const variantKey =
    params.variantId !== undefined
      ? params.variantId || `idx_${params.variantIndex ?? 0}`
      : undefined;

  let rawFindingId: string;
  let rawActionId: string;

  if (params.productId === undefined) {
    rawFindingId = `find_${safeSlug}`;
    rawActionId = `act_${safeSlug}`;
  } else if (variantKey !== undefined) {
    rawFindingId = `find_${safeSlug}_${params.productId}_${variantKey}`;
    rawActionId = `act_${safeSlug}_${params.productId}_${variantKey}`;
  } else {
    rawFindingId = `find_${safeSlug}_${params.productId}`;
    rawActionId = `act_${safeSlug}_${params.productId}`;
  }

  if (
    rawFindingId.length <= MAX_AUDIT_IDENTIFIER_LENGTH &&
    rawActionId.length <= MAX_AUDIT_IDENTIFIER_LENGTH
  ) {
    return { findingId: rawFindingId, actionId: rawActionId };
  }

  const canonicalInput = JSON.stringify([
    'aixshop_audit_id_v1',
    params.ruleSlug,
    params.productId ?? null,
    variantKey ?? null,
  ]);
  const digest = sha256Hex(canonicalInput).slice(0, 32);

  return {
    findingId: `find_${safeSlug}_h_${digest}`,
    actionId: `act_${safeSlug}_h_${digest}`,
  };
}

/**
 * Genuine, deterministic catalog audit engine.
 * Evaluates real catalog products, variants, attributes, evidence, and store policies
 * using established domain rules with zero simulated delays or fake findings.
 */
export function executeCatalogAudit(
  products: Product[],
  storeProfile: StoreProfile,
  existingActions: ActionItem[] = []
): AuditExecutionResult {
  const timestamp = new Date().toISOString();
  const findings: Finding[] = [];
  const actionItems: ActionItem[] = [];
  const ruleCounts: Record<string, number> = {};

  const recordRule = (code: AuditRuleCode) => {
    ruleCounts[code] = (ruleCounts[code] || 0) + 1;
  };

  // Build lookup of existing action items to preserve previously approved or dismissed states
  // for verified matching entities only (zero cross-product leakage).
  const existingById = new Map<string, ActionItem>();
  const existingByFindingId = new Map<string, ActionItem>();
  for (const act of existingActions) {
    if (act.id && !existingById.has(act.id)) {
      existingById.set(act.id, act);
    }
    if (act.findingId && !existingByFindingId.has(act.findingId)) {
      existingByFindingId.set(act.findingId, act);
    }
  }

  const usedActionIds = new Set<string>();
  const consumedExistingActionIds = new Set<string>();

  const isOwnedExistingCandidate = (
    candidate: ActionItem | undefined,
    expectedProductId: string | undefined,
    isLegacyFallback: boolean
  ): candidate is ActionItem => {
    if (!candidate) return false;
    if (consumedExistingActionIds.has(candidate.id)) return false;

    if (expectedProductId !== undefined) {
      if (isLegacyFallback) {
        // Legacy fallback IDs (act_02, act_03, act_05, act_07) must explicitly prove product ownership.
        return Boolean(candidate.productId && candidate.productId === expectedProductId);
      }
      if (candidate.productId && candidate.productId !== expectedProductId) {
        return false;
      }
      return true;
    }

    // Store/catalog-scoped actions must never absorb a product-scoped action.
    return !candidate.productId;
  };

  const resolveExistingAction = (
    findingId: string,
    defaultActionId: string,
    options: { productId?: string; fallbackKeys?: string[] } = {}
  ): { prevAction?: ActionItem; actionId: string } => {
    const { productId, fallbackKeys = [] } = options;

    const primaryCandidates: Array<ActionItem | undefined> = [
      existingByFindingId.get(findingId),
      existingById.get(defaultActionId),
    ];
    let prevAction = primaryCandidates.find((c): c is ActionItem =>
      isOwnedExistingCandidate(c, productId, false)
    );

    if (!prevAction && fallbackKeys.length > 0) {
      prevAction = fallbackKeys
        .map((k) => existingById.get(k))
        .find((c): c is ActionItem => isOwnedExistingCandidate(c, productId, true));
    }

    if (prevAction?.id) {
      consumedExistingActionIds.add(prevAction.id);
    }

    let actionId = defaultActionId;
    if (
      prevAction?.id &&
      prevAction.id.length <= MAX_AUDIT_IDENTIFIER_LENGTH &&
      !usedActionIds.has(prevAction.id)
    ) {
      actionId = prevAction.id;
    }
    usedActionIds.add(actionId);
    return { prevAction, actionId };
  };

  const buildScopedActionItem = (
    prevAction: ActionItem | undefined,
    freshAction: ActionItem
  ): ActionItem => {
    if (!prevAction) {
      return freshAction;
    }
    return {
      ...prevAction,
      id: freshAction.id,
      findingId: freshAction.findingId,
      productId: freshAction.productId,
      productTitle: freshAction.productTitle,
    };
  };

  let totalVariants = 0;
  const updatedProducts: Product[] = [];

  // 1. Evaluate Product-level and Variant-level rules
  for (const p of products) {
    let productFindingsCount = 0;
    const variants = p.variants || [];
    totalVariants += variants.length;
    const domainClass = classifyProductDomain(p);

    // Rule: Barcode / GTIN integrity (GTIN-8, GTIN-12/UPC-A, GTIN-13/EAN-13, GTIN-14) with evidence-based exemption eligibility
    recordRule('RULE_VARIANT_GTIN_CHECK_DIGIT');
    variants.forEach((v, vIdx) => {
      const barcode = (v.barcode || '').trim();
      const variantKey = v.sku || v.id || `idx_${vIdx}`;
      if (!barcode) {
        if (domainClass.gtinEligibilityStatus === 'verified_exempt' && domainClass.isGtinExempt) {
          // Only authoritatively verified exemptions (e.g., Shopify isGiftCard=true or verified exemption evidence doc) suppress GTIN requirements
          return;
        }

        if (domainClass.gtinEligibilityStatus === 'declared_identifier_absence') {
          const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
            ruleSlug: 'gtin_decl',
            productId: p.id,
            variantId: v.id,
            variantIndex: vIdx,
          });
          const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

          findings.push({
            id: findingId,
            scope: 'product',
            productId: p.id,
            productTitle: p.title,
            type: 'unverified_evidence',
            severity: 'medium',
            title: `NEEDS_REVIEW: Declared Identifier Absence Without Exemption Proof (${variantKey})`,
            description: `Variant "${v.title || variantKey}" has no barcode and relies on a self-declared identifier absence or exemption flag without verified supporting documentation.`,
            observedEvidence: `Merchant declared identifierExists="no" / gtinExemption on "${p.title}", with no verified GTIN exemption document attached.`,
            derivedConclusion: 'Self-declared identifier absence is NOT equivalent to a verified GTIN exemption and requires review before marketplace submission.',
            merchantVerified: prevAction?.status === 'approved',
            whyItMatters: 'Channels reject unsubstantiated identifier exemptions when a brand manufacturer GTIN actually exists.',
            suggestedCorrection: 'Attach a verified GTIN exemption document / evidence reference, or supply a valid GS1 GTIN barcode.',
            targetField: `variants[${vIdx}].barcode`,
            currentValue: 'declared_identifier_absence (unverified)',
            recommendedValue: '',
            actionItemId: actionId,
            ruleCode: 'RULE_VARIANT_GTIN_CHECK_DIGIT',
            needsMerchantInput: true,
            reviewStatus: 'NEEDS_REVIEW',
            gtinEligibilityStatus: 'declared_identifier_absence',
          });

          actionItems.push(buildScopedActionItem(prevAction, {
            id: actionId,
            findingId,
            productId: p.id,
            productTitle: p.title,
            title: `Verify GTIN Exemption Proof or Supply GTIN for ${variantKey}`,
            severity: 'medium',
            status: 'pending_review',
            evidenceRequired: true,
            needsMerchantInput: true,
            evidenceProvided: 'Verified GTIN exemption evidence or valid GS1 GTIN required.',
            proposedChange: {
              field: `variants[${vIdx}].barcode`,
              from: 'declared_identifier_absence',
              to: '',
            },
            verificationStatus: 'unverified',
            auditLog: [],
          }));
          productFindingsCount++;
          return;
        }

        const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
          ruleSlug: 'gtin_missing',
          productId: p.id,
          variantId: v.id,
          variantIndex: vIdx,
        });
        const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

        findings.push({
          id: findingId,
          scope: 'product',
          productId: p.id,
          productTitle: p.title,
          type: 'missing_information',
          severity: 'critical',
          title: `Missing GTIN / Barcode — NEEDS_REVIEW (${variantKey})`,
          description: `Variant "${v.title || variantKey}" lacks a standard GTIN-8, GTIN-12 (UPC), GTIN-13 (EAN), or GTIN-14 barcode and has insufficient evidence for GTIN exemption.`,
          observedEvidence: `Variant barcode is empty on product "${p.title}" (insufficient evidence: missing barcode or title keywords do not prove exemption).`,
          derivedConclusion: 'NEEDS_REVIEW: Cannot assume GTIN exemption without verified evidence; shopping channels suppress products lacking valid GTINs unless legitimately exempt.',
          merchantVerified: prevAction?.status === 'approved',
          whyItMatters: 'Global identifiers like GTIN (UPC/EAN) are required for Google Merchant Center and marketplace indexing unless backed by verified exemption.',
          suggestedCorrection: 'Assign a valid GS1 GTIN barcode (GTIN-8, GTIN-12/UPC, GTIN-13/EAN, or GTIN-14), or attach verified GTIN exemption evidence.',
          targetField: `variants[${vIdx}].barcode`,
          currentValue: '(empty — NEEDS_REVIEW)',
          recommendedValue: '',
          actionItemId: actionId,
          ruleCode: 'RULE_VARIANT_GTIN_CHECK_DIGIT',
          needsMerchantInput: true,
          reviewStatus: 'NEEDS_REVIEW',
          gtinEligibilityStatus: 'insufficient_evidence',
        });

        actionItems.push(buildScopedActionItem(prevAction, {
          id: actionId,
          findingId,
          productId: p.id,
          productTitle: p.title,
          title: `Assign Valid GTIN Barcode to Variant ${variantKey}`,
          severity: 'critical',
          status: 'pending_review',
          evidenceRequired: true,
          needsMerchantInput: true,
          evidenceProvided: 'GS1-allocated GTIN (UPC/EAN) or verified exemption evidence required.',
          proposedChange: {
            field: `variants[${vIdx}].barcode`,
            from: '(empty)',
            to: '',
          },
          verificationStatus: 'unverified',
          auditLog: [],
        }));
        productFindingsCount++;
      } else {
        const gtinValidation = validateGtin(barcode);
        if (!gtinValidation.isValid) {
          const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
            ruleSlug: 'gtin_invalid',
            productId: p.id,
            variantId: v.id,
            variantIndex: vIdx,
          });
          const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });
          const formatLabel = gtinValidation.format ? `${gtinValidation.format} Check Digit` : 'GTIN / Barcode Format';

          findings.push({
            id: findingId,
            scope: 'product',
            productId: p.id,
            productTitle: p.title,
            type: 'inconsistent_attributes',
            severity: 'critical',
            title: `Invalid ${formatLabel} on Variant (${variantKey})`,
            description: gtinValidation.reason || `Barcode "${barcode}" fails GS1 GTIN validation.`,
            observedEvidence: `GS1 GTIN-8/12/13/14 validation rejected barcode "${barcode}": ${gtinValidation.reason || 'invalid checksum or length'}.`,
            derivedConclusion: 'Search engines reject feeds containing mathematically invalid or malformed GTIN barcodes.',
            merchantVerified: prevAction?.status === 'approved',
            whyItMatters: 'Invalid barcodes result in feed disapproval and merchant account warnings.',
            suggestedCorrection: 'Provide a valid GS1 GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN-13), or GTIN-14 barcode with accurate check digit.',
            targetField: `variants[${vIdx}].barcode`,
            currentValue: barcode,
            recommendedValue: '',
            actionItemId: actionId,
            ruleCode: 'RULE_VARIANT_GTIN_CHECK_DIGIT',
            needsMerchantInput: true,
            gtinEligibilityStatus: 'gtin_present',
          });

          actionItems.push(buildScopedActionItem(prevAction, {
            id: actionId,
            findingId,
            productId: p.id,
            productTitle: p.title,
            title: `Correct Barcode Check Digit on Variant ${variantKey}`,
            severity: 'critical',
            status: 'pending_review',
            evidenceRequired: true,
            needsMerchantInput: true,
            proposedChange: {
              field: `variants[${vIdx}].barcode`,
              from: barcode,
              to: '',
            },
            verificationStatus: 'unverified',
            auditLog: [],
          }));
          productFindingsCount++;
        }
      }
    });

    // Rule: Price presence
    recordRule('RULE_VARIANT_PRICE_PRESENCE');
    variants.forEach((v, vIdx) => {
      if (v.price === null || v.price === undefined || isNaN(v.price) || v.price < 0) {
        const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
          ruleSlug: 'price_invalid',
          productId: p.id,
          variantId: v.id,
          variantIndex: vIdx,
        });
        const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

        findings.push({
          id: findingId,
          scope: 'product',
          productId: p.id,
          productTitle: p.title,
          type: 'missing_information',
          severity: 'high',
          title: `Missing or Invalid Price on Variant (${v.sku || v.id})`,
          description: `Variant "${v.title || v.sku || v.id}" has no valid non-negative price.`,
          observedEvidence: `Price value is ${v.price === null ? 'null' : v.price}.`,
          derivedConclusion: 'Unpriced products cannot be purchased or listed on merchant feeds.',
          merchantVerified: prevAction?.status === 'approved',
          whyItMatters: 'Prices must be explicit, positive decimal numbers.',
          suggestedCorrection: 'Merchant input required: provide an authentic positive retail price.',
          targetField: `variants[${vIdx}].price`,
          currentValue: String(v.price),
          recommendedValue: '',
          actionItemId: actionId,
          ruleCode: 'RULE_VARIANT_PRICE_PRESENCE',
          needsMerchantInput: true,
        });

        actionItems.push(buildScopedActionItem(prevAction, {
          id: actionId,
          findingId,
          productId: p.id,
          productTitle: p.title,
          title: `Set Valid Price on Variant ${v.sku || v.id}`,
          severity: 'high',
          status: 'pending_review',
          evidenceRequired: false,
          needsMerchantInput: true,
          proposedChange: {
            field: `variants[${vIdx}].price`,
            from: String(v.price),
            to: '',
          },
          verificationStatus: 'unverified',
          auditLog: [],
        }));
        productFindingsCount++;
      }
    });

    // Rule: Product description
    recordRule('RULE_PRODUCT_DESCRIPTION_LENGTH');
    if (!p.description || p.description.trim().length < 15) {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: 'desc_short',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'missing_information',
        severity: 'medium',
        title: `Product Description Under Minimum Length (${p.title})`,
        description: 'Product lacks a substantive marketing and physical specification description.',
        observedEvidence: `Description length is ${p.description?.trim().length || 0} characters (minimum required: 15).`,
        derivedConclusion: 'Thin product descriptions lower semantic relevance for conversational product search.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Rich descriptions enable AI agents to match natural language consumer intent.',
        suggestedCorrection: 'Merchant input required: expand description with verified materials, dimensions, and usage instructions.',
        targetField: 'description',
        currentValue: p.description || '(empty)',
        actionItemId: actionId,
        ruleCode: 'RULE_PRODUCT_DESCRIPTION_LENGTH',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: `Expand Product Description for ${p.title}`,
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        needsMerchantInput: true,
        proposedChange: {
          field: 'description',
          from: p.description || '',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Brand specification
    recordRule('RULE_PRODUCT_BRAND_SPECIFICATION');
    if (!p.brand || p.brand.trim() === '' || p.brand.trim() === 'Unknown Brand' || p.brand.trim() === 'Unspecified') {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: 'brand_missing',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'missing_information',
        severity: 'high',
        title: `Missing Brand Specification on "${p.title}"`,
        description: 'Product vendor/brand is unspecified or placeholder.',
        observedEvidence: `Brand value is "${p.brand}".`,
        derivedConclusion: 'Shopping engines require canonical brand metadata to cluster product offers.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Brand is a mandatory field across all Google and Meta catalog specs.',
        suggestedCorrection: 'Merchant input required: specify legitimate manufacturer or authentic brand name.',
        targetField: 'brand',
        currentValue: p.brand || '(empty)',
        actionItemId: actionId,
        ruleCode: 'RULE_PRODUCT_BRAND_SPECIFICATION',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: `Assign Brand for ${p.title}`,
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: false,
        needsMerchantInput: true,
        proposedChange: {
          field: 'brand',
          from: p.brand || '',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Category taxonomy
    recordRule('RULE_PRODUCT_CATEGORY_TAXONOMY');
    if (!p.category || p.category.trim() === '' || p.category.trim() === 'General Merchandise') {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: 'cat_missing',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'missing_information',
        severity: 'medium',
        title: `Generic Category Taxonomy on "${p.title}"`,
        description: 'Product uses generic or empty category categorization instead of standard commerce taxonomy.',
        observedEvidence: `Category is "${p.category}".`,
        derivedConclusion: 'Unstructured categories hinder contextual feed filtering.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Precise taxonomy improves catalog discovery and ad campaign targeting.',
        suggestedCorrection: 'Merchant input required: assign standard hierarchical taxonomy path.',
        targetField: 'category',
        currentValue: p.category || '(empty)',
        actionItemId: actionId,
        ruleCode: 'RULE_PRODUCT_CATEGORY_TAXONOMY',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: `Refine Category Taxonomy for ${p.title}`,
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        needsMerchantInput: true,
        proposedChange: {
          field: 'category',
          from: p.category || '',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Primary Image
    recordRule('RULE_PRODUCT_IMAGE_ASSET');
    if (!p.image || p.image.trim() === '') {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: 'img_missing',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, { productId: p.id });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'missing_information',
        severity: 'high',
        title: `Missing Primary Image on "${p.title}"`,
        description: 'Product listing has no primary image URL.',
        observedEvidence: 'Image property is empty or whitespace.',
        derivedConclusion: 'Image-less products are rejected by visual and multimodal search engines.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Visual shopping feeds mandate at least one high-resolution hero photo.',
        suggestedCorrection: 'Merchant input required: upload an authentic product photography asset.',
        targetField: 'image',
        currentValue: '(none)',
        actionItemId: actionId,
        ruleCode: 'RULE_PRODUCT_IMAGE_ASSET',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: `Upload Primary Product Image for ${p.title}`,
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: false,
        needsMerchantInput: true,
        proposedChange: {
          field: 'image',
          from: '',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Dishwasher / Microwave safety attributes strictly scoped to Drinkware, Tableware, and Cookware
    recordRule('RULE_DISHWASHER_MICROWAVE_SAFETY');
    if (domainClass.isDrinkwareOrTableware) {
      const microwave = p.attributes?.microwaveSafe;
      if (!microwave || microwave.toLowerCase() === 'unspecified' || microwave.trim() === '') {
        const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
          ruleSlug: '02',
          productId: p.id,
        });
        const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, {
          productId: p.id,
          fallbackKeys: ['act_02'],
        });

        findings.push({
          id: findingId,
          scope: 'product',
          productId: p.id,
          productTitle: p.title,
          type: 'missing_information',
          severity: 'high',
          title: `Missing microwave safety specification on drinkware/tableware item "${p.title}"`,
          description: 'Product is categorized under drinkware, tableware, or cookware, but its thermal/microwave safety attribute is missing or unspecified.',
          observedEvidence: `Structured attribute \`microwaveSafe\`: "${microwave || 'Unspecified'}".`,
          derivedConclusion: 'Conversational shopping queries filter on microwave suitability.',
          merchantVerified: prevAction?.status === 'approved',
          whyItMatters: 'Conversational shopping queries filter on microwave capability; missing specs result in dropped recommendations.',
          suggestedCorrection: 'Merchant input required: verify and document thermal/microwave safety test results before specifying.',
          targetField: 'attributes.microwaveSafe',
          currentValue: microwave || 'Unspecified',
          recommendedValue: '',
          actionItemId: actionId,
          ruleCode: 'RULE_DISHWASHER_MICROWAVE_SAFETY',
          needsMerchantInput: true,
        });

        actionItems.push(buildScopedActionItem(prevAction, {
          id: actionId,
          findingId,
          productId: p.id,
          productTitle: p.title,
          title: 'Specify Microwave Safety in Structured Attributes',
          severity: 'high',
          status: 'pending_review',
          evidenceRequired: true,
          needsMerchantInput: true,
          proposedChange: {
            field: 'attributes.microwaveSafe',
            from: microwave || 'Unspecified',
            to: '',
          },
          verificationStatus: 'unverified',
          auditLog: [],
        }));
        productFindingsCount++;
      }
    }

    // Rule: Unverified Textile Evidence / Chemical Claims (e.g. OEKO-TEX)
    recordRule('RULE_UNVERIFIED_EVIDENCE_CLAIMS');
    const hasOekoTexClaim =
      (p.description || '').toLowerCase().includes('oeko-tex') ||
      (p.title || '').toLowerCase().includes('oeko-tex') ||
      Boolean(p.attributes?.oekoTexCertified);
    const hasVerifiedEvidenceDoc = (p.evidenceDocuments || []).some(
      (doc) => doc.status === 'verified' && (doc.title || '').toLowerCase().includes('oeko')
    );
    const hasUnverifiedOekoTex =
      hasOekoTexClaim &&
      !hasVerifiedEvidenceDoc &&
      (!p.attributes?.oekoTexCertified ||
        p.attributes.oekoTexCertified.toLowerCase().includes('unverified') ||
        p.attributes.oekoTexCertified.trim() === '');
    if (hasUnverifiedOekoTex) {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: '03',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, {
        productId: p.id,
        fallbackKeys: ['act_03'],
      });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'unverified_evidence',
        severity: 'high',
        title: `Unverified OEKO-TEX Standard 100 claim without registry number on "${p.title}"`,
        description: 'Product listing references OEKO-TEX certification, but lacks a verified certificate registry number or backing evidence document.',
        observedEvidence: 'Certification claim detected without a verified certificate ID or registry record in attached evidence.',
        derivedConclusion: 'AI evaluation engines flag unverified safety claims and score evidence coverage low.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Search models and commerce registries penalize unsubstantiated environmental or safety claims.',
        suggestedCorrection: 'Merchant input required: attach a verified third-party certification registry ID or remove unverified claims from product copy.',
        targetField: 'attributes.oekoTexCertified',
        currentValue: p.attributes?.oekoTexCertified || 'Standard 100 (Unverified)',
        recommendedValue: '',
        actionItemId: actionId,
        ruleCode: 'RULE_UNVERIFIED_EVIDENCE_CLAIMS',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: 'Attach Verified Certification Registry Number',
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: true,
        needsMerchantInput: true,
        proposedChange: {
          field: 'attributes.oekoTexCertified',
          from: p.attributes?.oekoTexCertified || 'Standard 100 (Unverified)',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Structured Coffee & Tea Brew Methods (consumable coffee/tea only, excludes mugs/tables/candles)
    recordRule('RULE_STRUCTURED_BREW_METHODS');
    if (domainClass.isConsumableCoffeeOrTea && (!p.attributes?.recommendedBrewMethods || p.attributes.recommendedBrewMethods === '(none)' || p.attributes.recommendedBrewMethods.trim() === '')) {
      const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
        ruleSlug: '05',
        productId: p.id,
      });
      const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, {
        productId: p.id,
        fallbackKeys: ['act_05'],
      });

      findings.push({
        id: findingId,
        scope: 'product',
        productId: p.id,
        productTitle: p.title,
        type: 'missing_information',
        severity: 'medium',
        title: `Recommended brewing equipment and grind suitability not structured on "${p.title}"`,
        description: 'Consumable coffee or tea listing lacks structured attributes for recommended brewing equipment and preparation methods.',
        observedEvidence: `Structured key \`recommendedBrewMethods\` is "${p.attributes?.recommendedBrewMethods || 'absent'}".`,
        derivedConclusion: 'AI shopping assistants filtering by brewer compatibility cannot reliably index this product via structured tags.',
        merchantVerified: prevAction?.status === 'approved',
        whyItMatters: 'Assistants parse structured tags more reliably than unstructured body prose.',
        suggestedCorrection: 'Merchant input required: specify verified brewing methods suited to this product roast and grind profile.',
        targetField: 'attributes.recommendedBrewMethods',
        currentValue: p.attributes?.recommendedBrewMethods || '(none)',
        recommendedValue: '',
        actionItemId: actionId,
        ruleCode: 'RULE_STRUCTURED_BREW_METHODS',
        needsMerchantInput: true,
      });

      actionItems.push(buildScopedActionItem(prevAction, {
        id: actionId,
        findingId,
        productId: p.id,
        productTitle: p.title,
        title: 'Add Structured Brew Method Suitability Array',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        needsMerchantInput: true,
        proposedChange: {
          field: 'attributes.recommendedBrewMethods',
          from: p.attributes?.recommendedBrewMethods || '(none)',
          to: '',
        },
        verificationStatus: 'unverified',
        auditLog: [],
      }));
      productFindingsCount++;
    }

    // Rule: Marketing headline/description burn-time claim vs structured technical burn-time attribute on candles
    recordRule('RULE_MARKETING_BURN_TIME_CONFLICT');
    const rawTechBurn = (p.attributes?.burnTime || p.attributes?.verifiedBurnTime || '').trim();
    if (domainClass.isCandleOrHomeFragrance && rawTechBurn) {
      const claimSource = `${p.title || ''} ${p.description || ''}`;
      const claimMatch = claimSource.match(/(\d{1,3})\s*(?:-\s*(\d{1,3}))?\s*(?:-|\s)?(?:hr|hrs|hour|hours|h)\b/i);
      const specMatch = rawTechBurn.match(/(\d{1,3})\s*(?:-\s*(\d{1,3}))?/);
      if (claimMatch && specMatch) {
        const claimedMin = parseInt(claimMatch[1], 10);
        const claimedMax = claimMatch[2] ? parseInt(claimMatch[2], 10) : claimedMin;
        const specMin = parseInt(specMatch[1], 10);
        const specMax = specMatch[2] ? parseInt(specMatch[2], 10) : specMin;
        // Flag conflict if marketing headline overstates or is disjoint from technical specification
        const hasConflict = claimedMax > specMax || claimedMin > specMax || claimedMax < specMin;
        if (hasConflict) {
          const { findingId, actionId: defaultActionId } = buildAuditEntityIds({
            ruleSlug: '07',
            productId: p.id,
          });
          const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId, {
            productId: p.id,
            fallbackKeys: ['act_07'],
          });
          const claimLabel = claimMatch[0].trim();

          findings.push({
            id: findingId,
            scope: 'product',
            productId: p.id,
            productTitle: p.title,
            type: 'conflicting_claims',
            severity: 'high',
            title: `Conflicting burn time stated in title vs technical attribute on "${p.title}"`,
            description: `Marketing copy states "${claimLabel}" while structured technical specification indicates "${rawTechBurn}".`,
            observedEvidence: `Headline/description claims "${claimLabel}", whereas structured burnTime attribute specifies "${rawTechBurn}".`,
            derivedConclusion: 'AI fact-checking algorithms identify internal conflict between marketing claims and technical data.',
            merchantVerified: prevAction?.status === 'approved',
            whyItMatters: 'Conflicting factual claims trigger confidence penalties in AI recommendation synthesis.',
            suggestedCorrection: 'Merchant input required: harmonize marketing copy and structured burn time to match verified lab testing.',
            targetField: 'title / marketing claims',
            currentValue: `${claimLabel} claim vs ${rawTechBurn} spec`,
            recommendedValue: '',
            actionItemId: actionId,
            ruleCode: 'RULE_MARKETING_BURN_TIME_CONFLICT',
            needsMerchantInput: true,
          });

          actionItems.push(buildScopedActionItem(prevAction, {
            id: actionId,
            findingId,
            productId: p.id,
            productTitle: p.title,
            title: `Reconcile "${claimLabel}" Marketing Claim with "${rawTechBurn}" Specification`,
            severity: 'high',
            status: 'pending_review',
            evidenceRequired: true,
            needsMerchantInput: true,
            proposedChange: {
              field: 'title / marketing claims',
              from: `${claimLabel} claim`,
              to: '',
            },
            verificationStatus: 'unverified',
            auditLog: [],
          }));
          productFindingsCount++;
        }
      }
    }

    // Update product stats
    const updatedProd: Product = {
      ...p,
      findingsCount: productFindingsCount,
      lastAudited: timestamp,
      completenessScore: calculateProductCompleteness(p),
    };
    updatedProducts.push(updatedProd);
  }

  // 2. Evaluate Catalog-wide & Store-level rules
  // Rule: Inconsistent Measurement Unit Policy
  recordRule('RULE_DUAL_UNIT_MEASUREMENT_POLICY');
  const unitPolicy = storeProfile.catalogPolicy?.units || '';
  if (products.length > 0 && unitPolicy.toLowerCase().includes('mixed')) {
    const { findingId, actionId: defaultActionId } = buildAuditEntityIds({ ruleSlug: '04' });
    const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId);

    findings.push({
      id: findingId,
      scope: 'catalog',
      type: 'inconsistent_attributes',
      severity: 'medium',
      title: 'Inconsistent weight and dimension units across catalog categories',
      description: 'Catalog measurement unit policy uses mixed single-system units without consistent dual Metric/Imperial tagging.',
      observedEvidence: `Store catalogPolicy.units is "${unitPolicy}".`,
      derivedConclusion: 'Cross-regional AI queries (e.g. US vs EU shoppers) encounter mismatched volume and weight filters.',
      merchantVerified: prevAction?.status === 'approved',
      whyItMatters: 'Standardized dual-unit specs ensure visibility across both US imperial and European metric shopping filters.',
      suggestedCorrection: 'Standardize catalog attribute format to include dual units (Metric and Imperial) where applicable.',
      targetField: 'store.catalogPolicy.units',
      currentValue: unitPolicy,
      recommendedValue: 'Dual-unit standard: Metric (Imperial)',
      actionItemId: actionId,
      ruleCode: 'RULE_DUAL_UNIT_MEASUREMENT_POLICY',
    });

    actionItems.push(buildScopedActionItem(prevAction, {
      id: actionId,
      findingId,
      title: 'Standardize Dual-Unit Volume & Weight Formatting',
      severity: 'medium',
      status: 'pending_review',
      evidenceRequired: false,
      proposedChange: {
        field: 'store.catalogPolicy.units',
        from: unitPolicy,
        to: 'Dual-unit standard: Metric (Imperial)',
      },
      verificationStatus: 'unverified',
      auditLog: [],
    }));
  }

  // Rule: Shipping SLA conflict between storefront and feed
  recordRule('RULE_SHIPPING_SLA_RECONCILIATION');
  const rawGmcSla = (storeProfile.shippingSla?.gmc || '').trim();
  const rawStorefrontSla = (storeProfile.shippingSla?.storefront || '').trim();
  const normGmcSla = rawGmcSla.toLowerCase();
  const normStorefrontSla = rawStorefrontSla.toLowerCase();
  const hasExplicitSlaConflict = Boolean(rawGmcSla && rawStorefrontSla && normGmcSla !== normStorefrontSla);
  const hasLegacyUnalignedGmcSla = Boolean(!rawStorefrontSla && normGmcSla.includes('3-5'));

  if (products.length > 0 && (hasExplicitSlaConflict || hasLegacyUnalignedGmcSla)) {
    const { findingId, actionId: defaultActionId } = buildAuditEntityIds({ ruleSlug: '06' });
    const { prevAction, actionId } = resolveExistingAction(findingId, defaultActionId);
    const hasKnownStorefront = Boolean(rawStorefrontSla);

    findings.push({
      id: findingId,
      scope: 'store',
      type: 'conflicting_claims',
      severity: 'critical',
      title: 'Discrepancy between storefront shipping policy and feed delivery SLA',
      description: hasKnownStorefront
        ? `Storefront policy states "${rawStorefrontSla}", whereas Google Merchant Center feed policy specifies "${rawGmcSla}".`
        : `Google Merchant Center feed SLA ("${rawGmcSla}") has not been reconciled with the verified storefront delivery SLA.`,
      observedEvidence: hasKnownStorefront
        ? `Storefront policy: "${rawStorefrontSla}". GMC feed metadata: "${rawGmcSla}".`
        : `GMC feed metadata specifies "${rawGmcSla}" with unverified storefront SLA parity.`,
      derivedConclusion: 'External shopping portals penalize merchant trust scores when shipping speed claims conflict.',
      merchantVerified: prevAction?.status === 'approved',
      whyItMatters: 'Google and AI shopping agents check delivery speed consistency across merchant feeds and storefront pages.',
      suggestedCorrection: hasKnownStorefront
        ? `Align Google Merchant Center feed SLA to match storefront ("${rawStorefrontSla}").`
        : 'Merchant input required: configure Google Merchant Center feed SLA to match your published storefront delivery policy.',
      targetField: 'connectors.gmc.shipping_sla',
      currentValue: rawGmcSla,
      recommendedValue: rawStorefrontSla,
      actionItemId: actionId,
      ruleCode: 'RULE_SHIPPING_SLA_RECONCILIATION',
      needsMerchantInput: !hasKnownStorefront,
    });

    actionItems.push(buildScopedActionItem(prevAction, {
      id: actionId,
      findingId,
      title: hasKnownStorefront
        ? `Reconcile Storefront (${rawStorefrontSla}) Shipping SLA with GMC Feed`
        : 'Reconcile Storefront Shipping SLA with GMC Feed',
      severity: 'critical',
      status: 'pending_review',
      evidenceRequired: true,
      needsMerchantInput: !hasKnownStorefront,
      proposedChange: {
        field: 'connectors.gmc.shipping_sla',
        from: rawGmcSla,
        to: rawStorefrontSla,
      },
      verificationStatus: 'unverified',
      auditLog: [],
    }));
  }

  // Calculate actual completeness
  const completenessAvg = calculateStoreCompletenessAvg(updatedProducts);

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;
  const lowCount = findings.filter(f => f.severity === 'low').length;

  const totalRulesEvaluated = Object.values(ruleCounts).reduce((acc, c) => acc + c, 0);

  const summary: AuditRunSummary = {
    catalogCompletenessAvg: completenessAvg,
    totalProducts: products.length,
    totalVariants,
    criticalFindingsCount: criticalCount,
    highFindingsCount: highCount,
    mediumFindingsCount: mediumCount,
    lowFindingsCount: lowCount,
    totalFindingsCount: findings.length,
    totalActionsCount: actionItems.length,
    rulesEvaluated: totalRulesEvaluated,
    ruleBreakdown: ruleCounts,
  };

  const updatedStoreProfile: StoreProfile = {
    ...storeProfile,
    catalogCompletenessAvg: completenessAvg,
    lastAuditDate: timestamp,
  };

  return {
    findings,
    actionItems,
    summary,
    updatedStoreProfile,
    updatedProducts,
    rulesEvaluated: totalRulesEvaluated,
  };
}
