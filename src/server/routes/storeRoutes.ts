import { Router } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';
import { applyConnectorToggle, validateAndApplyProfileUpdate } from '../../domain/settings/settingsService';

export function createStoreRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // GET /api/store/profile
  router.get('/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const store = await repo.getStoreByWorkspace(workspaceId);

      if (!store) {
        return res.status(404).json({ error: 'Store record not found for workspace' });
      }

      return res.json(store);
    } catch (err: any) {
      console.error('[AIXSHOP Store] Error loading store profile:', err);
      return res.status(500).json({ error: 'Failed to load store profile' });
    }
  });

  // PUT /api/store/profile
  router.put('/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const rawUpdates = req.body || {};
      const updates = { ...rawUpdates };
      // Authoritative security boundary: never allow client requests to mutate plan tier or SKU limits
      delete updates.tier;
      delete updates.skuLimit;
      delete updates.skuCount;

      const currentStore = await repo.getStoreByWorkspace(workspaceId);
      if (!currentStore) {
        return res.status(404).json({ error: 'Store record not found for workspace' });
      }

      const updateResult = validateAndApplyProfileUpdate(currentStore, updates, false);
      if (!updateResult.success || !updateResult.nextProfile) {
        return res.status(400).json({ error: updateResult.message });
      }

      const savedStore = await repo.saveStoreProfile(workspaceId, updateResult.nextProfile);

      return res.json({
        success: true,
        store: savedStore,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Store] Error updating store profile:', err);
      return res.status(500).json({ error: 'Failed to update store profile' });
    }
  });

  // POST /api/store/connectors/:id/toggle
  router.post('/connectors/:id/toggle', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const connectorId = req.params.id;

      const currentStore = await repo.getStoreByWorkspace(workspaceId);
      if (!currentStore) {
        return res.status(404).json({ error: 'Store record not found for workspace' });
      }

      // Apply honest connector semantics (no simulated connection)
      const toggleResult = applyConnectorToggle(currentStore, connectorId, false);
      if (!toggleResult.success) {
        if (toggleResult.errorCode === 'INTEGRATION_UNAVAILABLE') {
          // Return honest unconfigured/disconnected state without simulating connection
          return res.json({
            success: true,
            warning: toggleResult.message,
            store: currentStore,
          });
        }
        return res.status(400).json({ error: toggleResult.message });
      }

      const savedStore = await repo.saveStoreProfile(workspaceId, toggleResult.nextProfile || currentStore);

      return res.json({
        success: true,
        store: savedStore,
        message: toggleResult.message,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Store] Error toggling connector:', err);
      return res.status(500).json({ error: 'Failed to toggle connector' });
    }
  });

  return router;
}
