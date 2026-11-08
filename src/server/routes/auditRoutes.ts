import { Router } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';

export function createAuditRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // POST /api/audit/run — Start a real catalog audit execution
  router.post('/run', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const result = await repo.executeWorkspaceAudit(workspaceId);

      return res.status(200).json({
        success: true,
        auditRun: result.auditRun,
        catalog: result.catalog,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Run Error]:', err);
      return res.status(500).json({
        error: err?.message || 'Failed to execute catalog audit',
        code: 'AUDIT_EXECUTION_FAILED',
      });
    }
  });

  // GET /api/audit/latest — Get the latest audit run for authenticated workspace
  router.get('/latest', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const auditRun = await repo.getLatestAuditRunByWorkspace(workspaceId);

      return res.status(200).json({
        workspaceId,
        auditRun,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Audit Latest Error]:', err);
      return res.status(500).json({
        error: 'Failed to retrieve latest audit run',
      });
    }
  });

  // GET /api/audit/:id — Get a specific audit run by ID (workspace scoped)
  router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = req.workspace!.id;
      const auditRunId = req.params.id;

      if (!auditRunId || typeof auditRunId !== 'string') {
        return res.status(400).json({ error: 'Audit run ID is required' });
      }

      const auditRun = await repo.getAuditRunById(auditRunId, workspaceId);

      if (!auditRun) {
        return res.status(404).json({
          error: 'Audit run not found or does not belong to your workspace',
          code: 'AUDIT_NOT_FOUND',
        });
      }

      return res.status(200).json({
        workspaceId,
        auditRun,
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
