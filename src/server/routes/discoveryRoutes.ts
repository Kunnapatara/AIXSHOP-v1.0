import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';
import { evaluateDiscoveryReadiness, buildBusinessHubChecklist } from '../../domain/aiDiscovery/discoveryEngine';

export function createDiscoveryRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // GET /api/discovery/audit — Deterministic 8-dimension AI Discovery Evaluation
  router.get('/audit', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);
      const shopifyConn = await repo.getShopifyConnection(workspaceId);
      const profile = await repo.getWorkspaceBusinessProfile(workspaceId);

      const storeDomain = shopifyConn?.shopDomain || store?.domain || 'myshopify.com';
      const products = catalog?.products || [];

      const readinessResult = evaluateDiscoveryReadiness(products, storeDomain);
      const checklist = buildBusinessHubChecklist(profile, products.length, readinessResult.overallScore);

      return res.json({
        success: true,
        readiness: readinessResult,
        hubChecklist: checklist,
        productCount: products.length,
        storeDomain,
      });
    } catch (err: any) {
      console.error('[AI Discovery API] Error generating audit:', err);
      return res.status(500).json({ error: 'Failed to generate AI Discovery audit' });
    }
  });

  return router;
}
