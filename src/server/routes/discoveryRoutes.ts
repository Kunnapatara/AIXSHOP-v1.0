import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, createWorkspaceRateLimiter } from '../middleware/auth';
import { AuthRequest } from '../types';
import { evaluateDiscoveryReadiness, buildBusinessHubChecklist } from '../../domain/aiDiscovery/discoveryEngine';
import { resolveReportEntitlement } from '../services/entitlementService';

export function createDiscoveryRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const discoveryLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'discovery_audit',
      maxAttempts: 20,
      windowMs: 60_000,
      message: 'AI Discovery audit rate limit exceeded. Please retry shortly.',
    },
    repo
  );

  // GET /api/discovery/audit — Deterministic 8-dimension AI Discovery Evaluation (paid plans only)
  router.get('/audit', requireAuth, discoveryLimiter, async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const workspaceId = req.workspace!.id;
      const [catalog, store, shopifyConn, profile, subscription] = await Promise.all([
        repo.loadWorkspaceCatalog(workspaceId),
        repo.getStoreByWorkspace(workspaceId),
        repo.getShopifyConnection(workspaceId),
        repo.getWorkspaceBusinessProfile(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);

      const reportEntitlement = resolveReportEntitlement(store || catalog?.storeProfile, subscription);
      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      const storeDomain = shopifyConn?.shopDomain || store?.domain || 'myshopify.com';
      const products = catalog?.products || [];

      const readinessResult = evaluateDiscoveryReadiness(products, storeDomain);
      const checklist = buildBusinessHubChecklist(profile, products.length, readinessResult.overallScore);

      return res.json({
        success: true,
        readiness: readinessResult,
        findingsCount: readinessResult.findings.length,
        hubChecklist: checklist,
        productCount: products.length,
        storeDomain,
        reportEntitlement,
        isLocked: false,
      });
    } catch (err: any) {
      console.error('[AI Discovery API] Error generating audit:', err);
      return res.status(500).json({ error: 'Failed to generate AI Discovery audit' });
    }
  });

  return router;
}
