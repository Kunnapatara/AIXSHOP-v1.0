import { Router } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, createWorkspaceRateLimiter } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  redactCatalogForPreliminaryAccess,
  resolveReportEntitlement,
} from '../services/entitlementService';

export function createAuditRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const auditRunLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'audit_run',
      maxAttempts: 20,
      windowMs: 60_000,
      message: 'Audit execution rate limit reached. Please wait a minute before starting another audit.',
    },
    repo
  );
  const auditReadLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'audit_read',
      maxAttempts: 60,
      windowMs: 60_000,
      message: 'Too many audit read requests. Please retry shortly.',
    },
    repo
  );

  // POST /api/audit/run — Start a catalog audit execution
  router.post('/run', requireAuth, auditRunLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const result = await repo.executeWorkspaceAudit(workspaceId);
      const [store, subscription] = await Promise.all([
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);
      const reportEntitlement = resolveReportEntitlement(store, subscription);
      const { catalog: safeCatalog, preliminarySummary } = redactCatalogForPreliminaryAccess(
        result.catalog,
        reportEntitlement,
        result.auditRun
      );

      return res.status(200).json({
        success: true,
        auditRun: result.auditRun,
        catalog: safeCatalog,
        reportEntitlement,
        preliminarySummary,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Run Error]:', err);
      return res.status(500).json({
        error: err?.message || 'Failed to execute catalog audit',
        code: 'AUDIT_EXECUTION_FAILED',
      });
    }
  });

  // GET /api/audit/history — Retrieve historical Audit Runs with pagination (workspace scoped)
  router.get('/history', requireAuth, auditReadLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const limitRaw = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const limit = isNaN(limitRaw) ? 20 : Math.min(Math.max(limitRaw, 1), 50);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

      const [history, store, subscription] = await Promise.all([
        repo.getAuditRunsHistory(workspaceId, { limit, cursor }),
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);
      const reportEntitlement = resolveReportEntitlement(store, subscription);

      const items = reportEntitlement.hasFullReportAccess
        ? history.items
        : history.items.map((item) => ({
            ...item,
            snapshotAvailable: false,
            lockedByPlan: true,
          }));

      return res.status(200).json({
        success: true,
        workspaceId,
        items,
        nextCursor: history.nextCursor,
        totalCount: history.totalCount,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit History Error]:', err);
      return res.status(500).json({
        error: 'Failed to retrieve audit history',
      });
    }
  });

  // GET /api/audit/compare — Compare two historical audit runs (workspace scoped, paid plans only)
  router.get('/compare', requireAuth, auditReadLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const baseId = typeof req.query.baseId === 'string' ? req.query.baseId.trim() : '';
      const targetId = typeof req.query.targetId === 'string' ? req.query.targetId.trim() : '';

      if (!baseId || !targetId) {
        return res.status(400).json({
          error: 'Both baseId and targetId query parameters are required for audit comparison',
          code: 'COMPARISON_PARAMS_REQUIRED',
        });
      }

      const [store, subscription] = await Promise.all([
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);
      const reportEntitlement = resolveReportEntitlement(store, subscription);
      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      const comparison = await repo.compareHistoricalAudits(workspaceId, baseId, targetId);

      if (!comparison) {
        return res.status(404).json({
          error: 'One or both audit runs could not be found or do not belong to your workspace',
          code: 'AUDIT_RUNS_NOT_FOUND',
        });
      }

      return res.status(200).json({
        success: true,
        workspaceId,
        comparison,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Compare Error]:', err);
      return res.status(500).json({
        error: 'Failed to compare historical audit runs',
      });
    }
  });

  // GET /api/audit/latest — Get the latest audit run for authenticated workspace
  router.get('/latest', requireAuth, auditReadLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const [auditRun, store, subscription] = await Promise.all([
        repo.getLatestAuditRunByWorkspace(workspaceId),
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);
      const reportEntitlement = resolveReportEntitlement(store, subscription);

      return res.status(200).json({
        workspaceId,
        auditRun,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Latest Error]:', err);
      return res.status(500).json({
        error: 'Failed to retrieve latest audit run',
      });
    }
  });

  // GET /api/audit/:id — Get a specific audit run by ID with historical snapshots (workspace scoped, paid plans only)
  router.get('/:id', requireAuth, auditReadLimiter, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const auditRunId = req.params.id;

      if (!auditRunId || typeof auditRunId !== 'string') {
        return res.status(400).json({ error: 'Audit run ID is required' });
      }

      const snapshot = await repo.getHistoricalAuditSnapshot(workspaceId, auditRunId);

      if (!snapshot) {
        return res.status(404).json({
          error: 'Audit run not found or does not belong to your workspace',
          code: 'AUDIT_NOT_FOUND',
        });
      }

      const [store, subscription] = await Promise.all([
        repo.getStoreByWorkspace(workspaceId),
        repo.getSubscriptionByWorkspace(workspaceId),
      ]);
      const reportEntitlement = resolveReportEntitlement(store, subscription);

      if (!reportEntitlement.hasFullReportAccess) {
        return res.status(403).json({
          error: reportEntitlement.reasonMessage,
          code: 'REPORT_PAYMENT_REQUIRED',
          reportEntitlement,
        });
      }

      return res.status(200).json({
        success: true,
        workspaceId,
        auditRun: snapshot.auditRun,
        findings: snapshot.findings,
        evidence: snapshot.evidence,
        products: snapshot.products,
        snapshotAvailable: snapshot.snapshotAvailable,
        message: snapshot.message,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Fetch Error]:', err);
      return res.status(500).json({
        error: 'Failed to retrieve audit run',
      });
    }
  });

  return router;
}
