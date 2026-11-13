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
  ProductFeedEvaluation,
} from '../../domain/feed/feedValidationEngine';

const SUPPORTED_PLATFORMS: ReadonlySet<FeedPlatform> = new Set([
  'google_merchant_center',
  'meta_commerce',
  'schema_org',
]);

export function createFeedRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // POST /api/feed/validate — Evaluates catalog against platform feed requirements (local structural check)
  router.post('/validate', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const platform = (req.body?.platform || 'google_merchant_center') as FeedPlatform;
      if (!SUPPORTED_PLATFORMS.has(platform)) {
        return res.status(400).json({ error: `Unsupported feed platform "${platform}".` });
      }

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);
      const products: Product[] = catalog?.products || [];

      const report = evaluateFeedReadiness(products, platform, store?.currency || 'USD');

      res.setHeader('X-AIXSHOP-Validation-Scope', 'local_structural_check_only');
      res.setHeader('X-AIXSHOP-External-Platform-Accepted', 'false');

      return res.json({
        success: true,
        report,
      });
    } catch (err: any) {
      console.error('[Feed API] Error evaluating feed:', err);
      return res.status(500).json({ error: 'Failed to evaluate feed readiness' });
    }
  });

  // GET /api/feed/export — Exports feed in CSV or JSON format without fabricating missing fields
  router.get('/export', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const platform = ((req.query.platform as string) || 'google_merchant_center') as FeedPlatform;
      if (!SUPPORTED_PLATFORMS.has(platform)) {
        return res.status(400).json({ error: `Unsupported feed platform "${platform}".` });
      }

      const format = (req.query.format as string) || (platform === 'schema_org' ? 'json' : 'csv');
      if (format !== 'csv' && format !== 'json') {
        return res.status(400).json({ error: `Unsupported export format "${format}". Expected "csv" or "json".` });
      }

      const filter = (req.query.filter as string) || 'all'; // 'valid_only' or 'all'
      if (filter !== 'all' && filter !== 'valid_only') {
        return res.status(400).json({ error: `Unsupported filter "${filter}". Expected "all" or "valid_only".` });
      }

      const catalog = await repo.loadWorkspaceCatalog(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);
      const currency = store?.currency || 'USD';
      const allProducts: Product[] = catalog?.products || [];

      const report = evaluateFeedReadiness(allProducts, platform, currency);
      const evalByProductId = new Map<string, ProductFeedEvaluation>(
        report.evaluations.map((e) => [e.productId, e])
      );

      let products = allProducts;
      if (filter === 'valid_only') {
        products = allProducts.filter((p) => evalByProductId.get(p.id)?.isValid === true);
      }

      res.setHeader('X-AIXSHOP-Validation-Scope', 'local_structural_check_only');
      res.setHeader('X-AIXSHOP-External-Platform-Accepted', 'false');

      if (platform === 'schema_org' || format === 'json') {
        const jsonLdData = products.map((p: Product) => {
          const item = mapProductToSchemaOrgJsonLd(p, currency);
          if (filter === 'all') {
            const ev = evalByProductId.get(p.id);
            item.aixshopValidation = {
              validationScope: 'local_structural_check_only',
              externalPlatformAccepted: false,
              status: ev?.isValid ? 'valid' : 'invalid',
              errors: (ev?.errors || []).map((e) => `${e.field}: ${e.message}`),
            };
          }
          return item;
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${platform}_feed_${Date.now()}.json"`);
        return res.send(JSON.stringify(jsonLdData, null, 2));
      }

      if (platform === 'meta_commerce') {
        const rows = products.map((p: Product) => {
          const row = mapProductToMetaRow(p, currency);
          if (filter === 'all') {
            const ev = evalByProductId.get(p.id);
            row.validation_status = ev?.isValid ? 'valid' : 'invalid';
            row.validation_errors = (ev?.errors || []).map((e) => `${e.field}: ${e.message}`).join('; ');
          }
          return row;
        });
        const csv = exportToCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="meta_commerce_feed_${Date.now()}.csv"`);
        return res.send(csv);
      }

      // Default: Google Merchant Center CSV
      const rows = products.map((p: Product) => {
        const row = mapProductToGmcRow(p, currency);
        if (filter === 'all') {
          const ev = evalByProductId.get(p.id);
          row.validation_status = ev?.isValid ? 'valid' : 'invalid';
          row.validation_errors = (ev?.errors || []).map((e) => `${e.field}: ${e.message}`).join('; ');
        }
        return row;
      });
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
