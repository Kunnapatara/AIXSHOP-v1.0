import crypto from 'node:crypto';
import {
  GuestTransferAuthorizationRecord,
  GuestTransferAuthorizationResponse,
  GuestTransferCommitResult,
  GuestTransferConflict,
  GuestTransferConflictStrategy,
  GuestTransferStatusResponse,
  detectGuestCatalogConflicts,
  mergeGuestCatalogNonDestructively,
  normalizeGuestSourceClassification,
} from '../../domain/catalog/guestTransfer';
import { initialProducts } from '../../data/mockData';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { EvidenceDocument, EvidencePurpose, Product, StoreSourceClassification } from '../../types';
import { DatabaseRepository } from '../db/repository';
import {
  PROTECTED_GTIN_ATTRIBUTE_KEYS,
  ProtectedVerificationFieldError,
  SERVER_SHOPIFY_PROVENANCE_VALUES,
  computeEvidenceIntegrityHash,
} from '../security/catalogSanitizer';
import { checkPlanQuota, countCatalogSkus } from './entitlementService';

export const GUEST_TRANSFER_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes short-lived single-use window
export const MAX_GUEST_TRANSFER_PRODUCTS = 2500;

export class GuestTransferError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly conflicts?: GuestTransferConflict[];

  constructor(
    message: string,
    code: string,
    statusCode: number,
    conflicts?: GuestTransferConflict[]
  ) {
    super(message);
    this.name = 'GuestTransferError';
    this.code = code;
    this.statusCode = statusCode;
    this.conflicts = conflicts;
  }
}

export function hashGuestTransferToken(token: string): string {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSortValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = stableSortValue(v);
      }
    }
    return out;
  }
  return value;
}

export function computeGuestPayloadSha256(payload: StoragePayloadV1): string {
  const normalized = stableSortValue({
    products: (payload.products || []).map(p => ({
      id: p.id,
      title: p.title,
      brand: p.brand,
      category: p.category,
      description: p.description,
      image: p.image,
      status: p.status,
      sourceClassification: p.sourceClassification,
      sourceOrigin: p.sourceOrigin,
      acquisitionMethod: p.acquisitionMethod,
      attributes: p.attributes || {},
      variants: (p.variants || []).map(v => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        barcode: v.barcode || '',
        price: v.price,
        inventoryCount: v.inventoryCount ?? null,
        attributes: v.attributes || {},
      })),
      offers: p.offers || [],
      evidenceDocuments: (p.evidenceDocuments || []).map(d => ({
        id: d.id,
        title: d.title,
        type: d.type,
        issuer: d.issuer,
        dateVerified: d.dateVerified,
        url: d.url || '',
        evidencePurpose: d.evidencePurpose || 'general',
        status: d.status,
      })),
    })),
    findings: payload.findings || [],
    actions: payload.actions || [],
    storeProfile: payload.storeProfile
      ? {
          name: payload.storeProfile.name,
          domain: payload.storeProfile.domain,
          websiteUrl: payload.storeProfile.websiteUrl,
          platform: payload.storeProfile.platform,
          sourceClassification: payload.storeProfile.sourceClassification,
          currency: payload.storeProfile.currency,
        }
      : null,
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

const KNOWN_DEMO_VERIFIED_DOCS = new Map<
  string,
  { productId: string; title: string; type: string; issuer: string }
>();
for (const sp of initialProducts) {
  for (const sd of sp.evidenceDocuments || []) {
    if (sd.status === 'verified') {
      KNOWN_DEMO_VERIFIED_DOCS.set(sd.id, {
        productId: sp.id,
        title: String(sd.title || '').trim(),
        type: String(sd.type || '').trim(),
        issuer: String(sd.issuer || '').trim(),
      });
    }
  }
}

export function sanitizeGuestTransferPayload(
  workspaceId: string,
  userId: string,
  rawPayload: unknown
): StoragePayloadV1 {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new GuestTransferError('Invalid guest catalog payload.', 'INVALID_GUEST_PAYLOAD', 400);
  }

  const p = rawPayload as StoragePayloadV1;
  if (!Array.isArray(p.products) || p.products.length === 0) {
    throw new GuestTransferError(
      'Guest catalog must contain at least one product to transfer.',
      'EMPTY_GUEST_CATALOG',
      400
    );
  }
  if (p.products.length > MAX_GUEST_TRANSFER_PRODUCTS) {
    throw new GuestTransferError(
      `Guest transfer exceeds maximum limit of ${MAX_GUEST_TRANSFER_PRODUCTS} products per transfer.`,
      'BATCH_LIMIT_EXCEEDED',
      413
    );
  }

  const storeSourceFallback = normalizeGuestSourceClassification(
    p.storeProfile?.sourceClassification,
    'manual_import'
  );

  if (
    p.storeProfile &&
    ((p.storeProfile as any).sourceClassification === 'shopify_oauth' ||
      (p.storeProfile as any).shopifyConnected === true)
  ) {
    throw new ProtectedVerificationFieldError(
      'Forbidden: guest transfer cannot assert "shopify_oauth" or shopifyConnected store provenance.'
    );
  }

  const nowIso = new Date().toISOString();
  const sanitizedProducts: Product[] = [];

  for (const rawProd of p.products) {
    if (!rawProd || typeof rawProd !== 'object' || !String(rawProd.id || '').trim() || !String(rawProd.title || '').trim()) {
      throw new GuestTransferError(
        'Each guest product must include a valid id and title.',
        'INVALID_GUEST_PRODUCT',
        400
      );
    }

    const rawAttrs =
      rawProd.attributes && typeof rawProd.attributes === 'object' ? { ...rawProd.attributes } : {};

    for (const key of PROTECTED_GTIN_ATTRIBUTE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rawAttrs, key) && String(rawAttrs[key] ?? '').trim() !== '') {
        throw new ProtectedVerificationFieldError(
          `Forbidden: guest transfer cannot set server-controlled verification field "${key}".`
        );
      }
      delete rawAttrs[key];
    }

    if (
      typeof rawAttrs.provenance === 'string' &&
      SERVER_SHOPIFY_PROVENANCE_VALUES.has(rawAttrs.provenance.trim())
    ) {
      throw new ProtectedVerificationFieldError(
        'Forbidden: guest transfer cannot forge Shopify Admin API or Webhook provenance.'
      );
    }

    const rawSourceClass = (rawProd as any).sourceClassification;
    const rawAcquisition = (rawProd as any).acquisitionMethod;
    if (
      rawSourceClass === 'shopify_oauth' ||
      rawAcquisition === 'shopify_admin_graphql' ||
      rawAcquisition === 'shopify_webhook'
    ) {
      throw new ProtectedVerificationFieldError(
        'Forbidden: guest/demo/manual-import records cannot be classified as "shopify_oauth" or Shopify Admin/Webhook imports.'
      );
    }

    const safeClass = normalizeGuestSourceClassification(rawSourceClass, storeSourceFallback);
    const safeOrigin =
      typeof rawProd.sourceOrigin === 'string' && rawProd.sourceOrigin.trim()
        ? rawProd.sourceOrigin.trim()
        : p.storeProfile?.domain || p.storeProfile?.websiteUrl || '';
    const safeAcq =
      rawAcquisition === 'demo_fixture' ||
      rawAcquisition === 'public_products_json_sample' ||
      rawAcquisition === 'manual_import'
        ? rawAcquisition
        : safeClass === 'demo'
        ? 'demo_fixture'
        : safeClass === 'public_feed'
        ? 'public_products_json_sample'
        : 'manual_import';

    const nextDocs: EvidenceDocument[] = [];
    for (const rawDoc of rawProd.evidenceDocuments || []) {
      if (!rawDoc || typeof rawDoc !== 'object' || !String(rawDoc.id || '').trim()) continue;
      const docId = String(rawDoc.id).trim();
      const docTitle = String(rawDoc.title || '').trim();
      const docIssuer = String(rawDoc.issuer || '').trim();
      const docType = String(rawDoc.type || '').trim();

      if (
        rawDoc.externalVerificationStatus === 'external_registry_verified' ||
        rawDoc.verificationSource === 'external_registry' ||
        Boolean(rawDoc.externalProviderName) ||
        Boolean(rawDoc.externalProviderRef)
      ) {
        throw new ProtectedVerificationFieldError(
          `Forbidden: guest evidence "${docId}" cannot claim external registry verification.`
        );
      }

      const knownSeed = KNOWN_DEMO_VERIFIED_DOCS.get(docId);
      const isAuthenticSeedDoc =
        safeClass === 'demo' &&
        Boolean(knownSeed) &&
        knownSeed!.productId === rawProd.id &&
        knownSeed!.title === docTitle &&
        knownSeed!.type === docType &&
        knownSeed!.issuer === docIssuer &&
        rawDoc.status === 'verified' &&
        rawDoc.evidencePurpose !== 'gtin_exemption';

      if (!isAuthenticSeedDoc) {
        if (
          rawDoc.status === 'verified' ||
          rawDoc.decision === 'approved' ||
          Boolean(rawDoc.verifiedBy) ||
          Boolean(rawDoc.reviewedAt) ||
          Boolean(rawDoc.reviewerPrincipalType) ||
          (rawDoc.externalVerificationStatus && rawDoc.externalVerificationStatus !== 'not_externally_verified') ||
          (rawDoc.verificationSource && rawDoc.verificationSource !== 'client_submission')
        ) {
          throw new ProtectedVerificationFieldError(
            `Forbidden: guest evidence "${docId}" cannot pre-approve or forge verified/reviewer trust metadata.`
          );
        }
      }

      const purpose: EvidencePurpose = isAuthenticSeedDoc
        ? 'product_claim'
        : rawDoc.evidencePurpose === 'gtin_exemption' ||
          rawDoc.evidencePurpose === 'product_claim' ||
          rawDoc.evidencePurpose === 'general'
        ? rawDoc.evidencePurpose
        : 'general';

      const cleanDoc: EvidenceDocument = isAuthenticSeedDoc
        ? {
            id: docId,
            title: docTitle,
            type: rawDoc.type,
            issuer: docIssuer,
            dateVerified: String(rawDoc.dateVerified || '').trim(),
            url: rawDoc.url ? String(rawDoc.url).trim() : undefined,
            status: 'verified',
            evidencePurpose: 'product_claim',
            verificationSource: 'server_reviewer',
            externalVerificationStatus: 'reviewer_verified',
            reviewerPrincipalType: 'service_principal',
            reviewerAuthMethod: 'demo_seed',
            decision: 'approved',
            verifiedBy: 'demo_seed',
            reviewedAt: nowIso,
            createdAt: nowIso,
          }
        : {
            id: docId,
            title: docTitle,
            type: rawDoc.type,
            issuer: docIssuer,
            dateVerified: String(rawDoc.dateVerified || '').trim(),
            url: rawDoc.url ? String(rawDoc.url).trim() : undefined,
            status: rawDoc.status === 'unverified' || rawDoc.status === 'expired' ? rawDoc.status : 'pending',
            evidencePurpose: purpose,
            verificationSource: 'client_submission',
            externalVerificationStatus: 'not_externally_verified',
            submittedByUserId: userId,
            decision: 'pending',
            createdAt: nowIso,
          };

      cleanDoc.integrityHash = computeEvidenceIntegrityHash(workspaceId, rawProd.id, cleanDoc);
      nextDocs.push(cleanDoc);
    }

    sanitizedProducts.push({
      ...rawProd,
      id: String(rawProd.id).trim(),
      title: String(rawProd.title).trim(),
      brand: String(rawProd.brand || 'Unbranded').trim() || 'Unbranded',
      category: String(rawProd.category || 'General').trim() || 'General',
      description: String(rawProd.description || ''),
      image: String(rawProd.image || ''),
      status: rawProd.status || 'active',
      sourceClassification: safeClass,
      sourceOrigin: safeOrigin,
      acquisitionMethod: safeAcq,
      attributes: rawAttrs,
      variants: Array.isArray(rawProd.variants) ? rawProd.variants : [],
      offers: Array.isArray(rawProd.offers) ? rawProd.offers : [],
      evidenceDocuments: nextDocs,
    });
  }

  const sanitizedStoreProfile = p.storeProfile
    ? {
        ...p.storeProfile,
        sourceClassification: storeSourceFallback,
        shopifyConnected: false,
        shopifyShopDomain: undefined,
      }
    : undefined;

  return {
    products: sanitizedProducts,
    variants: sanitizedProducts.flatMap(pr => pr.variants || []),
    offers: sanitizedProducts.flatMap(pr => pr.offers || []),
    findings: Array.isArray(p.findings) ? p.findings : [],
    actions: Array.isArray(p.actions) ? p.actions : [],
    evidence: sanitizedProducts.flatMap(pr => pr.evidenceDocuments || []),
    storeProfile: sanitizedStoreProfile as any,
  };
}

export function stampGuestCatalogEvidenceHashes(
  workspaceId: string,
  payload: StoragePayloadV1
): StoragePayloadV1 {
  for (const prod of payload.products || []) {
    for (const doc of prod.evidenceDocuments || []) {
      doc.integrityHash = computeEvidenceIntegrityHash(workspaceId, prod.id, doc);
    }
  }
  payload.evidence = (payload.products || []).flatMap(pr => pr.evidenceDocuments || []);
  return payload;
}

export async function authorizeGuestTransfer(
  repo: DatabaseRepository,
  params: {
    userId: string;
    workspaceId: string;
    idempotencyKey?: string;
    conflictStrategy?: GuestTransferConflictStrategy;
    payload: unknown;
    ttlMs?: number;
  }
): Promise<GuestTransferAuthorizationResponse> {
  const strategy: GuestTransferConflictStrategy =
    params.conflictStrategy === 'skip_existing' ||
    params.conflictStrategy === 'rename_import' ||
    params.conflictStrategy === 'abort_on_conflict'
      ? params.conflictStrategy
      : 'abort_on_conflict';

  const idempotencyKey =
    typeof params.idempotencyKey === 'string' && params.idempotencyKey.trim().length >= 8
      ? params.idempotencyKey.trim().slice(0, 128)
      : `gt_${crypto.randomBytes(16).toString('hex')}`;

  const sanitized = sanitizeGuestTransferPayload(params.workspaceId, params.userId, params.payload);
  const payloadSha256 = computeGuestPayloadSha256(sanitized);

  // Idempotent recovery: if this (workspaceId, userId, idempotencyKey) already committed, return stored receipt
  const existingAuth = await repo.getGuestTransferAuthorizationByIdempotencyKey(
    params.workspaceId,
    params.userId,
    idempotencyKey
  );
  if (existingAuth && existingAuth.status === 'committed' && existingAuth.resultSummary) {
    if (existingAuth.payloadSha256 !== payloadSha256) {
      throw new GuestTransferError(
        'Idempotency key was already committed with a different guest catalog payload.',
        'IDEMPOTENCY_KEY_CONFLICT',
        409
      );
    }
    return {
      success: true,
      alreadyCommitted: true,
      receipt: {
        ...existingAuth.resultSummary,
        idempotentReplay: true,
      },
      transferId: existingAuth.id,
      transferToken: '',
      idempotencyKey: existingAuth.idempotencyKey,
      payloadSha256: existingAuth.payloadSha256,
      workspaceId: existingAuth.workspaceId,
      userId: existingAuth.userId,
      expiresAt: existingAuth.expiresAt,
      preflight: {
        incomingProductsCount: sanitized.products.length,
        incomingVariantsCount: sanitized.variants.length,
        incomingSkusCount: countCatalogSkus(sanitized.products),
        incomingEvidenceCount: sanitized.evidence.length,
        existingCloudProductsCount: existingAuth.resultSummary.totalWorkspaceProducts,
        conflictsCount: existingAuth.resultSummary.conflicts.length,
        conflicts: existingAuth.resultSummary.conflicts,
        quotaAllowed: true,
        sourceClassifications: existingAuth.resultSummary.preservedSourceClassifications,
      },
    };
  }

  const [existingCatalog, store, subscription] = await Promise.all([
    repo.loadWorkspaceCatalog(params.workspaceId),
    repo.getStoreByWorkspace(params.workspaceId),
    repo.getSubscriptionByWorkspace(params.workspaceId),
  ]);

  const existingProducts = existingCatalog?.products || [];
  const conflicts = detectGuestCatalogConflicts(existingProducts, sanitized.products);
  const conflictIds = new Set(conflicts.map(c => c.productId));
  const incomingNonConflictingSkus =
    strategy === 'skip_existing'
      ? countCatalogSkus(sanitized.products.filter(pr => !conflictIds.has(pr.id)))
      : countCatalogSkus(sanitized.products);
  const quota = checkPlanQuota(store, existingProducts, incomingNonConflictingSkus, subscription);

  const transferToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashGuestTransferToken(transferToken);
  const now = new Date();
  const ttlMs = Math.max(1000, Math.min(params.ttlMs ?? GUEST_TRANSFER_TOKEN_TTL_MS, 30 * 60 * 1000));
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const transferId = `gtr_${crypto.randomBytes(12).toString('hex')}`;

  const record: GuestTransferAuthorizationRecord = {
    id: transferId,
    workspaceId: params.workspaceId,
    userId: params.userId,
    tokenHash,
    idempotencyKey,
    payloadSha256,
    conflictStrategy: strategy,
    status: 'pending',
    expiresAt,
    committedAt: null,
    resultSummary: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await repo.createGuestTransferAuthorization(record);

  const classSet = new Set<StoreSourceClassification>();
  for (const pr of sanitized.products) {
    if (pr.sourceClassification) classSet.add(pr.sourceClassification);
  }

  return {
    success: true,
    alreadyCommitted: false,
    transferId,
    transferToken,
    idempotencyKey,
    payloadSha256,
    workspaceId: params.workspaceId,
    userId: params.userId,
    expiresAt,
    preflight: {
      incomingProductsCount: sanitized.products.length,
      incomingVariantsCount: sanitized.variants.length,
      incomingSkusCount: countCatalogSkus(sanitized.products),
      incomingEvidenceCount: sanitized.evidence.length,
      existingCloudProductsCount: existingProducts.length,
      conflictsCount: conflicts.length,
      conflicts,
      quotaAllowed: quota.allowed,
      ...(quota.allowed ? {} : { quotaError: quota.error }),
      sourceClassifications: Array.from(classSet),
    },
  };
}

export async function commitGuestTransfer(
  repo: DatabaseRepository,
  params: {
    userId: string;
    workspaceId: string;
    transferToken: string;
    idempotencyKey?: string;
    conflictStrategy?: GuestTransferConflictStrategy;
    payload: unknown;
  }
): Promise<GuestTransferCommitResult> {
  const rawToken = typeof params.transferToken === 'string' ? params.transferToken.trim() : '';
  if (!rawToken) {
    throw new GuestTransferError(
      'Missing single-use guest transfer authorization token.',
      'TRANSFER_AUTHORIZATION_REQUIRED',
      401
    );
  }

  const tokenHash = hashGuestTransferToken(rawToken);
  const auth = await repo.getGuestTransferAuthorizationByTokenHash(tokenHash);
  if (!auth) {
    throw new GuestTransferError(
      'Invalid guest transfer authorization token.',
      'TRANSFER_AUTHORIZATION_INVALID',
      403
    );
  }

  // Strict user & workspace binding
  if (auth.userId !== params.userId || auth.workspaceId !== params.workspaceId) {
    await repo.recordGuestTransferAudit({
      id: `gta_${crypto.randomBytes(12).toString('hex')}`,
      transferId: auth.id,
      workspaceId: auth.workspaceId,
      userId: params.userId,
      outcome: 'rejected',
      conflictStrategy: auth.conflictStrategy,
      importedCount: 0,
      skippedCount: 0,
      conflictsCount: 0,
      details: {
        reason: 'TENANT_OR_USER_MISMATCH',
        attemptedWorkspaceId: params.workspaceId,
        expectedWorkspaceId: auth.workspaceId,
        attemptedUserId: params.userId,
      },
      createdAt: new Date().toISOString(),
    });
    throw new GuestTransferError(
      'Forbidden: guest transfer authorization is bound to a different user or workspace.',
      'TRANSFER_TENANT_MISMATCH',
      403
    );
  }

  const sanitized = sanitizeGuestTransferPayload(params.workspaceId, params.userId, params.payload);
  const incomingSha256 = computeGuestPayloadSha256(sanitized);

  if (auth.status === 'committed') {
    if (
      auth.payloadSha256 === incomingSha256 &&
      (!params.idempotencyKey || auth.idempotencyKey === params.idempotencyKey.trim()) &&
      auth.resultSummary
    ) {
      return {
        ...auth.resultSummary,
        idempotentReplay: true,
      };
    }
    throw new GuestTransferError(
      'Single-use guest transfer authorization has already been consumed.',
      'TRANSFER_TOKEN_ALREADY_USED',
      409
    );
  }

  if (auth.status === 'expired' || new Date(auth.expiresAt).getTime() <= Date.now()) {
    await repo.markGuestTransferAuthorizationExpired(auth.id);
    await repo.recordGuestTransferAudit({
      id: `gta_${crypto.randomBytes(12).toString('hex')}`,
      transferId: auth.id,
      workspaceId: auth.workspaceId,
      userId: params.userId,
      outcome: 'expired',
      conflictStrategy: auth.conflictStrategy,
      importedCount: 0,
      skippedCount: 0,
      conflictsCount: 0,
      details: { expiresAt: auth.expiresAt },
      createdAt: new Date().toISOString(),
    });
    throw new GuestTransferError(
      'Guest transfer authorization has expired. Please authorize a fresh transfer.',
      'TRANSFER_AUTHORIZATION_EXPIRED',
      410
    );
  }

  if (auth.payloadSha256 !== incomingSha256) {
    throw new GuestTransferError(
      'Guest catalog payload does not match the authorized transfer digest.',
      'TRANSFER_PAYLOAD_MISMATCH',
      409
    );
  }

  const strategy: GuestTransferConflictStrategy =
    params.conflictStrategy === 'skip_existing' ||
    params.conflictStrategy === 'rename_import' ||
    params.conflictStrategy === 'abort_on_conflict'
      ? params.conflictStrategy
      : auth.conflictStrategy;

  try {
    return await repo.commitGuestTransferAtomic({
      authorizationId: auth.id,
      workspaceId: params.workspaceId,
      userId: params.userId,
      payloadSha256: incomingSha256,
      conflictStrategy: strategy,
      guestPayload: sanitized,
      buildMergedCatalog: ({ existingCatalog, authoritativeStore, subscription, catalogVersionBefore }) => {
        const merge = mergeGuestCatalogNonDestructively({
          existingCatalog,
          authoritativeStore,
          guestPayload: sanitized,
          conflictStrategy: strategy,
          transferId: auth.id,
        });

        if (merge.aborted) {
          throw new GuestTransferError(
            `Existing cloud catalog conflicts detected for ${merge.conflicts.length} product(s). Resolve explicitly using skip_existing or rename_import.`,
            'GUEST_TRANSFER_CONFLICT',
            409,
            merge.conflicts
          );
        }

        const existingCount = countCatalogSkus(existingCatalog?.products || []);
        const nextCount = countCatalogSkus(merge.mergedPayload.products);
        const additionalSkus = Math.max(0, nextCount - existingCount);
        const quota = checkPlanQuota(
          authoritativeStore,
          existingCatalog?.products || [],
          additionalSkus,
          subscription
        );
        if (!quota.allowed) {
          throw new GuestTransferError(
            quota.error || 'Plan SKU limit reached for guest transfer.',
            'PLAN_QUOTA_EXCEEDED',
            403
          );
        }

        const stampedPayload = stampGuestCatalogEvidenceHashes(params.workspaceId, merge.mergedPayload);

        const committedAt = new Date().toISOString();
        const summary: GuestTransferCommitResult = {
          success: true,
          transferId: auth.id,
          workspaceId: params.workspaceId,
          idempotentReplay: false,
          status: 'committed',
          conflictStrategy: strategy,
          importedCount: merge.importedCount,
          skippedCount: merge.skippedCount,
          renamedCount: merge.renamedCount,
          conflicts: merge.conflicts,
          catalogVersion: (catalogVersionBefore ?? 1) + 1,
          totalWorkspaceProducts: stampedPayload.products.length,
          totalWorkspaceSkus: nextCount,
          preservedSourceClassifications: merge.preservedSourceClassifications,
          committedAt,
        };

        return {
          mergedPayload: stampedPayload,
          summary,
          importedCount: merge.importedCount,
          skippedCount: merge.skippedCount,
          conflictsCount: merge.conflicts.length,
        };
      },
    });
  } catch (err) {
    if (err instanceof GuestTransferError && err.code === 'GUEST_TRANSFER_CONFLICT') {
      await repo.recordGuestTransferAudit({
        id: `gta_${crypto.randomBytes(12).toString('hex')}`,
        transferId: auth.id,
        workspaceId: params.workspaceId,
        userId: params.userId,
        outcome: 'conflict_aborted',
        conflictStrategy: strategy,
        importedCount: 0,
        skippedCount: sanitized.products.length,
        conflictsCount: err.conflicts?.length || 0,
        details: {
          conflicts: (err.conflicts || []).map(c => ({
            productId: c.productId,
            existingProductId: c.existingProductId,
            matchedBy: c.matchedBy,
          })),
        },
        createdAt: new Date().toISOString(),
      });
    }
    throw err;
  }
}

export async function getGuestTransferStatus(
  repo: DatabaseRepository,
  params: {
    userId: string;
    workspaceId: string;
    idempotencyKey: string;
  }
): Promise<GuestTransferStatusResponse> {
  const key = typeof params.idempotencyKey === 'string' ? params.idempotencyKey.trim() : '';
  if (!key) {
    throw new GuestTransferError('idempotencyKey query parameter is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }

  const auth = await repo.getGuestTransferAuthorizationByIdempotencyKey(
    params.workspaceId,
    params.userId,
    key
  );
  if (!auth) {
    return {
      found: false,
      idempotencyKey: key,
      workspaceId: params.workspaceId,
    };
  }

  return {
    found: true,
    status: auth.status,
    transferId: auth.id,
    idempotencyKey: auth.idempotencyKey,
    workspaceId: auth.workspaceId,
    payloadSha256: auth.payloadSha256,
    receipt: auth.resultSummary ? { ...auth.resultSummary, idempotentReplay: true } : undefined,
  };
}
