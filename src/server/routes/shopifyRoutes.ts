import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { 
  initiateShopifyConnect, 
  handleShopifyCallback, 
  disconnectShopify,
  getShopifyOAuthEnv,
  getValidShopifyAccessToken
} from '../shopify/oauthService';
import { syncShopifyCatalog, resumeShopifySync } from '../shopify/syncService';
import { 
  processShopifyWebhook, 
  registerShopifyWebhookSubscriptions,
  verifyShopifyWebhookSubscriptionsLive 
} from '../shopify/webhookService';
import { ShopifyPublicStatus } from '../shopify/types';

export function createShopifyRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

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
          installedAt: null,
          lastVerifiedAt: null,
          tokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          webhookStatus: 'inactive',
          activeWebhooks: [],
          latestSync,
          canResumeSync,
        };
        return res.json(status);
      }

      const activeWebhooks = (connection.webhookSubscriptions || []).map(w => 
        typeof w === 'string' ? w : w.topic
      );

      const status: ShopifyPublicStatus = {
        connected: connection.status === 'connected',
        status: connection.status,
        shopDomain: connection.shopDomain,
        grantedScopes: connection.grantedScopes.split(',').map(s => s.trim()).filter(Boolean),
        installedAt: connection.installedAt,
        lastVerifiedAt: connection.lastVerifiedAt,
        tokenExpiresAt: connection.tokenExpiresAt || null,
        refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
        webhookStatus: (activeWebhooks.length > 0) ? 'active' : 'inactive',
        activeWebhooks,
        latestSync,
        canResumeSync,
      };

      return res.json(status);
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error fetching status:', err);
      return res.status(500).json({ error: 'Failed to retrieve Shopify connection status' });
    }
  });

  // 2. GET /api/shopify/connect — Initiates Authorization Code Grant flow
  router.get('/connect', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const rawShop = String(req.query.shop || '');

      if (!rawShop) {
        return res.status(400).json({
          error: 'Missing required "shop" query parameter (e.g. ?shop=your-store.myshopify.com)',
        });
      }

      const connectResult = await initiateShopifyConnect(repo, workspaceId, rawShop);
      return res.json({
        success: true,
        authUrl: connectResult.authUrl,
        state: connectResult.state,
        shopDomain: connectResult.shopDomain,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Routes] Error initiating connect:', err);
      return res.status(400).json({ error: err.message || 'Failed to initiate Shopify connection' });
    }
  });

  // 3. GET /api/shopify/callback — Shopify OAuth redirect callback
  router.get('/callback', async (req, res) => {
    const { appUrl } = getShopifyOAuthEnv();

    try {
      const result = await handleShopifyCallback(repo, req.query);

      // If request accepts HTML/browser redirect:
      const acceptHeader = req.headers.accept || '';
      if (acceptHeader.includes('text/html')) {
        return res.redirect(`${appUrl}/?page=settings&tab=connectors&shopify=connected&shop=${encodeURIComponent(result.shopDomain)}`);
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
        return res.redirect(`${appUrl}/?page=settings&tab=connectors&shopify_error=${encodeURIComponent(err.message || 'Connection failed')}`);
      }

      return res.status(400).json({
        error: err.message || 'Shopify OAuth callback verification failed',
      });
    }
  });

  // 4. POST /api/shopify/sync — Triggers full paginated catalog synchronization
  router.post('/sync', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { maxPages, pageSize, resumeCursor } = req.body || {};
      const result = await syncShopifyCatalog(repo, workspaceId, {
        maxPages: typeof maxPages === 'number' ? maxPages : undefined,
        pageSize: typeof pageSize === 'number' ? pageSize : undefined,
        resumeCursor: typeof resumeCursor === 'string' ? resumeCursor : undefined,
      });

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
      console.error('[AIXSHOP Shopify Routes] Error syncing catalog:', err);
      return res.status(500).json({ error: err.message || 'Catalog synchronization failed' });
    }
  });

  // 4a. POST /api/shopify/sync/resume — Resumes partially completed sync from stored cursor
  router.post('/sync/resume', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { maxPages, pageSize, syncRunId } = req.body || {};
      const result = await resumeShopifySync(repo, workspaceId, {
        syncRunId: typeof syncRunId === 'string' ? syncRunId : undefined,
        maxPages: typeof maxPages === 'number' ? maxPages : undefined,
        pageSize: typeof pageSize === 'number' ? pageSize : undefined,
      });

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
      console.error('[AIXSHOP Shopify Routes] Error resuming catalog sync:', err);
      return res.status(500).json({ error: err.message || 'Resuming synchronization failed' });
    }
  });

  // 4b. POST /api/shopify/webhooks/register — Registers real webhooks via GraphQL
  router.post('/webhooks/register', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const connection = await repo.getShopifyConnection(workspaceId);
      if (!connection || connection.status !== 'connected') {
        return res.status(400).json({ error: 'Shopify is not currently connected' });
      }

      const { appUrl } = getShopifyOAuthEnv();
      const callbackUrl = `${appUrl}/api/shopify/webhooks`;
      const accessToken = await getValidShopifyAccessToken(repo, workspaceId);

      const results = await registerShopifyWebhookSubscriptions(
        connection.shopDomain,
        accessToken,
        callbackUrl
      );

      const successfulTopics = results.filter(r => r.success).map(r => r.topic);
      await repo.saveShopifyConnection({
        ...connection,
        webhookSubscriptions: successfulTopics,
        updatedAt: new Date().toISOString(),
      });

      return res.json({
        success: true,
        results,
        activeWebhooks: successfulTopics,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Webhooks] Registration error:', err);
      return res.status(500).json({ error: err.message || 'Failed to register webhooks' });
    }
  });

  // 4c. POST /api/shopify/webhooks/verify — Verifies live Shopify webhook subscriptions via Admin API
  router.post('/webhooks/verify', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
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
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Shopify Webhook] Webhook processing error:', err.message);
      // Return 401 for invalid HMAC, 500 for processing errors
      const status = err.message?.includes('HMAC') ? 401 : 500;
      return res.status(status).json({ error: err.message || 'Webhook processing failed' });
    }
  });

  return router;
}
