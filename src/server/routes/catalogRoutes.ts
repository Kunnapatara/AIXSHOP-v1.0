import { Router } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware } from '../middleware/auth';
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
  withWorkspaceLock
} from '../services/entitlementService';

export function createCatalogRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // GET /api/catalog — Get workspace catalog
  router.get('/', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      let catalog = await repo.loadWorkspaceCatalog(workspaceId);

      if (!catalog) {
        // Return clean empty catalog for new workspace
        const store = await repo.getStoreByWorkspace(workspaceId);
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

      return res.json({
        workspaceId,
        catalog,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Failed to load catalog:', err);
      return res.status(500).json({ error: 'Failed to load workspace catalog' });
    }
  });

  // PUT /api/catalog — Persist entire workspace catalog atomically
  router.put('/', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const payload: StoragePayloadV1 = req.body?.payload || req.body;

      if (!payload || !Array.isArray(payload.products) || !Array.isArray(payload.actions)) {
        return res.status(400).json({ error: 'Invalid catalog payload format' });
      }

      return await withWorkspaceLock(workspaceId, async () => {
        // Enforce authoritative plan quota on full catalog payload
        const store = await repo.getStoreByWorkspace(workspaceId);
        const proposedSkus = countCatalogSkus(payload.products);
        const quotaCheck = checkPlanQuota(store, [], proposedSkus);
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
        await repo.saveWorkspaceCatalog(workspaceId, payload);

        return res.json({
          success: true,
          workspaceId,
          skuCount: proposedSkus,
          timestamp: new Date().toISOString(),
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
      console.error('[AIXSHOP Catalog] Failed to save catalog:', err);
      return res.status(500).json({ error: 'Failed to persist workspace catalog' });
    }
  });

  // POST /api/catalog/actions/:id/approve
  router.post('/actions/:id/approve', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const actionId = req.params.id;
      const { customApprovedValue } = req.body || {};

      // Load workspace catalog to verify action belongs to this workspace
      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const existingAction = catalog?.actions.find(a => a.id === actionId);
      if (!existingAction) {
        // Enforce strict workspace isolation: if action does not exist in this workspace, return 404
        return res.status(404).json({ 
          error: `Action ${actionId} not found in current workspace`,
          code: 'ACTION_NOT_FOUND' 
        });
      }

      const result = await repo.approveAction(workspaceId, actionId, customApprovedValue);

      return res.json({
        success: true,
        action: result.action,
        product: result.product,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action approval error:', err);
      return res.status(500).json({ error: err.message || 'Failed to approve action' });
    }
  });

  // POST /api/catalog/actions/:id/dismiss
  router.post('/actions/:id/dismiss', requireAuth, async (req: AuthRequest, res) => {
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

      const result = await repo.dismissAction(workspaceId, actionId);

      return res.json({
        success: true,
        action: result.action,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action dismissal error:', err);
      return res.status(500).json({ error: err.message || 'Failed to dismiss action' });
    }
  });

  // POST /api/catalog/actions/:id/recheck
  router.post('/actions/:id/recheck', requireAuth, async (req: AuthRequest, res) => {
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

      const result = await repo.recheckAction(workspaceId, actionId);

      return res.json({
        success: true,
        action: result.action,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Action recheck error:', err);
      return res.status(500).json({ error: err.message || 'Failed to recheck action' });
    }
  });

  // POST /api/catalog/import — Import candidate products
  router.post('/import', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const { candidates } = req.body || {};

      if (!Array.isArray(candidates)) {
        return res.status(400).json({ error: 'Invalid candidates array' });
      }

      // Serialize concurrent import requests per workspace to prevent quota race conditions
      return await withWorkspaceLock(workspaceId, async () => {
        // Authoritative server-side store & catalog resolution (ignoring any client-supplied body params)
        const store = await repo.getStoreByWorkspace(workspaceId);
        const catalog = await repo.loadWorkspaceCatalog(workspaceId);
        const existingProducts = catalog?.products || [];

        // Deduplicate and calculate additional usage according to domain rules
        const { additionalSkus } = calculateImportUsage(candidates, existingProducts);

        // Authoritative server-side quota validation
        const quotaCheck = checkPlanQuota(store, existingProducts, additionalSkus);
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

        return res.json({
          success: true,
          result,
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
  router.post('/migrate-demo', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;

      return await withWorkspaceLock(workspaceId, async () => {
        const currentStore = await repo.getStoreByWorkspace(workspaceId);

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

        const quotaCheck = checkPlanQuota(currentStore, [], demoSkus);
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

        await repo.saveWorkspaceCatalog(workspaceId, demoPayload);

        return res.json({
          success: true,
          message: 'Demo catalog successfully imported to cloud workspace',
          skuCount: demoSkus,
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
      console.error('[AIXSHOP Catalog] Demo migration error:', err);
      return res.status(500).json({ error: 'Failed to migrate demo data to workspace' });
    }
  });

  return router;
}
