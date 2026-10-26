import { Router, Request, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getBillingProvider } from '../billing/providerAdapter';
import { BillingService } from '../services/billingService';
import { AUTHORITATIVE_PLANS } from '../billing/types';

export function createBillingRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const provider = getBillingProvider();
  const billingService = new BillingService(repo, provider);

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

      const defaultBaseUrl = req.headers.origin || `http://${req.headers.host || 'localhost:3000'}`;
      const effectiveSuccessUrl = successUrl || `${defaultBaseUrl}/settings?tab=subscription&session_id={CHECKOUT_SESSION_ID}`;
      const effectiveCancelUrl = cancelUrl || `${defaultBaseUrl}/settings?tab=subscription`;

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
      console.error('[AIXSHOP Billing] Error creating checkout session:', err);
      return res.status(400).json({ error: err.message || 'Failed to create checkout session' });
    }
  });

  // POST /api/billing/portal-session — Customer portal session for managing payment methods / canceling
  router.post('/portal-session', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { returnUrl } = req.body || {};

      const defaultBaseUrl = req.headers.origin || `http://${req.headers.host || 'localhost:3000'}`;
      const effectiveReturnUrl = returnUrl || `${defaultBaseUrl}/settings?tab=subscription`;

      const portal = await billingService.createPortalSession(workspaceId, effectiveReturnUrl);

      return res.json({
        success: true,
        portalUrl: portal.portalUrl,
        provider: portal.provider,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error creating portal session:', err);
      return res.status(400).json({ error: err.message || 'Failed to create customer portal session' });
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

      // Convert body to string if already parsed by express.json()
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

      const result = await billingService.handleWebhook(rawBody, signature);

      return res.status(200).json({
        received: true,
        action: result.action,
        message: result.message,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Webhook processing error:', err.message || err);
      const statusCode = err.statusCode || 400;
      return res.status(statusCode).json({
        error: err.message || 'Webhook processing failed',
      });
    }
  });

  return router;
}
