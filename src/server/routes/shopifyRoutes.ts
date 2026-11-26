import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import {
  createAuthMiddleware,
  createWorkspaceRateLimiter,
  OperationInProgressError,
  requireRole,
  withWorkspaceOperationLease,
} from '../middleware/auth';
import { AuthRequest } from '../types';
import { 
  initiateShopifyConnect, 
  handleShopifyCallback, 
  disconnectShopify,
  getShopifyOAuthEnv,
  getValidShopifyAccessToken,
  hasShopifyWriteScope,
} from '../shopify/oauthService';
import { syncShopifyCatalog, resumeShopifySync } from '../shopify/syncService';
import { 
  processShopifyWebhook, 
  registerShopifyWebhookSubscriptions,
  verifyShopifyWebhookSubscriptionsLive 
} from '../shopify/webhookService';
import { executeShopifyWriteBack, ShopifyWriteBackError } from '../shopify/writeBackService';
import { ShopifyPublicStatus } from '../shopify/types';
import { getTrustedBaseUrl, resolveTrustedRedirectUrl } from '../config/productionConfig';

export function createShopifyRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const shopifySyncLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'shopify_sync',
      maxAttempts: 10,
      windowMs: 60_000,
      message: 'Shopify sync rate limit exceeded. Please wait before starting another sync.',
    },
    repo
  );
  const shopifyControlLimiter = createWorkspaceRateLimiter(
    {
      keyPrefix: 'shopify_ctrl',
      maxAttempts: 20,
      windowMs: 60_000,
      message: 'Shopify integration rate limit exceeded. Please retry shortly.',
    },
    repo
  );

  // 1. GET /api/shopify/status — Retrieves workspace connection status (NO SECRETS EXPOSED)
  router.get('/status', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const connection = await repo.getShopifyConnection(workspaceId);
      const latestSync = await repo.getLatestShopifySyncRun(workspaceId);

      const canResumeSync = Boolean(
        latestSync?.status === 'partially_completed' && latestSync?.cursorResumed
      );

      if (!connection || connection.status === 'disconnected') {
        const status: ShopifyPublicStatus = {
          connected: false,
          status: 'not_connected',
          shopDomain: connection?.shopDomain || null,
          grantedScopes: [],
          writeBackAuthorized: false,
          installedAt: null,
          lastVerifiedAt: null,
          tokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          webhookStatus: 'not_configured',
          activeWebhooks: [],
          latestSync,
          canResumeSync,
          webhookDetails: {
            verificationMode: 'cached',
            isLiveVerified: false,
            requiredTopics: ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'],
            verifiedTopics: [],
            missingTopics: ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'],
            mismatchedSubscriptions: [],
            webhookLastVerifiedAt: null,
            lastVerifiedAt: null,
            isFresh: false,
          },
        };
        return res.json(status);
      }

      const verifyMode = String(req.query.verify || '').toLowerCase();
      if (verifyMode === 'live') {
        const liveResult = await verifyShopifyWebhookSubscriptionsLive(repo, workspaceId);
        const refreshedConnection = (await repo.getShopifyConnection(workspaceId)) || connection;
        const activeWebhooks = liveResult.liveSubscriptions.map(w => w.topic);
        const status: ShopifyPublicStatus = {
          connected: refreshedConnection.status === 'connected',
          status: refreshedConnection.status,
          shopDomain: refreshedConnection.shopDomain,
          grantedScopes: refreshedConnection.grantedScopes.split(',').map(s => s.trim()).filter(Boolean),
          writeBackAuthorized:
            refreshedConnection.status === 'connected' &&
            hasShopifyWriteScope(refreshedConnection.grantedScopes),
          installedAt: refreshedConnection.installedAt,
          lastVerifiedAt: refreshedConnection.lastVerifiedAt,
          tokenExpiresAt: refreshedConnection.tokenExpiresAt || null,
          refreshTokenExpiresAt: refreshedConnection.refreshTokenExpiresAt || null,
          webhookStatus: liveResult.status,
          activeWebhooks,
          latestSync,
          canResumeSync,
          webhookDetails: {
            verificationMode: 'live',
            isLiveVerified: liveResult.verified,
            requiredTopics: liveResult.requiredTopics,
            verifiedTopics: liveResult.activeTopics,
            missingTopics: liveResult.missingTopics,
            mismatchedSubscriptions: liveResult.mismatchedSubscriptions,
            webhookLastVerifiedAt: liveResult.webhookLastVerifiedAt,
            lastVerifiedAt: liveResult.webhookLastVerifiedAt,
            isFresh: Boolean(liveResult.webhookLastVerifiedAt),
            completenessStatus: liveResult.completenessStatus,
            error: liveResult.status === 'verification_unavailable' ? liveResult.message : undefined,
          },
        };
        return res.json(status);
      }

      const requiredTopics = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'];
      const storedSubs = connection.webhookSubscriptions || [];
      const activeWebhooks = storedSubs.map(w => typeof w === 'string' ? w : w.topic);

      const webhookVerifiedIso = connection.webhookLastVerifiedAt || null;
      const webhookVerifiedTime = webhookVerifiedIso ? new Date(webhookVerifiedIso).getTime() : 0;
      const isFresh = Boolean(webhookVerifiedTime && (Date.now() - webhookVerifiedTime) < (24 * 60 * 60 * 1000));

      // Cached reads must never masquerade as active live verification
      const storedStatus = connection.webhookVerificationStatus;
      let cachedWebhookStatus: import('../shopify/types').WebhookStatusCategory = 'registered_unverified';
      if (storedSubs.length === 0 && (!storedStatus || storedStatus === 'not_configured')) {
        cachedWebhookStatus = 'not_configured';
      } else if (storedStatus === 'verification_unavailable' || storedStatus === 'verification_incomplete' || storedStatus === 'mismatch' || storedStatus === 'partially_registered' || storedStatus === 'registered_unverified') {
        cachedWebhookStatus = storedStatus;
      } else if (storedStatus === 'active' || storedSubs.length > 0) {
        cachedWebhookStatus = 'registered_unverified';
      } else {
        cachedWebhookStatus = 'unverified';
      }

      const details = connection.webhookVerificationDetails || {};
      const status: ShopifyPublicStatus = {
        connected: connection.status === 'connected',
        status: connection.status,
        shopDomain: connection.shopDomain,
        grantedScopes: connection.grantedScopes.split(',').map(s => s.trim()).filter(Boolean),
        writeBackAuthorized:
          connection.status === 'connected' &&
          hasShopifyWriteScope(connection.grantedScopes),
        installedAt: connection.installedAt,
        lastVerifiedAt: connection.lastVerifiedAt,
        tokenExpiresAt: connection.tokenExpiresAt || null,
        refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
        webhookStatus: cachedWebhookStatus,
        activeWebhooks,
        latestSync,
        canResumeSync,
        webhookDetails: {
          verificationMode: 'cached',
          isLiveVerified: false,
          requiredTopics,
          verifiedTopics: Array.isArray(details.activeTopics) ? details.activeTopics : [],
          missingTopics: Array.isArray(details.missingTopics) ? details.missingTopics : requiredTopics.filter(t => !activeWebhooks.map(a => a.toUpperCase()).includes(t)),
          mismatchedSubscriptions: Array.isArray(details.mismatchedSubscriptions) ? details.mismatchedSubscriptions : [],
          webhookLastVerifiedAt: webhookVerifiedIso,
          lastVerifiedAt: webhookVerifiedIso,
          isFresh,
          completenessStatus: details.completenessStatus,
          error: details.error,
        },
      };

      return res.json(status);
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error fetching status:', err);
      return res.status(500).json({ error: 'Failed to retrieve Shopify connection status' });
    }
  });

  // 2. GET /api/shopify/connect — Initiates Authorization Code Grant flow
  router.get('/connect', requireAuth, requireRole(['owner', 'admin']), shopifyControlLimiter, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const rawShop = String(req.query.shop || '');

      if (!rawShop) {
        return res.status(400).json({
          error: 'Missing required "shop" query parameter (e.g. ?shop=your-store.myshopify.com)',
        });
      }

      const writeAccess = String(req.query.writeAccess || '').toLowerCase() === 'true';
      const connectResult = await initiateShopifyConnect(repo, workspaceId, rawShop, { writeAccess });
      return res.json({
        success: true,
        authUrl: connectResult.authUrl,
        state: connectResult.state,
        shopDomain: connectResult.shopDomain,
        scopes: connectResult.scopes,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error initiating connect:', err);
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({ error: err.message || 'Failed to initiate Shopify connection', code: err?.code });
    }
  });

  // 3. GET /api/shopify/callback — Shopify OAuth redirect callback
  router.get('/callback', async (req, res) => {
    const resolveRedirectBase = (): string => {
      const { appUrl } = getShopifyOAuthEnv();
      if (process.env.NODE_ENV === 'production') {
        return appUrl;
      }
      return appUrl || getTrustedBaseUrl(req);
    };

    try {
      const result = await handleShopifyCallback(repo, req.query);

      const acceptHeader = req.headers.accept || '';
      if (acceptHeader.includes('text/html')) {
        const base = resolveRedirectBase();
        const redirectTarget = resolveTrustedRedirectUrl(
          base,
          `/?page=settings&tab=connectors&shopify=connected&shop=${encodeURIComponent(result.shopDomain)}`,
          '/?page=settings&tab=connectors'
        );
        return res.redirect(redirectTarget);
      }

      return res.json({
        success: true,
        message: `Successfully connected ${result.shopDomain}`,
        shopDomain: result.shopDomain,
        grantedScopes: result.grantedScopes,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] OAuth callback error:', err);
      const acceptHeader = req.headers.accept || '';
      if (acceptHeader.includes('text/html')) {
        try {
          const base = resolveRedirectBase();
          const redirectTarget = resolveTrustedRedirectUrl(
            base,
            `/?page=settings&tab=connectors&shopify_error=${encodeURIComponent(err.message || 'Connection failed')}`,
            '/?page=settings&tab=connectors'
          );
          return res.redirect(redirectTarget);
        } catch (cfgErr: any) {
          return res.status(500).json({ error: cfgErr.message || 'Trusted application URL configuration invalid', code: cfgErr?.code });
        }
      }

      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({
        error: err.message || 'Shopify OAuth callback verification failed',
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  });

  // 4. POST /api/shopify/sync — Triggers full paginated catalog synchronization with workspace operation lease
  router.post('/sync', requireAuth, requireRole(['owner', 'admin']), shopifySyncLimiter, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { maxPages, pageSize, resumeCursor } = req.body || {};
      const clampedMaxPages = typeof maxPages === 'number' && Number.isFinite(maxPages)
        ? Math.min(Math.max(Math.trunc(maxPages), 1), 50)
        : undefined;
      const clampedPageSize = typeof pageSize === 'number' && Number.isFinite(pageSize)
        ? Math.min(Math.max(Math.trunc(pageSize), 1), 100)
        : undefined;

      const result = await withWorkspaceOperationLease(repo, workspaceId, 'shopify_sync', 300_000, () =>
        syncShopifyCatalog(repo, workspaceId, {
          maxPages: clampedMaxPages,
          pageSize: clampedPageSize,
          resumeCursor: typeof resumeCursor === 'string' ? resumeCursor : undefined,
        })
      );

      return res.json({
        success: true,
        syncRun: result.syncRun,
        productsDiscovered: result.productsDiscovered,
        productsImported: result.productsImported,
        variantsImported: result.variantsImported,
        excludedByPlan: result.excludedByPlan,
        status: result.status,
        message: result.message,
      });
    } catch (err: any) {
      if (err instanceof OperationInProgressError || err?.code === 'OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          error: err.message,
          code: 'OPERATION_IN_PROGRESS',
          operationKey: err.operationKey,
        });
      }
      console.error('[AIXSHOP Shopify Routes] Error syncing catalog:', err);
      return res.status(500).json({ error: err.message || 'Catalog synchronization failed' });
    }
  });

  // 4a. POST /api/shopify/sync/resume — Resumes partially completed sync from stored cursor with workspace operation lease
  router.post('/sync/resume', requireAuth, requireRole(['owner', 'admin']), shopifySyncLimiter, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { maxPages, pageSize, syncRunId } = req.body || {};
      const clampedMaxPages = typeof maxPages === 'number' && Number.isFinite(maxPages)
        ? Math.min(Math.max(Math.trunc(maxPages), 1), 50)
        : undefined;
      const clampedPageSize = typeof pageSize === 'number' && Number.isFinite(pageSize)
        ? Math.min(Math.max(Math.trunc(pageSize), 1), 100)
        : undefined;

      const result = await withWorkspaceOperationLease(repo, workspaceId, 'shopify_sync', 300_000, () =>
        resumeShopifySync(repo, workspaceId, {
          syncRunId: typeof syncRunId === 'string' ? syncRunId : undefined,
          maxPages: clampedMaxPages,
          pageSize: clampedPageSize,
        })
      );

      return res.json({
        success: true,
        syncRun: result.syncRun,
        productsDiscovered: result.productsDiscovered,
        productsImported: result.productsImported,
        variantsImported: result.variantsImported,
        excludedByPlan: result.excludedByPlan,
        status: result.status,
        message: result.message,
      });
    } catch (err: any) {
      if (err instanceof OperationInProgressError || err?.code === 'OPERATION_IN_PROGRESS') {
        return res.status(409).json({
          error: err.message,
          code: 'OPERATION_IN_PROGRESS',
          operationKey: err.operationKey,
        });
      }
      console.error('[AIXSHOP Shopify Routes] Error resuming catalog sync:', err);
      return res.status(500).json({ error: err.message || 'Resuming synchronization failed' });
    }
  });

  // 4b. POST /api/shopify/webhooks/register — Registers real webhooks via GraphQL
  router.post('/webhooks/register', requireAuth, requireRole(['owner', 'admin']), shopifyControlLimiter, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const connection = await repo.getShopifyConnection(workspaceId);
      if (!connection || connection.status !== 'connected') {
        return res.status(400).json({ error: 'Shopify is not currently connected' });
      }

      const { webhookUrl } = getShopifyOAuthEnv();
      const callbackUrl = webhookUrl;
      const accessToken = await getValidShopifyAccessToken(repo, workspaceId);

      const results = await registerShopifyWebhookSubscriptions(
        connection.shopDomain,
        accessToken,
        callbackUrl
      );

      const successfulResults = results.filter(r => r.success);
      const successfulTopics = successfulResults.map(r => r.topic);
      const nowIso = new Date().toISOString();
      await repo.saveShopifyConnection({
        ...connection,
        webhookSubscriptions: successfulResults.map(r => ({
          id: r.id || `registered_${r.topic}`,
          topic: r.topic,
          callbackUrl,
          active: false,
          status: 'unverified' as const,
        })),
        webhookVerificationStatus: successfulTopics.length > 0 ? 'registered_unverified' : 'not_configured',
        webhookVerificationDetails: {
          registeredAt: nowIso,
          registeredTopics: successfulTopics,
          expectedCallbackUrl: callbackUrl,
          verificationMode: 'cached',
        },
        updatedAt: nowIso,
      });

      return res.json({
        success: true,
        results,
        activeWebhooks: successfulTopics,
        webhookStatus: successfulTopics.length > 0 ? 'registered_unverified' : 'not_configured',
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Webhooks] Registration error:', err);
      return res.status(500).json({ error: err.message || 'Failed to register webhooks' });
    }
  });

  // 4c. POST /api/shopify/webhooks/verify — Verifies live Shopify webhook subscriptions via Admin API
  router.post('/webhooks/verify', requireAuth, requireRole(['owner', 'admin']), shopifyControlLimiter, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const result = await verifyShopifyWebhookSubscriptionsLive(repo, workspaceId);

      return res.json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Webhooks] Verification error:', err);
      return res.status(500).json({ error: err.message || 'Failed to verify webhooks' });
    }
  });

  // 4d. GET /api/shopify/sync/runs — Lists recent sync runs for UI operational monitoring
  router.get('/sync/runs', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
      const runs = await repo.getShopifySyncRuns(workspaceId, limit);
      return res.json({ success: true, syncRuns: runs, runs });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error fetching sync runs:', err);
      return res.status(500).json({ error: 'Failed to retrieve sync runs' });
    }
  });

  // 5. POST /api/shopify/disconnect — Safely removes tokens and marks disconnected
  router.post('/disconnect', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const result = await disconnectShopify(repo, workspaceId);

      return res.json(result);
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error disconnecting Shopify:', err);
      return res.status(500).json({ error: err.message || 'Failed to disconnect Shopify' });
    }
  });

  // 6. POST /api/shopify/webhooks — Verified webhook receiver
  router.post('/webhooks', async (req, res) => {
    try {
      const rawBody = (req as any).rawBody || req.body;
      if (!rawBody) {
        return res.status(400).json({ error: 'Missing raw request body for webhook HMAC verification' });
      }

      const result = await processShopifyWebhook(repo, rawBody, req.headers);
      if (result.outcome === 'CURRENTLY_PROCESSING' || result.inProgress) {
        return res.status(202).json({
          success: false,
          inProgress: true,
          ...result,
        });
      }

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Webhook] Webhook processing error:', err.message);
      const status =
        typeof err.statusCode === 'number'
          ? err.statusCode
          : err.message?.includes('HMAC')
          ? 401
          : 500;
      return res.status(status).json({ error: err.message || 'Webhook processing failed' });
    }
  });

  // 7. POST /api/shopify/write-back/:actionId — Executes approved remediation write-back to Shopify Admin API with read-back verification
  router.post(
    '/write-back/:actionId',
    requireAuth,
    requireRole(['owner', 'admin']),
    shopifyControlLimiter,
    async (req: AuthRequest, res: Response) => {
      try {
        const workspaceId = req.workspace!.id;
        const operatorUserId = req.user!.id;
        const actionId = req.params.actionId;
        const idempotencyKey =
          typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined;

        const result = await executeShopifyWriteBack(repo, {
          workspaceId,
          actionId,
          operatorUserId,
          idempotencyKey,
        });

        return res.status(200).json({
          success: true,
          operation: result.operation,
          action: result.action,
          catalogVersion: result.catalogVersion,
        });
      } catch (err: any) {
        if (err instanceof OperationInProgressError || err?.code === 'OPERATION_IN_PROGRESS') {
          return res.status(409).json({
            error: err.message,
            code: 'OPERATION_IN_PROGRESS',
            operationKey: err.operationKey,
          });
        }
        if (err instanceof ShopifyWriteBackError) {
          return res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
            ...(err.operation ? { operation: err.operation } : {}),
          });
        }
        console.error('[AIXSHOP Shopify Write-Back] Unexpected error:', err);
        return res.status(500).json({
          error: 'Failed to execute Shopify write-back operation.',
          code: 'SHOPIFY_WRITEBACK_ERROR',
        });
      }
    }
  );

  // 8. GET /api/shopify/write-back/history — Lists workspace Shopify write-back operations
  router.get('/write-back/history', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
      const operations = await repo.listShopifyWriteBackOperations(workspaceId, limit);
      return res.json({
        success: true,
        workspaceId,
        operations,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Write-Back] History load error:', err);
      return res.status(500).json({ error: 'Failed to load Shopify write-back history' });
    }
  });

  return router;
}
