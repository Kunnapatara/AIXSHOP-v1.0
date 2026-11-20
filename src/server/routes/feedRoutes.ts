import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, createWorkspaceRateLimiter } from '../middleware/auth';
import { AuthRequest } from '../types';
import { Product } from '../../types';
import {
  evaluateFeedReadiness,
  mapProductVariantsToGmcRows,
  mapProductVariantsToMetaRows,
  mapProductToSchemaOrgJsonLd,
  exportToCsv,
  FeedPlatform,
  ProductFeedEvaluation,
} from '../../domain/feed/feedValidationEngine';
import { resolveReportEntitlement } from '../services/entitlementService';

const SUPPORTED_PLATFORMS: ReadonlySet<FeedPlatform> = new Set([
  'google_merchant_center',
  'meta_commerce',
  'schema_org',
]);

const MAX_EXPORT_PRODUCTS = 5000;

export function createFeedRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const feedLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'feed_ops',
      maxAttempts: 20,
      windowMs: 60_000,
      message: 'Feed validation/export rate limit exceeded. Please retry shortly.',
    },
    repo
  );

  // POST /api/feed/validate — Evaluates catalog against platform feed requirements (paid plans only)
  router.post('/validate', requireAuth, feedLimiter, async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const workspaceId = req.workspace!.id;
      const platform = (req.body?.platform || 'google_merchant_center') as FeedPlatform;
      if (!SUPPORTED_PLATFORMS.has(platform)) {
        return res.status(400).json({ error: `Unsupported feed platform "${platform}".` });
      }

      const [catalog, store, subscription] = await Promise.all([
        repo.loadWorkspaceCatalog(workspaceId),
        repo.getStoreByWorkspace(workspaceId),
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

      const products: Product[] = catalog?.products || [];
      const fullReport = evaluateFeedReadiness(products, platform, store?.currency || 'USD');

      res.setHeader('X-AIXSHOP-Validation-Scope', 'local_structural_check_only');
      res.setHeader('X-AIXSHOP-External-Platform-Accepted', 'false');

      return res.json({
        success: true,
        report: fullReport,
        reportEntitlement,
        isLocked: false,
      });
    } catch (err: any) {
      console.error('[Feed API] Error evaluating feed:', err);
      return res.status(500).json({ error: 'Failed to evaluate feed readiness' });
    }
  });

  // GET /api/feed/export — Exports feed in CSV or JSON format (requires active paid subscription)
  router.get('/export', requireAuth, feedLimiter, async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
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

      const [catalog, store, subscription] = await Promise.all([
        repo.loadWorkspaceCatalog(workspaceId),
        repo.getStoreByWorkspace(workspaceId),
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

      const currency = store?.currency || 'USD';
      const rawProducts: Product[] = catalog?.products || [];
      const isTruncated = rawProducts.length > MAX_EXPORT_PRODUCTS;
      const allProducts = isTruncated ? rawProducts.slice(0, MAX_EXPORT_PRODUCTS) : rawProducts;

      const report = evaluateFeedReadiness(allProducts, platform, currency);
      const evalByProductId = new Map<string, ProductFeedEvaluation>(
        report.evaluations.map((e) => [e.productId, e])
      );

      let products = allProducts;
      const skippedSummaries: Array<{ productId: string; reasons: string[] }> = [];
      if (filter === 'valid_only') {
        products = [];
        for (const p of allProducts) {
          const ev = evalByProductId.get(p.id);
          if (ev?.isValid) {
            products.push(p);
          } else {
            skippedSummaries.push({
              productId: p.id,
              reasons: (ev?.errors || []).map((e) => `${e.field}: ${e.message}`),
            });
          }
        }
      }

      res.setHeader('X-AIXSHOP-Validation-Scope', 'local_structural_check_only');
      res.setHeader('X-AIXSHOP-External-Platform-Accepted', 'false');
      res.setHeader('X-AIXSHOP-Exported-Products', String(products.length));
      res.setHeader('X-AIXSHOP-Skipped-Products', String(skippedSummaries.length));
      if (isTruncated) {
        res.setHeader('X-AIXSHOP-Export-Truncated', 'true');
        res.setHeader('X-AIXSHOP-Export-Max-Products', String(MAX_EXPORT_PRODUCTS));
      }
      if (skippedSummaries.length > 0) {
        const serializedSkipped = JSON.stringify(skippedSummaries.slice(0, 20));
        res.setHeader('X-AIXSHOP-Skipped-Reasons', serializedSkipped.slice(0, 2048));
      }

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
        const rows = products.flatMap((p: Product) => {
          const ev = evalByProductId.get(p.id);
          return mapProductVariantsToMetaRows(p, currency).map((row) => {
            if (filter === 'all') {
              row.validation_status = ev?.isValid ? 'valid' : 'invalid';
              row.validation_errors = (ev?.errors || []).map((e) => `${e.field}: ${e.message}`).join('; ');
            }
            return row;
          });
        });
        const csv = exportToCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="meta_commerce_feed_${Date.now()}.csv"`);
        return res.send(csv);
      }

      // Default: Google Merchant Center CSV
      const rows = products.flatMap((p: Product) => {
        const ev = evalByProductId.get(p.id);
        return mapProductVariantsToGmcRows(p, currency).map((row) => {
          if (filter === 'all') {
            row.validation_status = ev?.isValid ? 'valid' : 'invalid';
            row.validation_errors = (ev?.errors || []).map((e) => `${e.field}: ${e.message}`).join('; ');
          }
          return row;
        });
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
