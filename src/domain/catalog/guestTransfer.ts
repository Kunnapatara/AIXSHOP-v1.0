import {
  ActionItem,
  EvidenceDocument,
  Finding,
  Product,
  ProductSourceClassification,
  StoreProfile,
  StoreSourceClassification,
} from '../../types';
import { StoragePayloadV1 } from '../storage/storageTypes';

export type GuestTransferConflictStrategy =
  | 'abort_on_conflict'
  | 'skip_existing'
  | 'rename_import';

export type GuestTransferAuthorizationStatus =
  | 'pending'
  | 'committed'
  | 'expired'
  | 'cancelled';

export interface GuestTransferConflict {
  productId: string;
  incomingTitle: string;
  existingProductId: string;
  existingTitle: string;
  matchedBy: 'id' | 'sku' | 'title';
  matchedValue?: string;
}

export interface GuestTransferPreflightSummary {
  incomingProductsCount: number;
  incomingVariantsCount: number;
  incomingSkusCount: number;
  incomingEvidenceCount: number;
  existingCloudProductsCount: number;
  conflictsCount: number;
  conflicts: GuestTransferConflict[];
  quotaAllowed: boolean;
  quotaError?: string;
  sourceClassifications: StoreSourceClassification[];
}

export interface GuestTransferCommitResult {
  success: boolean;
  transferId: string;
  workspaceId: string;
  idempotentReplay: boolean;
  status: 'committed' | 'conflict_aborted';
  conflictStrategy: GuestTransferConflictStrategy;
  importedCount: number;
  skippedCount: number;
  renamedCount: number;
  conflicts: GuestTransferConflict[];
  catalogVersion?: number;
  totalWorkspaceProducts: number;
  totalWorkspaceSkus: number;
  preservedSourceClassifications: StoreSourceClassification[];
  committedAt: string;
}

export interface GuestTransferAuthorizationResponse {
  success: boolean;
  alreadyCommitted?: boolean;
  receipt?: GuestTransferCommitResult;
  transferId: string;
  transferToken: string;
  idempotencyKey: string;
  payloadSha256: string;
  workspaceId: string;
  userId: string;
  expiresAt: string;
  preflight: GuestTransferPreflightSummary;
}

export interface GuestTransferStatusResponse {
  found: boolean;
  status?: GuestTransferAuthorizationStatus;
  transferId?: string;
  idempotencyKey: string;
  workspaceId: string;
  payloadSha256?: string;
  receipt?: GuestTransferCommitResult;
}

export interface GuestTransferPendingCheckpoint {
  transferId: string;
  transferToken: string;
  idempotencyKey: string;
  payloadSha256: string;
  targetWorkspaceId: string;
  targetUserId: string;
  conflictStrategy: GuestTransferConflictStrategy;
  expiresAt: string;
  createdAt: string;
  state: 'authorized' | 'committing' | 'awaiting_reconciliation';
}

export interface GuestTransferEligibility {
  hasTransferableData: boolean;
  hasCustomizedGuestWork: boolean;
  productsCount: number;
  variantsCount: number;
  offersCount: number;
  findingsCount: number;
  actionsCount: number;
  evidenceCount: number;
  storeName: string;
  storeDomain: string;
  sourceClassifications: StoreSourceClassification[];
}

export interface GuestTransferAuthorizationRecord {
  id: string;
  workspaceId: string;
  userId: string;
  tokenHash: string;
  idempotencyKey: string;
  payloadSha256: string;
  conflictStrategy: GuestTransferConflictStrategy;
  status: GuestTransferAuthorizationStatus;
  expiresAt: string;
  committedAt?: string | null;
  resultSummary?: GuestTransferCommitResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuestTransferAuditRecord {
  id: string;
  transferId: string;
  workspaceId: string;
  userId: string;
  outcome: 'committed' | 'conflict_aborted' | 'rejected' | 'expired';
  conflictStrategy: GuestTransferConflictStrategy;
  importedCount: number;
  skippedCount: number;
  conflictsCount: number;
  catalogVersionBefore?: number | null;
  catalogVersionAfter?: number | null;
  details: Record<string, any>;
  createdAt: string;
}

export type GuestSourceClassification = Exclude<ProductSourceClassification, 'shopify_oauth'>;

const ALLOWED_GUEST_SOURCE_CLASSIFICATIONS: ReadonlySet<GuestSourceClassification> = new Set([
  'demo',
  'public_feed',
  'manual_import',
]);

export function normalizeGuestSourceClassification(
  raw: unknown,
  fallback: GuestSourceClassification = 'manual_import'
): GuestSourceClassification {
  if (typeof raw === 'string' && ALLOWED_GUEST_SOURCE_CLASSIFICATIONS.has(raw as GuestSourceClassification)) {
    return raw as GuestSourceClassification;
  }
  return ALLOWED_GUEST_SOURCE_CLASSIFICATIONS.has(fallback) ? fallback : 'manual_import';
}

export function evaluateGuestTransferEligibility(
  localPayload: StoragePayloadV1 | null,
  defaultSeedProducts: Product[],
  defaultSeedStoreName?: string
): GuestTransferEligibility {
  if (!localPayload || !Array.isArray(localPayload.products) || localPayload.products.length === 0) {
    return {
      hasTransferableData: false,
      hasCustomizedGuestWork: false,
      productsCount: 0,
      variantsCount: 0,
      offersCount: 0,
      findingsCount: 0,
      actionsCount: 0,
      evidenceCount: 0,
      storeName: localPayload?.storeProfile?.name || '',
      storeDomain: localPayload?.storeProfile?.domain || '',
      sourceClassifications: [],
    };
  }

  const productsCount = localPayload.products.length;
  const variantsCount = localPayload.products.reduce(
    (acc, p) => acc + Math.max(0, p.variants?.length || 0),
    0
  );
  const offersCount = localPayload.products.reduce(
    (acc, p) => acc + Math.max(0, p.offers?.length || 0),
    0
  );
  const evidenceCount = localPayload.products.reduce(
    (acc, p) => acc + Math.max(0, p.evidenceDocuments?.length || 0),
    0
  );
  const findingsCount = localPayload.findings?.length || 0;
  const actionsCount = localPayload.actions?.length || 0;

  const classSet = new Set<StoreSourceClassification>();
  for (const p of localPayload.products) {
    classSet.add(
      normalizeGuestSourceClassification(
        p.sourceClassification,
        localPayload.storeProfile?.sourceClassification === 'public_feed' ? 'public_feed' : 'demo'
      )
    );
  }

  const seedIds = new Set(defaultSeedProducts.map(p => p.id));
  const hasNonSeedProduct = localPayload.products.some(p => !seedIds.has(p.id));
  const hasNonDemoClassification = Array.from(classSet).some(c => c !== 'demo');
  const hasModifiedProductCount = localPayload.products.length !== defaultSeedProducts.length;
  const hasModifiedStoreName =
    Boolean(defaultSeedStoreName) &&
    Boolean(localPayload.storeProfile?.name) &&
    localPayload.storeProfile.name !== defaultSeedStoreName;
  const hasUserActionChanges = (localPayload.actions || []).some(
    a => a.status === 'approved' || a.status === 'dismissed' || Boolean(a.auditLog && a.auditLog.length > 0)
  );
  const hasCustomEvidence = localPayload.products.some(p =>
    (p.evidenceDocuments || []).some(
      d => !defaultSeedProducts.some(sp => sp.evidenceDocuments.some(sd => sd.id === d.id))
    )
  );

  const hasCustomizedGuestWork =
    hasNonSeedProduct ||
    hasNonDemoClassification ||
    hasModifiedProductCount ||
    hasModifiedStoreName ||
    hasUserActionChanges ||
    hasCustomEvidence;

  return {
    hasTransferableData: productsCount > 0,
    hasCustomizedGuestWork,
    productsCount,
    variantsCount,
    offersCount,
    findingsCount,
    actionsCount,
    evidenceCount,
    storeName: localPayload.storeProfile?.name || 'Guest Store',
    storeDomain: localPayload.storeProfile?.domain || localPayload.storeProfile?.websiteUrl || '',
    sourceClassifications: Array.from(classSet),
  };
}

function normalizeTitleBrandKey(title: unknown, brand: unknown): string {
  const t = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const b = String(brand || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${t}::${b}`;
}

export function detectGuestCatalogConflicts(
  existingProducts: Product[],
  incomingProducts: Product[]
): GuestTransferConflict[] {
  const byId = new Map<string, Product>();
  const bySku = new Map<string, { product: Product; sku: string }>();
  const byTitleBrand = new Map<string, Product>();

  for (const ep of existingProducts) {
    byId.set(ep.id, ep);
    for (const v of ep.variants || []) {
      const sku = String(v.sku || '').trim().toUpperCase();
      if (sku) {
        bySku.set(sku, { product: ep, sku: v.sku });
      }
    }
    const tbKey = normalizeTitleBrandKey(ep.title, ep.brand);
    if (tbKey !== '::') {
      byTitleBrand.set(tbKey, ep);
    }
  }

  const conflicts: GuestTransferConflict[] = [];
  for (const inc of incomingProducts) {
    const idMatch = byId.get(inc.id);
    if (idMatch) {
      conflicts.push({
        productId: inc.id,
        incomingTitle: inc.title,
        existingProductId: idMatch.id,
        existingTitle: idMatch.title,
        matchedBy: 'id',
        matchedValue: inc.id,
      });
      continue;
    }

    let skuConflict: { product: Product; sku: string } | undefined;
    for (const v of inc.variants || []) {
      const sku = String(v.sku || '').trim().toUpperCase();
      if (sku && bySku.has(sku)) {
        skuConflict = bySku.get(sku);
        break;
      }
    }
    if (skuConflict) {
      conflicts.push({
        productId: inc.id,
        incomingTitle: inc.title,
        existingProductId: skuConflict.product.id,
        existingTitle: skuConflict.product.title,
        matchedBy: 'sku',
        matchedValue: skuConflict.sku,
      });
      continue;
    }

    const tbKey = normalizeTitleBrandKey(inc.title, inc.brand);
    const titleMatch = tbKey !== '::' ? byTitleBrand.get(tbKey) : undefined;
    if (titleMatch) {
      conflicts.push({
        productId: inc.id,
        incomingTitle: inc.title,
        existingProductId: titleMatch.id,
        existingTitle: titleMatch.title,
        matchedBy: 'title',
        matchedValue: `${inc.title} (${inc.brand})`,
      });
    }
  }

  return conflicts;
}

export interface MergeGuestCatalogResult {
  aborted: boolean;
  conflicts: GuestTransferConflict[];
  importedCount: number;
  skippedCount: number;
  renamedCount: number;
  preservedSourceClassifications: StoreSourceClassification[];
  mergedPayload: StoragePayloadV1;
}

function makeUniqueId(base: string, used: Set<string>, suffixPrefix: string): string {
  let attempt = `${base}__${suffixPrefix}`;
  let idx = 1;
  while (used.has(attempt)) {
    idx += 1;
    attempt = `${base}__${suffixPrefix}_${idx}`;
  }
  used.add(attempt);
  return attempt;
}

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

export function mergeGuestCatalogNonDestructively(params: {
  existingCatalog: StoragePayloadV1 | null;
  authoritativeStore: StoreProfile;
  guestPayload: StoragePayloadV1;
  conflictStrategy: GuestTransferConflictStrategy;
  transferId: string;
}): MergeGuestCatalogResult {
  const { existingCatalog, authoritativeStore, guestPayload, conflictStrategy, transferId } = params;

  const existingProducts: Product[] = cloneJson(existingCatalog?.products || []);
  const existingFindings: Finding[] = cloneJson(existingCatalog?.findings || []);
  const existingActions: ActionItem[] = cloneJson(existingCatalog?.actions || []);
  const incomingProducts: Product[] = cloneJson(guestPayload.products || []);
  const incomingFindings: Finding[] = cloneJson(guestPayload.findings || []);
  const incomingActions: ActionItem[] = cloneJson(guestPayload.actions || []);

  const conflicts = detectGuestCatalogConflicts(existingProducts, incomingProducts);
  const conflictProductIds = new Set(conflicts.map(c => c.productId));

  const preservedClassSet = new Set<GuestSourceClassification>();
  for (const p of incomingProducts) {
    preservedClassSet.add(
      normalizeGuestSourceClassification(
        p.sourceClassification,
        normalizeGuestSourceClassification(guestPayload.storeProfile?.sourceClassification, 'manual_import')
      )
    );
  }

  if (conflictStrategy === 'abort_on_conflict' && conflicts.length > 0) {
    const unchanged: StoragePayloadV1 = existingCatalog
      ? cloneJson(existingCatalog)
      : {
          products: [],
          variants: [],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: cloneJson(authoritativeStore),
        };
    return {
      aborted: true,
      conflicts,
      importedCount: 0,
      skippedCount: incomingProducts.length,
      renamedCount: 0,
      preservedSourceClassifications: Array.from(preservedClassSet),
      mergedPayload: unchanged,
    };
  }

  const usedProductIds = new Set(existingProducts.map(p => p.id));
  const usedVariantIds = new Set(existingProducts.flatMap(p => (p.variants || []).map(v => v.id)));
  const usedSkus = new Set(
    existingProducts
      .flatMap(p => (p.variants || []).map(v => String(v.sku || '').trim().toUpperCase()))
      .filter(Boolean)
  );
  const usedOfferIds = new Set(existingProducts.flatMap(p => (p.offers || []).map(o => o.id)));
  const usedEvidenceIds = new Set(
    existingProducts.flatMap(p => (p.evidenceDocuments || []).map(e => e.id))
  );
  const usedFindingIds = new Set(existingFindings.map(f => f.id));
  const usedActionIds = new Set(existingActions.map(a => a.id));

  const shortSuffix = `guest_${transferId.replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'imp'}`;
  const productIdRemap = new Map<string, string>();
  const findingIdRemap = new Map<string, string>();
  const actionIdRemap = new Map<string, string>();
  const importedProducts: Product[] = [];
  let skippedCount = 0;
  let renamedCount = 0;

  for (const inc of incomingProducts) {
    const isConflicting = conflictProductIds.has(inc.id);
    if (isConflicting && conflictStrategy === 'skip_existing') {
      skippedCount += 1;
      continue;
    }

    const cloned = cloneJson(inc);
    const originalId = cloned.id;
    let targetProductId = originalId;
    if (isConflicting || usedProductIds.has(targetProductId)) {
      targetProductId = makeUniqueId(originalId, usedProductIds, shortSuffix);
      renamedCount += 1;
    } else {
      usedProductIds.add(targetProductId);
    }
    productIdRemap.set(originalId, targetProductId);
    cloned.id = targetProductId;

    // Ensure sourceClassification & provenance are strictly preserved as non-Shopify-OAuth guest provenance
    const safeClass = normalizeGuestSourceClassification(
      cloned.sourceClassification,
      normalizeGuestSourceClassification(guestPayload.storeProfile?.sourceClassification, 'manual_import')
    );
    cloned.sourceClassification = safeClass;

    // Re-key variants/offers/evidence cleanly so child IDs/SKUs never collide with existing cloud items
    cloned.variants = (cloned.variants || []).map(v => {
      const nextV = cloneJson(v);
      nextV.id = usedVariantIds.has(nextV.id)
        ? makeUniqueId(nextV.id, usedVariantIds, shortSuffix)
        : (usedVariantIds.add(nextV.id), nextV.id);
      const skuUpper = String(nextV.sku || '').trim().toUpperCase();
      if (skuUpper && usedSkus.has(skuUpper)) {
        let candidateSku = `${nextV.sku}-GUEST`;
        let n = 1;
        while (usedSkus.has(candidateSku.toUpperCase())) {
          n += 1;
          candidateSku = `${nextV.sku}-GUEST-${n}`;
        }
        nextV.sku = candidateSku;
        usedSkus.add(candidateSku.toUpperCase());
      } else if (skuUpper) {
        usedSkus.add(skuUpper);
      }
      return nextV;
    });

    cloned.offers = (cloned.offers || []).map(o => {
      const nextO = cloneJson(o);
      nextO.id = usedOfferIds.has(nextO.id)
        ? makeUniqueId(nextO.id, usedOfferIds, shortSuffix)
        : (usedOfferIds.add(nextO.id), nextO.id);
      return nextO;
    });

    cloned.evidenceDocuments = (cloned.evidenceDocuments || []).map(d => {
      const nextD = cloneJson(d);
      nextD.id = usedEvidenceIds.has(nextD.id)
        ? makeUniqueId(nextD.id, usedEvidenceIds, shortSuffix)
        : (usedEvidenceIds.add(nextD.id), nextD.id);
      return nextD;
    });

    importedProducts.push(cloned);
  }

  // Merge findings belonging to imported products (or store-scoped findings only when cloud had no findings)
  const importedFindings: Finding[] = [];
  for (const f of incomingFindings) {
    if (f.productId && !productIdRemap.has(f.productId)) {
      continue;
    }
    if (!f.productId && existingFindings.length > 0 && conflictStrategy === 'skip_existing') {
      continue;
    }
    const nextF = cloneJson(f);
    const oldFId = nextF.id;
    nextF.id = usedFindingIds.has(oldFId)
      ? makeUniqueId(oldFId, usedFindingIds, shortSuffix)
      : (usedFindingIds.add(oldFId), oldFId);
    findingIdRemap.set(oldFId, nextF.id);
    if (nextF.productId) {
      nextF.productId = productIdRemap.get(nextF.productId) || nextF.productId;
    }
    importedFindings.push(nextF);
  }

  const importedActions: ActionItem[] = [];
  for (const a of incomingActions) {
    if (a.productId && !productIdRemap.has(a.productId)) {
      continue;
    }
    if (a.findingId && !findingIdRemap.has(a.findingId)) {
      continue;
    }
    const nextA = cloneJson(a);
    const oldAId = nextA.id;
    nextA.id = usedActionIds.has(oldAId)
      ? makeUniqueId(oldAId, usedActionIds, shortSuffix)
      : (usedActionIds.add(oldAId), oldAId);
    actionIdRemap.set(oldAId, nextA.id);
    if (nextA.productId) {
      nextA.productId = productIdRemap.get(nextA.productId) || nextA.productId;
    }
    if (nextA.findingId && findingIdRemap.has(nextA.findingId)) {
      nextA.findingId = findingIdRemap.get(nextA.findingId)!;
    }
    importedActions.push(nextA);
  }

  for (const f of importedFindings) {
    if (f.actionItemId && actionIdRemap.has(f.actionItemId)) {
      f.actionItemId = actionIdRemap.get(f.actionItemId)!;
    }
  }

  const mergedProducts = [...existingProducts, ...importedProducts];
  const mergedFindings = [...existingFindings, ...importedFindings];
  const mergedActions = [...existingActions, ...importedActions];
  const mergedEvidence: EvidenceDocument[] = mergedProducts.flatMap(p => p.evidenceDocuments || []);

  // Store profile merge: NEVER downgrade/overwrite Shopify OAuth or existing configured cloud store
  const nextStoreProfile: StoreProfile = cloneJson(authoritativeStore);
  const cloudWasEmptyAndUnconfigured =
    existingProducts.length === 0 &&
    !authoritativeStore.shopifyConnected &&
    (!authoritativeStore.sourceClassification || authoritativeStore.sourceClassification === 'unconfigured');

  if (cloudWasEmptyAndUnconfigured && guestPayload.storeProfile && importedProducts.length > 0) {
    const safeStoreClass = normalizeGuestSourceClassification(
      guestPayload.storeProfile.sourceClassification,
      Array.from(preservedClassSet)[0] || 'manual_import'
    );
    if (guestPayload.storeProfile.name?.trim()) {
      nextStoreProfile.name = guestPayload.storeProfile.name.trim();
    }
    if (guestPayload.storeProfile.domain) {
      nextStoreProfile.domain = guestPayload.storeProfile.domain;
    }
    if (guestPayload.storeProfile.websiteUrl) {
      nextStoreProfile.websiteUrl = guestPayload.storeProfile.websiteUrl;
    }
    if (guestPayload.storeProfile.platform) {
      nextStoreProfile.platform = guestPayload.storeProfile.platform;
    }
    if (guestPayload.storeProfile.currency) {
      nextStoreProfile.currency = guestPayload.storeProfile.currency;
    }
    nextStoreProfile.sourceClassification = safeStoreClass;
    nextStoreProfile.shopifyConnected = false;
    nextStoreProfile.sourceMetadata = {
      classification: safeStoreClass,
      origin: guestPayload.storeProfile.domain || guestPayload.storeProfile.websiteUrl || '',
      acquisitionMethod:
        safeStoreClass === 'demo'
          ? 'demo_fixture'
          : safeStoreClass === 'public_feed'
          ? 'public_products_json_sample'
          : 'manual_import',
      importedAt: new Date().toISOString(),
    };
  } else if (authoritativeStore.shopifyConnected) {
    nextStoreProfile.sourceClassification = 'shopify_oauth';
  }

  // Preserve server-managed plan limits strictly
  nextStoreProfile.tier = authoritativeStore.tier;
  nextStoreProfile.skuLimit = authoritativeStore.skuLimit;

  return {
    aborted: false,
    conflicts,
    importedCount: importedProducts.length,
    skippedCount,
    renamedCount,
    preservedSourceClassifications: Array.from(preservedClassSet),
    mergedPayload: {
      products: mergedProducts,
      variants: mergedProducts.flatMap(p => p.variants || []),
      offers: mergedProducts.flatMap(p => p.offers || []),
      findings: mergedFindings,
      actions: mergedActions,
      evidence: mergedEvidence,
      storeProfile: nextStoreProfile,
    },
  };
}
