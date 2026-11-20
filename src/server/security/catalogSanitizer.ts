import crypto from 'node:crypto';
import {
  EvidenceDocument,
  EvidencePurpose,
  Product,
  ProductCandidate,
  ShopifyProductProvenanceRecord,
} from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import {
  TrustedGtinExemptionProof,
  TrustedGtinVerificationContext,
  TrustedShopifyGiftCardProof,
} from '../../domain/audit/categoryApplicability';
import { ShopifyConnectionRecord } from '../shopify/types';
import { normalizeShopDomain } from '../shopify/client';

export class ProtectedVerificationFieldError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'PROTECTED_VERIFICATION_FIELD';

  constructor(message: string) {
    super(message);
    this.name = 'ProtectedVerificationFieldError';
  }
}

export const PROTECTED_GTIN_ATTRIBUTE_KEYS = new Set([
  'gtinExemptionVerified',
  'gtinExemptionEvidenceRef',
  'gtinExemptionStatus',
  'shopifyIsGiftCard',
  'shopifyGiftCardVerifiedAt',
  'shopifyShopDomain',
]);

export const SERVER_SHOPIFY_PROVENANCE_VALUES = new Set([
  'shopify_graphql_admin_api',
  'shopify_webhook',
]);

function normalizeBoolStr(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val !== 'string') return false;
  const v = val.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

export function computeEvidenceIntegrityHash(
  workspaceId: string,
  productId: string,
  doc: Pick<EvidenceDocument, 'id' | 'title' | 'type' | 'issuer' | 'dateVerified' | 'url' | 'evidencePurpose'>
): string {
  const canonical = JSON.stringify({
    workspaceId: String(workspaceId || ''),
    productId: String(productId || ''),
    id: String(doc.id || ''),
    title: String(doc.title || '').trim(),
    type: String(doc.type || '').trim(),
    issuer: String(doc.issuer || '').trim(),
    dateVerified: String(doc.dateVerified || '').trim(),
    url: String(doc.url || '').trim(),
    evidencePurpose: String(doc.evidencePurpose || 'general'),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function evidenceContentMatches(
  incoming: EvidenceDocument,
  existing: EvidenceDocument
): boolean {
  return (
    incoming.id === existing.id &&
    String(incoming.title || '').trim() === String(existing.title || '').trim() &&
    String(incoming.type || '').trim() === String(existing.type || '').trim() &&
    String(incoming.issuer || '').trim() === String(existing.issuer || '').trim() &&
    String(incoming.dateVerified || '').trim() === String(existing.dateVerified || '').trim() &&
    String(incoming.url || '').trim() === String(existing.url || '').trim() &&
    String(incoming.evidencePurpose || existing.evidencePurpose || 'general') ===
      String(existing.evidencePurpose || 'general')
  );
}

/**
 * Inspects and sanitizes a client-submitted catalog write payload (`PUT /api/catalog`):
 * - Rejects explicit attempts to forge `gtinExemptionVerified`, `gtinExemptionEvidenceRef`,
 *   `shopifyIsGiftCard`, forged Shopify Admin/webhook provenance, or new/modified `verified` evidence.
 * - Preserves existing server-owned verified evidence records ONLY when unchanged & bound to the same product.
 * - Preserves server-owned Shopify provenance (`shopify_product_provenance`) without trusting client flags.
 */
export function inspectAndSanitizeClientCatalogPut(
  workspaceId: string,
  incomingPayload: StoragePayloadV1,
  existingCatalog: StoragePayloadV1 | null,
  shopifyProvenanceList: ShopifyProductProvenanceRecord[],
  options: { rejectOnTampering?: boolean } = { rejectOnTampering: true }
): StoragePayloadV1 {
  const reject = options.rejectOnTampering !== false;
  const existingProductMap = new Map<string, Product>();
  const existingEvidenceMap = new Map<string, { doc: EvidenceDocument; productId: string }>();

  for (const ep of existingCatalog?.products || []) {
    existingProductMap.set(ep.id, ep);
    for (const ed of ep.evidenceDocuments || []) {
      existingEvidenceMap.set(ed.id, { doc: ed, productId: ep.id });
    }
  }

  const provenanceByProductId = new Map<string, ShopifyProductProvenanceRecord>();
  for (const prov of shopifyProvenanceList) {
    if (prov.workspaceId === workspaceId) {
      provenanceByProductId.set(prov.productId, prov);
    }
  }

  const cleanPayload: StoragePayloadV1 = JSON.parse(JSON.stringify(incomingPayload));
  const sanitizedProducts: Product[] = [];

  for (const p of cleanPayload.products || []) {
    const existingProduct = existingProductMap.get(p.id);
    const serverProvenance = provenanceByProductId.get(p.id);
    const rawAttrs = (p.attributes && typeof p.attributes === 'object' ? { ...p.attributes } : {}) as Record<string, string>;
    const existingAttrs = existingProduct?.attributes || {};

    // 1. Detect forged protected GTIN / Shopify gift-card attributes
    for (const key of PROTECTED_GTIN_ATTRIBUTE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rawAttrs, key)) {
        const incomingVal = rawAttrs[key];
        const serverAllowsGiftCard =
          key === 'shopifyIsGiftCard' &&
          serverProvenance?.isGiftCard === true &&
          normalizeBoolStr(incomingVal) &&
          String(rawAttrs.sourceProductId || '') === serverProvenance.shopifyProductId;
        const matchesExistingServerAttr =
          existingProduct &&
          incomingVal === existingAttrs[key] &&
          (key !== 'shopifyIsGiftCard' || serverProvenance?.isGiftCard === true);

        if (!serverAllowsGiftCard && !matchesExistingServerAttr && String(incomingVal ?? '').trim() !== '') {
          if (reject) {
            throw new ProtectedVerificationFieldError(
              `Forbidden: "${key}" is a server-controlled verification field and cannot be set or forged by clients.`
            );
          }
        }
        delete rawAttrs[key];
      }
    }

    // 2. Prevent spoofing authoritative Shopify Admin / Webhook provenance via client PUT
    if (
      typeof rawAttrs.provenance === 'string' &&
      SERVER_SHOPIFY_PROVENANCE_VALUES.has(rawAttrs.provenance.trim())
    ) {
      const hasMatchingServerProvenance =
        Boolean(serverProvenance) &&
        String(rawAttrs.sourceProductId || '') === serverProvenance!.shopifyProductId &&
        String(rawAttrs.shopifyGid || '') === serverProvenance!.shopifyGid;
      const hasMatchingExistingProduct =
        Boolean(existingProduct) &&
        existingAttrs.provenance === rawAttrs.provenance &&
        existingAttrs.sourceProductId === rawAttrs.sourceProductId &&
        existingAttrs.shopifyGid === rawAttrs.shopifyGid;

      if (!hasMatchingServerProvenance && !hasMatchingExistingProduct) {
        if (reject) {
          throw new ProtectedVerificationFieldError(
            'Forbidden: Shopify Admin API / Webhook provenance cannot be forged by client payloads.'
          );
        }
        delete rawAttrs.provenance;
      }
    }

    // Re-attach authentic server-owned Shopify gift-card metadata only if backed by server provenance
    if (
      serverProvenance?.isGiftCard &&
      String(rawAttrs.sourceProductId || serverProvenance.shopifyProductId) === serverProvenance.shopifyProductId &&
      String(rawAttrs.shopifyGid || serverProvenance.shopifyGid) === serverProvenance.shopifyGid
    ) {
      rawAttrs.shopifyIsGiftCard = 'true';
      rawAttrs.shopifyShopDomain = serverProvenance.shopDomain;
      rawAttrs.shopifyGiftCardVerifiedAt = serverProvenance.verifiedAt;
    }

    // 3. Validate & sanitize evidenceDocuments on product
    const nextDocs: EvidenceDocument[] = [];
    for (const rawDoc of p.evidenceDocuments || []) {
      if (!rawDoc || typeof rawDoc !== 'object' || !rawDoc.id) continue;
      const existingEntry = existingEvidenceMap.get(rawDoc.id);
      const isSameProductAndContent =
        Boolean(existingEntry) &&
        existingEntry!.productId === p.id &&
        evidenceContentMatches(rawDoc, existingEntry!.doc);

      const clientClaimsVerified = rawDoc.status === 'verified' || rawDoc.decision === 'approved';
      const clientSuppliesServerReviewer =
        Boolean(rawDoc.verifiedBy && rawDoc.verifiedBy !== existingEntry?.doc.verifiedBy) ||
        Boolean(rawDoc.reviewedAt && rawDoc.reviewedAt !== existingEntry?.doc.reviewedAt) ||
        (rawDoc.verificationSource !== undefined &&
          rawDoc.verificationSource !== 'client_submission' &&
          rawDoc.verificationSource !== existingEntry?.doc.verificationSource) ||
        Boolean(rawDoc.integrityHash && rawDoc.integrityHash !== existingEntry?.doc.integrityHash);

      if (isSameProductAndContent && existingEntry!.doc.status === 'verified') {
        if (clientSuppliesServerReviewer) {
          if (reject) {
            throw new ProtectedVerificationFieldError(
              'Forbidden: evidence reviewer metadata and integrityHash are server-controlled fields.'
            );
          }
        }
        // Preserve authentic server-owned verified record untouched
        nextDocs.push({ ...existingEntry!.doc });
        continue;
      }

      if (clientClaimsVerified || clientSuppliesServerReviewer) {
        if (reject) {
          throw new ProtectedVerificationFieldError(
            `Forbidden: evidence document "${rawDoc.id}" cannot be marked verified or assigned reviewer metadata by a client.`
          );
        }
      }

      const purpose: EvidencePurpose =
        rawDoc.evidencePurpose === 'gtin_exemption' ||
        rawDoc.evidencePurpose === 'product_claim' ||
        rawDoc.evidencePurpose === 'general'
          ? rawDoc.evidencePurpose
          : 'general';

      const sanitizedStatus =
        rawDoc.status === 'unverified' || rawDoc.status === 'expired' ? rawDoc.status : 'pending';

      const cleanDoc: EvidenceDocument = {
        id: String(rawDoc.id).trim(),
        title: String(rawDoc.title || '').trim(),
        type: rawDoc.type,
        issuer: String(rawDoc.issuer || '').trim(),
        dateVerified: String(rawDoc.dateVerified || '').trim(),
        url: rawDoc.url ? String(rawDoc.url).trim() : undefined,
        status: sanitizedStatus,
        evidencePurpose: purpose,
        verificationSource: 'client_submission',
        decision: 'pending',
        createdAt: existingEntry?.doc.createdAt || new Date().toISOString(),
      };
      cleanDoc.integrityHash = computeEvidenceIntegrityHash(workspaceId, p.id, cleanDoc);
      nextDocs.push(cleanDoc);
    }

    sanitizedProducts.push({
      ...p,
      attributes: rawAttrs,
      evidenceDocuments: nextDocs,
    });
  }

  // 4. Reject top-level payload.evidence smuggling (evidence must match product-owned sanitized docs)
  const productDocIds = new Set(sanitizedProducts.flatMap((p) => p.evidenceDocuments.map((d) => d.id)));
  for (const topDoc of cleanPayload.evidence || []) {
    if (!topDoc || typeof topDoc !== 'object' || !topDoc.id) continue;
    const existingEntry = existingEvidenceMap.get(topDoc.id);
    const clientClaimsVerified = topDoc.status === 'verified' || (topDoc as any).decision === 'approved';
    const isUnchangedServerVerified =
      Boolean(existingEntry) &&
      existingEntry!.doc.status === 'verified' &&
      productDocIds.has(topDoc.id) &&
      evidenceContentMatches(topDoc, existingEntry!.doc);

    if (clientClaimsVerified && !isUnchangedServerVerified) {
      if (reject) {
        throw new ProtectedVerificationFieldError(
          `Forbidden: top-level evidence "${topDoc.id}" cannot claim verified status via client payload.`
        );
      }
    }
  }

  cleanPayload.products = sanitizedProducts;
  cleanPayload.variants = sanitizedProducts.flatMap((p) => p.variants || []);
  cleanPayload.offers = sanitizedProducts.flatMap((p) => p.offers || []);
  cleanPayload.evidence = sanitizedProducts.flatMap((p) => p.evidenceDocuments || []);
  return cleanPayload;
}

/**
 * Inspects and sanitizes client-supplied import candidates (`POST /api/catalog/import`):
 * - Blocks client-forged GTIN exemptions, gift-card flags, Shopify Admin provenance, or verified evidence.
 * - Strips protected fields cleanly so imported items always start unverified/NEEDS_REVIEW unless barcode valid.
 */
export function sanitizeAndValidateImportCandidates(
  workspaceId: string,
  candidates: ProductCandidate[],
  options: { rejectOnTampering?: boolean } = { rejectOnTampering: true }
): ProductCandidate[] {
  const reject = options.rejectOnTampering !== false;
  const sanitized: ProductCandidate[] = [];

  for (const candidate of candidates || []) {
    const rawAttrs =
      candidate.attributes && typeof candidate.attributes === 'object'
        ? { ...candidate.attributes }
        : {};

    for (const key of PROTECTED_GTIN_ATTRIBUTE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rawAttrs, key) && String(rawAttrs[key] ?? '').trim() !== '') {
        if (reject) {
          throw new ProtectedVerificationFieldError(
            `Forbidden: candidate import cannot set server-controlled verification field "${key}".`
          );
        }
        delete rawAttrs[key];
      }
    }

    if (
      typeof rawAttrs.provenance === 'string' &&
      SERVER_SHOPIFY_PROVENANCE_VALUES.has(rawAttrs.provenance.trim())
    ) {
      if (reject) {
        throw new ProtectedVerificationFieldError(
          'Forbidden: candidate import cannot forge Shopify Admin API / Webhook provenance.'
        );
      }
      rawAttrs.provenance = 'merchant_import';
    }

    const nextDocs: EvidenceDocument[] = [];
    for (const rawDoc of candidate.evidenceDocuments || []) {
      if (!rawDoc || typeof rawDoc !== 'object' || !rawDoc.id) continue;
      if (
        rawDoc.status === 'verified' ||
        rawDoc.decision === 'approved' ||
        Boolean(rawDoc.verifiedBy) ||
        Boolean(rawDoc.reviewedAt) ||
        (rawDoc.verificationSource && rawDoc.verificationSource !== 'client_submission')
      ) {
        if (reject) {
          throw new ProtectedVerificationFieldError(
            `Forbidden: imported evidence "${rawDoc.id}" cannot claim verified or reviewer-approved status.`
          );
        }
      }
      const purpose: EvidencePurpose =
        rawDoc.evidencePurpose === 'gtin_exemption' ||
        rawDoc.evidencePurpose === 'product_claim' ||
        rawDoc.evidencePurpose === 'general'
          ? rawDoc.evidencePurpose
          : 'general';
      const cleanDoc: EvidenceDocument = {
        id: String(rawDoc.id).trim(),
        title: String(rawDoc.title || '').trim(),
        type: rawDoc.type,
        issuer: String(rawDoc.issuer || '').trim(),
        dateVerified: String(rawDoc.dateVerified || '').trim(),
        url: rawDoc.url ? String(rawDoc.url).trim() : undefined,
        status: rawDoc.status === 'unverified' || rawDoc.status === 'expired' ? rawDoc.status : 'pending',
        evidencePurpose: purpose,
        verificationSource: 'client_submission',
        decision: 'pending',
        createdAt: new Date().toISOString(),
      };
      cleanDoc.integrityHash = computeEvidenceIntegrityHash(workspaceId, candidate.id, cleanDoc);
      nextDocs.push(cleanDoc);
    }

    sanitized.push({
      ...candidate,
      attributes: rawAttrs,
      evidenceDocuments: nextDocs,
    });
  }

  return sanitized;
}

/**
 * Builds TrustedGtinVerificationContext strictly from server-persisted workspace records:
 * 1. Verified GTIN exemption evidence attached to non-deleted workspace products whose
 *    reviewer provenance, approval decision, and SHA-256 integrityHash all validate cleanly.
 * 2. Server-owned Shopify Gift Card provenance bound to an active Shopify connection matching
 *    workspaceId, shopDomain, and immutable Shopify product IDs.
 */
export function buildTrustedGtinVerificationContext(
  workspaceId: string,
  products: Product[],
  shopifyConnection: ShopifyConnectionRecord | null,
  shopifyProvenanceList: ShopifyProductProvenanceRecord[]
): TrustedGtinVerificationContext {
  const verifiedExemptionByProductId = new Map<string, TrustedGtinExemptionProof>();
  const verifiedGiftCardByProductId = new Map<string, TrustedShopifyGiftCardProof>();

  const productById = new Map<string, Product>();
  for (const p of products || []) {
    productById.set(p.id, p);

    for (const doc of p.evidenceDocuments || []) {
      if (
        !doc ||
        doc.status !== 'verified' ||
        doc.decision !== 'approved' ||
        doc.evidencePurpose !== 'gtin_exemption' ||
        (doc.verificationSource !== 'server_reviewer' && doc.verificationSource !== 'external_registry') ||
        !doc.verifiedBy?.trim() ||
        !doc.reviewedAt?.trim() ||
        !doc.integrityHash?.trim()
      ) {
        continue;
      }

      const expectedHash = computeEvidenceIntegrityHash(workspaceId, p.id, doc);
      if (doc.integrityHash !== expectedHash) {
        continue;
      }

      verifiedExemptionByProductId.set(p.id, {
        evidenceId: doc.id,
        reference: doc.id,
        verifiedBy: doc.verifiedBy,
        reviewedAt: doc.reviewedAt,
        integrityHash: doc.integrityHash,
        sourceType: doc.verificationSource,
      });
      break;
    }
  }

  const connectedShopDomain =
    shopifyConnection && shopifyConnection.status === 'connected'
      ? normalizeShopDomain(shopifyConnection.shopDomain)
      : '';

  if (connectedShopDomain) {
    for (const prov of shopifyProvenanceList || []) {
      if (
        prov.workspaceId !== workspaceId ||
        prov.isGiftCard !== true ||
        normalizeShopDomain(prov.shopDomain) !== connectedShopDomain ||
        !prov.shopifyProductId?.trim() ||
        !prov.shopifyGid?.trim() ||
        !prov.verifiedAt?.trim()
      ) {
        continue;
      }

      const prod = productById.get(prov.productId);
      if (!prod) continue;

      const prodSourceId = String(prod.attributes?.sourceProductId || '').trim();
      const prodGid = String(prod.attributes?.shopifyGid || '').trim();
      if (prodSourceId && prodSourceId !== prov.shopifyProductId) continue;
      if (prodGid && prodGid !== prov.shopifyGid) continue;

      verifiedGiftCardByProductId.set(prov.productId, {
        shopDomain: connectedShopDomain,
        shopifyProductId: prov.shopifyProductId,
        shopifyGid: prov.shopifyGid,
        isGiftCard: true,
        sourceType: prov.sourceType,
        verifiedAt: prov.verifiedAt,
        shopifyUpdatedAt: prov.shopifyUpdatedAt,
      });
    }
  }

  return {
    workspaceId,
    verifiedExemptionByProductId,
    verifiedGiftCardByProductId,
  };
}
