import crypto from 'node:crypto';
import { Router } from 'express';
import {
  CatalogVersionConflictError,
  CatalogVersionValidationError,
  DatabaseRepository,
} from '../db/repository';
import {
  createAuthMiddleware,
  createWorkspaceRateLimiter,
  OperationInProgressError,
  requireRole,
  withWorkspaceOperationLease,
} from '../middleware/auth';
import { AuthRequest } from '../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import {
  ProtectedVerificationFieldError,
  computeEvidenceIntegrityHash,
  inspectAndSanitizeClientCatalogPut,
  sanitizeAndValidateImportCandidates,
} from '../security/catalogSanitizer';
import { 
  initialProducts, 
  initialFindings, 
  initialActionItems 
} from '../../data/mockData';
import {
  calculateImportUsage,
  checkPlanQuota,
  countCatalogSkus,
  redactCatalogForPreliminaryAccess,
  resolveReportEntitlement,
} from '../services/entitlementService';

const MAX_CATALOG_PUT_PRODUCTS = 5000;
const MAX_IMPORT_CANDIDATES = 1000;

export function createCatalogRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const catalogWriteLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'catalog_write',
      maxAttempts: 30,
      windowMs: 60_000,
      message: 'Catalog write rate limit reached. Please retry shortly.',
    },
    repo
  );
  const catalogImportLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'catalog_import',
      maxAttempts: 15,
      windowMs: 60_000,
      message: 'Catalog import rate limit reached. Please retry shortly.',
    },
    repo
  );

  async function enforcePaidActionEntitlement(workspaceId: string) {
    const [store, subscription] = await Promise.all([
      repo.getStoreByWorkspace(workspaceId),
      repo.getSubscriptionByWorkspace(workspaceId),
    ]);
    return resolveReportEntitlement(store, subscription);
  }

  // GET /api/catalog — Get workspace catalog (redacts all audit findings, actions, scores & summaries on unpaid/lapsed workspaces)
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const workspaceId = req.workspace!.id;
      const [loadedCatalog, store, subscription] = await Promise.all([
        repo.loadWorkspaceCatalog(workspaceId),
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);

      let catalog = loadedCatalog;
      if (!catalog) {
        catalog = {
          products: [],
          variants: [],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: store || {
            name: `${req.workspace!.name} Store`,
            domain: '',
            websiteUrl: '',
            sourceClassification: 'unconfigured',
            shopifyConnected: false,
            currency: 'USD',
            skuCount: 0,
            catalogCompletenessAvg: 0,
            truthBoundaryStrictness: 'standard',
            tier: 'Free Audit',
            connectors: [],
          },
        };
      }

      const reportEntitlement = resolveReportEntitlement(store || catalog.storeProfile, subscription);
      const { catalog: safeCatalog } = redactCatalogForPreliminaryAccess(
        catalog,
        reportEntitlement
      );

      return res.json({
        workspaceId,
        catalog: safeCatalog,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Failed to load catalog:', err);
      return res.status(500).json({ error: 'Failed to load workspace catalog' });
    }
  });

  // PUT /api/catalog — Persist entire workspace catalog atomically
  router.put('/', requireAuth, catalogWriteLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const payload: StoragePayloadV1 = req.body?.payload || req.body;

      if (!payload || !Array.isArray(payload.products) || !Array.isArray(payload.actions)) {
        return res.status(400).json({ error: 'Invalid catalog payload format' });
      }

      if (payload.products.length > MAX_CATALOG_PUT_PRODUCTS) {
        return res.status(413).json({
          error: `Catalog payload exceeds maximum limit of ${MAX_CATALOG_PUT_PRODUCTS} products per request.`,
          code: 'BATCH_LIMIT_EXCEEDED',
        });
      }

      const hasBodyExpected = req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedVersion');
      const hasPayloadVersion = payload && Object.prototype.hasOwnProperty.call(payload, 'catalogVersion');
      const hasExpectedProvided = hasBodyExpected || hasPayloadVersion;
      const rawExpected = hasBodyExpected ? req.body.expectedVersion : payload.catalogVersion;

      if (
        hasExpectedProvided &&
        (typeof rawExpected !== 'number' || !Number.isInteger(rawExpected) || rawExpected < 1)
      ) {
        const currentCatalog = await repo.loadWorkspaceCatalog(workspaceId);
        return res.status(400).json({
          error: 'expectedVersion must be a positive integer.',
          code: 'INVALID_CATALOG_VERSION',
          currentVersion: currentCatalog?.catalogVersion ?? 1,
        });
      }

      const expectedVersion =
        hasExpectedProvided && typeof rawExpected === 'number' ? rawExpected : undefined;

      return await repo.withWorkspaceLock(workspaceId, async () => {
        // Enforce authoritative plan quota on full catalog payload
        const store = await repo.getStoreByWorkspace(workspaceId);
        const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
        const proposedSkus = countCatalogSkus(payload.products);
        const quotaCheck = checkPlanQuota(store, [], proposedSkus, subscription);
        if (!quotaCheck.allowed) {
          return res.status(403).json({
            error: quotaCheck.error,
            code: 'PLAN_QUOTA_EXCEEDED',
            limit: quotaCheck.limit,
            currentUsage: 0,
            additionalUsage: proposedSkus,
            projectedUsage: proposedSkus,
            tier: quotaCheck.tier,
          });
        }

        // Inspect & sanitize client-submitted catalog to reject forged GTIN verification/Shopify gift-card provenance
        const [existingCatalog, provenanceList] = await Promise.all([
          repo.loadWorkspaceCatalog(workspaceId),
          repo.getShopifyProductProvenance(workspaceId),
        ]);
        const sanitizedPayload = inspectAndSanitizeClientCatalogPut(
          workspaceId,
          payload,
          existingCatalog,
          provenanceList,
          { rejectOnTampering: true }
        );

        // Never trust client-supplied tier, skuLimit, or Shopify OAuth identity in payload.storeProfile
        if (store && sanitizedPayload.storeProfile) {
          const clientClass = sanitizedPayload.storeProfile.sourceClassification;
          const safeClientClass =
            clientClass === 'public_feed' ||
            clientClass === 'manual_import' ||
            clientClass === 'demo' ||
            clientClass === 'unconfigured'
              ? clientClass
              : store.sourceClassification;

          sanitizedPayload.storeProfile = {
            ...sanitizedPayload.storeProfile,
            tier: store.tier,
            skuLimit: store.skuLimit,
            shopifyConnected: Boolean(store.shopifyConnected),
            shopifyShopDomain: store.shopifyShopDomain,
            sourceClassification: store.shopifyConnected
              ? 'shopify_oauth'
              : safeClientClass || store.sourceClassification || 'unconfigured',
            platform: store.shopifyConnected
              ? store.platform
              : sanitizedPayload.storeProfile.platform || store.platform,
            websiteUrl:
              sanitizedPayload.storeProfile.websiteUrl ??
              sanitizedPayload.storeProfile.domain ??
              store.websiteUrl,
          };
        }

        // Never trust user-supplied storeId or workspaceId in body; derive from server session
        await repo.saveWorkspaceCatalog(workspaceId, sanitizedPayload, { expectedVersion });
        const savedCatalog = await repo.loadWorkspaceCatalog(workspaceId);

        return res.json({
          success: true,
          workspaceId,
          skuCount: proposedSkus,
          catalogVersion: savedCatalog?.catalogVersion,
          timestamp: new Date().toISOString(),
        });
      });
    } catch (err: any) {
      if (err instanceof ProtectedVerificationFieldError || err.code === 'PROTECTED_VERIFICATION_FIELD') {
        return res.status(403).json({
          error: err.message,
          code: 'PROTECTED_VERIFICATION_FIELD',
        });
      }
      if (err instanceof CatalogVersionValidationError || err.code === 'INVALID_CATALOG_VERSION') {
        return res.status(400).json({
          error: err.message,
          code: 'INVALID_CATALOG_VERSION',
          currentVersion: err.currentVersion,
        });
      }
      if (err instanceof CatalogVersionConflictError || err.code === 'CATALOG_VERSION_CONFLICT') {
        return res.status(409).json({
          error: err.message,
          code: 'CATALOG_VERSION_CONFLICT',
          currentVersion: err.currentVersion,
          expectedVersion: err.expectedVersion,
        });
      }
      if (err.code === 'PLAN_QUOTA_EXCEEDED' || err.name === 'PlanQuotaExceededError') {
        return res.status(403).json({
          error: err.message,
          code: 'PLAN_QUOTA_EXCEEDED',
          limit: err.limit,
          currentUsage: err.currentUsage,
          additionalUsage: err.additionalUsage,
          projectedUsage: err.projectedUsage,
          tier: err.tier,
        });
      }
      console.error('[AIXSHOP Catalog] Failed to save catalog:', err);
      return res.status(500).json({ error: 'Failed to persist workspace catalog' });
    }
  });

  // POST /api/catalog/actions/:id/approve
  router.post('/actions/:id/approve', requireAuth, catalogWriteLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const actionId = req.params.id;
      const { customApprovedValue } = req.body || {};

      // Load workspace catalog to verify action belongs to this workspace (404 before entitlement check)
      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const existingAction = catalog?.actions.find(a => a.id === actionId);
      if (!existingAction) {
        return res.status(404).json({ 
          error: `Action ${actionId} not found in current workspace`,
          code: 'ACTION_NOT_FOUND' 
        });
      }

      const reportEntitlement = await enforcePaidActionEntitlement(workspaceId);
      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      const result = await repo.approveAction(workspaceId, actionId, customApprovedValue);

      return res.json({
        success: true,
        action: result.action,
        product: result.product,
        catalogVersion: result.catalogVersion,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action approval error:', err);
      return res.status(500).json({ error: err.message || 'Failed to approve action' });
    }
  });

  // POST /api/catalog/actions/:id/dismiss
  router.post('/actions/:id/dismiss', requireAuth, catalogWriteLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const actionId = req.params.id;

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const existingAction = catalog?.actions.find(a => a.id === actionId);
      if (!existingAction) {
        return res.status(404).json({ 
          error: `Action ${actionId} not found in current workspace`,
          code: 'ACTION_NOT_FOUND' 
        });
      }

      const reportEntitlement = await enforcePaidActionEntitlement(workspaceId);
      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      const result = await repo.dismissAction(workspaceId, actionId);

      return res.json({
        success: true,
        action: result.action,
        catalogVersion: result.catalogVersion,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action dismissal error:', err);
      return res.status(500).json({ error: err.message || 'Failed to dismiss action' });
    }
  });

  // POST /api/catalog/actions/:id/recheck
  router.post('/actions/:id/recheck', requireAuth, catalogWriteLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const actionId = req.params.id;

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const existingAction = catalog?.actions.find(a => a.id === actionId);
      if (!existingAction) {
        return res.status(404).json({ 
          error: `Action ${actionId} not found in current workspace`,
          code: 'ACTION_NOT_FOUND' 
        });
      }

      const reportEntitlement = await enforcePaidActionEntitlement(workspaceId);
      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      const result = await repo.recheckAction(workspaceId, actionId);

      return res.json({
        success: true,
        action: result.action,
        catalogVersion: result.catalogVersion,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action recheck error:', err);
      return res.status(500).json({ error: err.message || 'Failed to recheck action' });
    }
  });

  // POST /api/catalog/import — Import candidate products
  router.post('/import', requireAuth, catalogImportLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const { candidates } = req.body || {};

      if (!Array.isArray(candidates)) {
        return res.status(400).json({ error: 'Invalid candidates array' });
      }

      if (candidates.length > MAX_IMPORT_CANDIDATES) {
        return res.status(413).json({
          error: `Import batch exceeds maximum limit of ${MAX_IMPORT_CANDIDATES} candidates per request.`,
          code: 'BATCH_LIMIT_EXCEEDED',
        });
      }

      const safeCandidates = sanitizeAndValidateImportCandidates(workspaceId, candidates, {
        rejectOnTampering: true,
      });

      // Serialize concurrent import requests per workspace via distributed repository lock
      return await repo.withWorkspaceLock(workspaceId, async () => {
        const store = await repo.getStoreByWorkspace(workspaceId);
        const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
        const catalog = await repo.loadWorkspaceCatalog(workspaceId);
        const existingProducts = catalog?.products || [];

        const { additionalSkus } = calculateImportUsage(safeCandidates, existingProducts);

        const quotaCheck = checkPlanQuota(store, existingProducts, additionalSkus, subscription);
        if (!quotaCheck.allowed) {
          return res.status(403).json({
            error: quotaCheck.error,
            code: 'PLAN_QUOTA_EXCEEDED',
            limit: quotaCheck.limit,
            currentUsage: quotaCheck.currentUsage,
            additionalUsage: quotaCheck.additionalUsage,
            projectedUsage: quotaCheck.projectedUsage,
            tier: quotaCheck.tier,
          });
        }

        const result = await repo.importCatalog(workspaceId, safeCandidates);
        const savedCatalog = await repo.loadWorkspaceCatalog(workspaceId);

        return res.json({
          success: true,
          result,
          catalogVersion: savedCatalog?.catalogVersion,
        });
      });
    } catch (err: any) {
      if (err instanceof ProtectedVerificationFieldError || err.code === 'PROTECTED_VERIFICATION_FIELD') {
        return res.status(403).json({
          error: err.message,
          code: 'PROTECTED_VERIFICATION_FIELD',
        });
      }
      if (err.code === 'PLAN_QUOTA_EXCEEDED' || err.name === 'PlanQuotaExceededError') {
        return res.status(403).json({
          error: err.message,
          code: 'PLAN_QUOTA_EXCEEDED',
          limit: err.limit,
          currentUsage: err.currentUsage,
          additionalUsage: err.additionalUsage,
          projectedUsage: err.projectedUsage,
          tier: err.tier,
        });
      }
      console.error('[AIXSHOP Catalog] Catalog import error:', err);
      return res.status(500).json({ error: err.message || 'Failed to import catalog' });
    }
  });

  // POST /api/catalog/migrate-demo — Import demo dataset into the user's workspace
  router.post('/migrate-demo', requireAuth, catalogImportLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const hasBodyExpected = req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedVersion');
      const rawExpected = hasBodyExpected ? req.body.expectedVersion : undefined;

      if (
        hasBodyExpected &&
        (typeof rawExpected !== 'number' || !Number.isInteger(rawExpected) || rawExpected < 1)
      ) {
        const currentCatalog = await repo.loadWorkspaceCatalog(workspaceId);
        return res.status(400).json({
          error: 'expectedVersion must be a positive integer.',
          code: 'INVALID_CATALOG_VERSION',
          currentVersion: currentCatalog?.catalogVersion ?? 1,
        });
      }

      const expectedVersion =
        hasBodyExpected && typeof rawExpected === 'number' ? rawExpected : undefined;

      return await withWorkspaceOperationLease(repo, workspaceId, 'catalog_migrate_demo', 120_000, () =>
        repo.withWorkspaceLock(workspaceId, async () => {
          const currentStore = await repo.getStoreByWorkspace(workspaceId);
          const subscription = await repo.getSubscriptionByWorkspace(workspaceId);

          const demoSkus = countCatalogSkus(initialProducts);
          const storeProfile = currentStore || {
            name: `${req.workspace!.name} Store`,
            domain: '',
            websiteUrl: '',
            platform: 'Solstice Demo Catalog Fixture',
            sourceClassification: 'demo' as const,
            shopifyConnected: false,
            currency: 'USD',
            skuCount: demoSkus,
            catalogCompletenessAvg: 88,
            truthBoundaryStrictness: 'standard' as const,
            tier: 'Free Audit' as const,
            connectors: [],
          };

          const quotaCheck = checkPlanQuota(currentStore, [], demoSkus, subscription);
          if (!quotaCheck.allowed) {
            return res.status(403).json({
              error: quotaCheck.error,
              code: 'PLAN_QUOTA_EXCEEDED',
              limit: quotaCheck.limit,
              currentUsage: 0,
              additionalUsage: demoSkus,
              projectedUsage: demoSkus,
              tier: quotaCheck.tier,
            });
          }

          const nowIso = new Date().toISOString();
          const demoProducts = JSON.parse(JSON.stringify(initialProducts)).map((p: any) => ({
            ...p,
            sourceClassification: 'demo' as const,
            sourceOrigin: 'https://solsticecraftgoods.store',
            acquisitionMethod: 'demo_fixture' as const,
            evidenceDocuments: (p.evidenceDocuments || []).map((doc: any) => {
              const isVerifiedDemoDoc = doc.status === 'verified';
              const withServerMeta = isVerifiedDemoDoc
                ? {
                    ...doc,
                    evidencePurpose: 'product_claim' as const,
                    verificationSource: 'external_registry' as const,
                    decision: 'approved' as const,
                    verifiedBy: 'demo_seed',
                    reviewedAt: nowIso,
                    createdAt: nowIso,
                  }
                : {
                    ...doc,
                    evidencePurpose: 'product_claim' as const,
                    verificationSource: 'client_submission' as const,
                    decision: 'pending' as const,
                    createdAt: nowIso,
                  };
              withServerMeta.integrityHash = computeEvidenceIntegrityHash(workspaceId, p.id, withServerMeta);
              return withServerMeta;
            }),
          }));

          const demoPayload: StoragePayloadV1 = {
            products: demoProducts,
            variants: demoProducts.flatMap((p: any) => p.variants || []),
            offers: demoProducts.flatMap((p: any) => p.offers || []),
            findings: JSON.parse(JSON.stringify(initialFindings)),
            actions: JSON.parse(JSON.stringify(initialActionItems)),
            evidence: demoProducts.flatMap((p: any) => p.evidenceDocuments || []),
            storeProfile: {
              ...storeProfile,
              skuCount: demoSkus,
              platform: currentStore?.platform || 'Solstice Demo Catalog Fixture',
              sourceClassification: currentStore?.shopifyConnected ? 'shopify_oauth' : 'demo',
              sourceMetadata: currentStore?.shopifyConnected
                ? currentStore.sourceMetadata
                : {
                    classification: 'demo',
                    origin: currentStore?.domain || 'https://solsticecraftgoods.store',
                    acquisitionMethod: 'demo_fixture',
                    importedAt: nowIso,
                  },
              shopifyConnected: Boolean(currentStore?.shopifyConnected),
            },
          };

          await repo.saveWorkspaceCatalog(workspaceId, demoPayload, { expectedVersion });
          const savedCatalog = await repo.loadWorkspaceCatalog(workspaceId);

          return res.json({
            success: true,
            message: 'Demo catalog successfully imported to cloud workspace',
            skuCount: demoSkus,
            catalogVersion: savedCatalog?.catalogVersion,
          });
        })
      );
    } catch (err: any) {
      if (err instanceof OperationInProgressError || err.code === 'OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          error: err.message,
          code: 'OPERATION_IN_PROGRESS',
          operationKey: err.operationKey,
        });
      }
      if (err instanceof CatalogVersionValidationError || err.code === 'INVALID_CATALOG_VERSION') {
        return res.status(400).json({
          error: err.message,
          code: 'INVALID_CATALOG_VERSION',
          currentVersion: err.currentVersion,
        });
      }
      if (err instanceof CatalogVersionConflictError || err.code === 'CATALOG_VERSION_CONFLICT') {
        return res.status(409).json({
          error: err.message,
          code: 'CATALOG_VERSION_CONFLICT',
          currentVersion: err.currentVersion,
          expectedVersion: err.expectedVersion,
        });
      }
      if (err.code === 'PLAN_QUOTA_EXCEEDED' || err.name === 'PlanQuotaExceededError') {
        return res.status(403).json({
          error: err.message,
          code: 'PLAN_QUOTA_EXCEEDED',
          limit: err.limit,
          currentUsage: err.currentUsage,
          additionalUsage: err.additionalUsage,
          projectedUsage: err.projectedUsage,
          tier: err.tier,
        });
      }
      console.error('[AIXSHOP Catalog] Demo migration error:', err);
      return res.status(500).json({ error: 'Failed to migrate demo data to workspace' });
    }
  });

  // POST /api/catalog/evidence — Merchant evidence upload (always starts pending/unverified)
  router.post(
    '/evidence',
    requireAuth,
    requireRole(['owner', 'admin', 'member']),
    catalogWriteLimiter,
    async (req: AuthRequest, res) => {
      try {
        const workspaceId = req.workspace!.id;
        const body = req.body || {};

        if (
          body.status === 'verified' ||
          body.decision === 'approved' ||
          Boolean(body.verifiedBy) ||
          Boolean(body.reviewedAt) ||
          Boolean(body.integrityHash) ||
          (body.verificationSource && body.verificationSource !== 'client_submission')
        ) {
          return res.status(403).json({
            error:
              'Forbidden: verification status, decision, reviewer metadata, and integrityHash are server-controlled and cannot be set by client submissions.',
            code: 'PROTECTED_VERIFICATION_FIELD',
          });
        }

        const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const type = typeof body.type === 'string' ? body.type.trim() : '';
        const issuer = typeof body.issuer === 'string' ? body.issuer.trim() : '';

        if (!productId || !title || !type || !issuer) {
          return res.status(400).json({
            error: 'productId, title, type, and issuer are required.',
            code: 'INVALID_EVIDENCE_PAYLOAD',
          });
        }

        const result = await repo.submitEvidenceDocument({
          workspaceId,
          productId,
          title,
          type: type as any,
          issuer,
          dateVerified: typeof body.dateVerified === 'string' ? body.dateVerified.trim() : undefined,
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          evidencePurpose: body.evidencePurpose,
          submittedByUserId: req.user!.id,
          id: typeof body.id === 'string' ? body.id.trim() : undefined,
        });

        return res.status(201).json({
          success: true,
          workspaceId,
          evidence: result.evidence,
          catalogVersion: result.catalogVersion,
        });
      } catch (err: any) {
        if (err.code === 'PRODUCT_NOT_FOUND' || err.code === 'CATALOG_NOT_FOUND') {
          return res.status(404).json({
            error: err.message,
            code: err.code,
          });
        }
        console.error('[AIXSHOP Catalog] Evidence submission error:', err);
        return res.status(500).json({ error: err.message || 'Failed to submit evidence document' });
      }
    }
  );

  // POST /api/catalog/evidence/:evidenceId/review — Server-owned reviewer verification (workspace users forbidden)
  router.post('/evidence/:evidenceId/review', requireAuth, catalogWriteLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const evidenceId = req.params.evidenceId;

      const configuredSecret = process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET?.trim() || '';
      const providedToken = String(req.headers['x-aixshop-reviewer-token'] || '');
      const reviewerIdHeader = String(req.headers['x-aixshop-reviewer-id'] || '').trim();

      let authorizedReviewer = false;
      if (configuredSecret.length >= 32 && providedToken.length > 0 && reviewerIdHeader.length > 0) {
        const expectedDigest = crypto.createHash('sha256').update(configuredSecret, 'utf8').digest();
        const providedDigest = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
        authorizedReviewer = crypto.timingSafeEqual(expectedDigest, providedDigest);
      }

      if (!authorizedReviewer) {
        return res.status(403).json({
          error:
            'Forbidden: workspace users cannot self-approve or modify evidence verification status. A server-authorized platform reviewer credential is required.',
          code: 'FORBIDDEN_REVIEWER_REQUIRED',
        });
      }

      const { decision, reason, verificationSource } = req.body || {};
      if (decision !== 'approved' && decision !== 'rejected') {
        return res.status(400).json({
          error: 'decision must be "approved" or "rejected".',
          code: 'INVALID_REVIEW_DECISION',
        });
      }

      const result = await repo.reviewEvidenceDocument({
        workspaceId,
        evidenceId,
        decision,
        reviewerId: reviewerIdHeader,
        reviewerRole: 'platform_reviewer',
        reason: typeof reason === 'string' ? reason.trim() : undefined,
        verificationSource: verificationSource === 'external_registry' ? 'external_registry' : 'server_reviewer',
      });

      return res.status(200).json({
        success: true,
        workspaceId,
        evidence: result.evidence,
        auditEntry: result.auditEntry,
        catalogVersion: result.catalogVersion,
      });
    } catch (err: any) {
      if (err.code === 'EVIDENCE_NOT_FOUND' || err.code === 'CATALOG_NOT_FOUND') {
        return res.status(404).json({
          error: err.message,
          code: err.code,
        });
      }
      if (err.code === 'EVIDENCE_INTEGRITY_MISMATCH') {
        return res.status(409).json({
          error: err.message,
          code: err.code,
        });
      }
      console.error('[AIXSHOP Catalog] Evidence review error:', err);
      return res.status(500).json({ error: err.message || 'Failed to review evidence document' });
    }
  });

  // GET /api/catalog/evidence/:evidenceId/audit-log — Read immutable server review log for an evidence record
  router.get('/evidence/:evidenceId/audit-log', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const evidenceId = req.params.evidenceId;
      const entries = await repo.getEvidenceReviewAuditLog(workspaceId, evidenceId);
      return res.status(200).json({
        success: true,
        workspaceId,
        evidenceId,
        entries,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Evidence audit log read error:', err);
      return res.status(500).json({ error: 'Failed to retrieve evidence review audit log' });
    }
  });

  return router;
}
