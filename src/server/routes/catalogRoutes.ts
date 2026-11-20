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
  withWorkspaceOperationLease,
} from '../middleware/auth';
import { AuthRequest } from '../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
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
            domain: `${req.workspace!.slug}.myshopify.com`,
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

        // Never trust client-supplied tier or skuLimit in payload.storeProfile
        if (store && payload.storeProfile) {
          payload.storeProfile = {
            ...payload.storeProfile,
            tier: store.tier,
            skuLimit: store.skuLimit,
          };
        }

        // Never trust user-supplied storeId or workspaceId in body; derive from server session
        await repo.saveWorkspaceCatalog(workspaceId, payload, { expectedVersion });
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

      // Serialize concurrent import requests per workspace via distributed repository lock
      return await repo.withWorkspaceLock(workspaceId, async () => {
        const store = await repo.getStoreByWorkspace(workspaceId);
        const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
        const catalog = await repo.loadWorkspaceCatalog(workspaceId);
        const existingProducts = catalog?.products || [];

        const { additionalSkus } = calculateImportUsage(candidates, existingProducts);

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

        const result = await repo.importCatalog(workspaceId, candidates);
        const savedCatalog = await repo.loadWorkspaceCatalog(workspaceId);

        return res.json({
          success: true,
          result,
          catalogVersion: savedCatalog?.catalogVersion,
        });
      });
    } catch (err: any) {
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
            domain: `${req.workspace!.slug}.myshopify.com`,
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

          const demoPayload: StoragePayloadV1 = {
            products: JSON.parse(JSON.stringify(initialProducts)),
            variants: initialProducts.flatMap(p => p.variants || []),
            offers: initialProducts.flatMap(p => p.offers || []),
            findings: JSON.parse(JSON.stringify(initialFindings)),
            actions: JSON.parse(JSON.stringify(initialActionItems)),
            evidence: initialProducts.flatMap(p => p.evidenceDocuments || []),
            storeProfile: {
              ...storeProfile,
              skuCount: demoSkus,
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

  return router;
}
