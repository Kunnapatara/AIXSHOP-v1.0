import { Router, Request, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getBillingProvider } from '../billing/providerAdapter';
import { BillingLeaseConfig, BillingService } from '../services/billingService';
import { AUTHORITATIVE_PLANS, IBillingProvider } from '../billing/types';
import { getTrustedBaseUrl, resolveTrustedRedirectUrl } from '../config/productionConfig';

export function createBillingRoutes(
  repo: DatabaseRepository,
  customProvider?: IBillingProvider,
  billingLeaseConfig?: BillingLeaseConfig
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const getProvider = () => customProvider || getBillingProvider();
  const getBillingService = () => new BillingService(repo, getProvider(), billingLeaseConfig);

  // GET /api/billing/plans — Returns authoritative server-defined plans and capacities
  router.get('/plans', (req, res) => {
    return res.json({
      plans: Object.values(AUTHORITATIVE_PLANS),
      currency: 'USD',
    });
  });

  // GET /api/billing/subscription — Returns active workspace subscription & capacity status
  router.get('/subscription', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);

      return res.json({
        workspaceId,
        subscription: subscription || {
          tier: store?.tier || 'Free Audit',
          status: 'active',
          provider: 'none',
          cancelAtPeriodEnd: false,
        },
        storeProfile: store,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error loading subscription:', err);
      return res.status(500).json({ error: 'Failed to retrieve subscription information' });
    }
  });

  // POST /api/billing/checkout-session — Initiates checkout session via provider
  router.post('/checkout-session', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { tier, successUrl, cancelUrl } = req.body || {};

      if (!tier || typeof tier !== 'string') {
        return res.status(400).json({ error: 'Plan tier is required' });
      }

      const trustedBaseUrl = getTrustedBaseUrl(req);
      const effectiveSuccessUrl = resolveTrustedRedirectUrl(
        trustedBaseUrl,
        successUrl,
        '/settings?tab=subscription&session_id={CHECKOUT_SESSION_ID}'
      );
      const effectiveCancelUrl = resolveTrustedRedirectUrl(
        trustedBaseUrl,
        cancelUrl,
        '/settings?tab=subscription'
      );

      const billingService = getBillingService();
      const session = await billingService.createCheckoutSession(
        workspaceId,
        tier as any,
        effectiveSuccessUrl,
        effectiveCancelUrl
      );

      return res.json({
        success: true,
        sessionId: session.sessionId,
        checkoutUrl: session.checkoutUrl,
        provider: session.provider,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error creating checkout session:', err?.message || err);
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({ error: err.message || 'Failed to create checkout session', code: err?.code });
    }
  });

  // POST /api/billing/portal-session — Customer portal session for managing payment methods / canceling
  router.post('/portal-session', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { returnUrl } = req.body || {};

      const trustedBaseUrl = getTrustedBaseUrl(req);
      const effectiveReturnUrl = resolveTrustedRedirectUrl(
        trustedBaseUrl,
        returnUrl,
        '/settings?tab=subscription'
      );

      const billingService = getBillingService();
      const portal = await billingService.createPortalSession(workspaceId, effectiveReturnUrl);

      return res.json({
        success: true,
        portalUrl: portal.portalUrl,
        provider: portal.provider,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error creating portal session:', err?.message || err);
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({ error: err.message || 'Failed to create customer portal session', code: err?.code });
    }
  });

  // POST /api/billing/webhook — Cryptographically verified webhook listener with idempotency
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const signature = (
        req.headers['stripe-signature'] || 
        req.headers['x-webhook-signature'] || 
        req.headers['x-signature'] || 
        ''
      ) as string;

      if (!signature) {
        return res.status(400).json({ error: 'Missing webhook signature header' });
      }

      // Preserves original raw request bytes captured by scoped raw-body middleware
      const rawBody = (req as any).rawBody || req.body;

      const billingService = getBillingService();
      const result = await billingService.handleWebhook(rawBody, signature);

      if (result.inProgress || result.retryable) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({
          received: false,
          inProgress: Boolean(result.inProgress),
          retryable: true,
          action: result.action,
          message: result.message,
        });
      }

      return res.status(200).json({
        received: true,
        action: result.action,
        message: result.message,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Webhook processing error:', err.message || err);
      const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 503;
      if (statusCode === 503) {
        res.setHeader('Retry-After', '30');
      }
      return res.status(statusCode).json({
        error: err.message || 'Webhook processing failed',
        ...(err?.code ? { code: err.code } : {}),
        ...(statusCode === 503 ? { retryable: true } : {}),
      });
    }
  });

  return router;
}

