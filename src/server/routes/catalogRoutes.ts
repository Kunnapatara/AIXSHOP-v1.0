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

      // Never trust user-supplied storeId or workspaceId in body; derive from server session
      await repo.saveWorkspaceCatalog(workspaceId, payload);

      return res.json({
        success: true,
        workspaceId,
        skuCount: payload.products.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
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

      const result = await repo.importCatalog(workspaceId, candidates);

      return res.json({
        success: true,
        result,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Catalog import error:', err);
      return res.status(500).json({ error: err.message || 'Failed to import catalog' });
    }
  });

  // POST /api/catalog/migrate-demo — Import demo dataset into the user's workspace
  router.post('/migrate-demo', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const currentStore = await repo.getStoreByWorkspace(workspaceId);

      const storeProfile = currentStore || {
        name: `${req.workspace!.name} Store`,
        domain: `${req.workspace!.slug}.myshopify.com`,
        currency: 'USD',
        skuCount: initialProducts.length,
        catalogCompletenessAvg: 88,
        truthBoundaryStrictness: 'standard' as const,
        tier: 'Free Audit' as const,
        connectors: [],
      };

      const demoPayload: StoragePayloadV1 = {
        products: JSON.parse(JSON.stringify(initialProducts)),
        variants: initialProducts.flatMap(p => p.variants || []),
        offers: initialProducts.flatMap(p => p.offers || []),
        findings: JSON.parse(JSON.stringify(initialFindings)),
        actions: JSON.parse(JSON.stringify(initialActionItems)),
        evidence: initialProducts.flatMap(p => p.evidenceDocuments || []),
        storeProfile: {
          ...storeProfile,
          skuCount: initialProducts.length,
        },
      };

      await repo.saveWorkspaceCatalog(workspaceId, demoPayload);

      return res.json({
        success: true,
        message: 'Demo catalog successfully imported to cloud workspace',
        skuCount: initialProducts.length,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Catalog] Demo migration error:', err);
      return res.status(500).json({ error: 'Failed to migrate demo data to workspace' });
    }
  });

  return router;
}
