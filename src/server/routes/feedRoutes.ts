import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';
import { Product } from '../../types';
import {
  evaluateFeedReadiness,
  mapProductToGmcRow,
  mapProductToMetaRow,
  mapProductToSchemaOrgJsonLd,
  exportToCsv,
  FeedPlatform,
} from '../../domain/feed/feedValidationEngine';

export function createFeedRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // POST /api/feed/validate — Evaluates catalog against platform feed requirements
  router.post('/validate', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const platform: FeedPlatform = req.body?.platform || 'google_merchant_center';

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const products: Product[] = catalog?.products || [];

      const report = evaluateFeedReadiness(products, platform);

      return res.json({
        success: true,
        report,
      });
    } catch (err: any) {
      console.error('[Feed API] Error evaluating feed:', err);
      return res.status(500).json({ error: 'Failed to evaluate feed readiness' });
    }
  });

  // GET /api/feed/export — Exports feed in CSV or JSON format
  router.get('/export', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const platform: FeedPlatform = (req.query.platform as FeedPlatform) || 'google_merchant_center';
      const format = (req.query.format as string) || (platform === 'schema_org' ? 'json' : 'csv');
      const filter = (req.query.filter as string) || 'all'; // 'valid_only' or 'all'

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);
      const currency = store?.currency || 'USD';
      let products: Product[] = catalog?.products || [];

      if (filter === 'valid_only') {
        const report = evaluateFeedReadiness(products, platform);
        const validIds = new Set(report.evaluations.filter((e) => e.isValid).map((e) => e.productId));
        products = products.filter((p: Product) => validIds.has(p.id));
      }

      if (platform === 'schema_org' || format === 'json') {
        const jsonLdData = products.map((p: Product) => mapProductToSchemaOrgJsonLd(p, currency));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${platform}_feed_${Date.now()}.json"`);
        return res.send(JSON.stringify(jsonLdData, null, 2));
      }

      if (platform === 'meta_commerce') {
        const rows = products.map((p: Product) => mapProductToMetaRow(p, currency));
        const csv = exportToCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="meta_commerce_feed_${Date.now()}.csv"`);
        return res.send(csv);
      }

      // Default: Google Merchant Center CSV
      const rows = products.map((p: Product) => mapProductToGmcRow(p, currency));
      const csv = exportToCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="google_merchant_feed_${Date.now()}.csv"`);
      return res.send(csv);
    } catch (err: any) {
      console.error('[Feed API] Error exporting feed:', err);
      return res.status(500).json({ error: 'Failed to export product feed' });
    }
  });

  return router;
}
