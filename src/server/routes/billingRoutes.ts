import { Router, Request, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getBillingProvider } from '../billing/providerAdapter';
import { BillingService } from '../services/billingService';
import { AUTHORITATIVE_PLANS, IBillingProvider } from '../billing/types';

/**
 * Derives trusted base URL from application configuration (APP_URL)
 * or falls back to verified request origin / host for local development.
 */
function getTrustedBaseUrl(req: Request): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${host}`;
}

/**
 * Validates and resolves redirect URLs against trusted application base URL.
 * Arbitrary third-party redirect URLs are rejected to prevent open redirect vulnerabilities.
 */
function resolveTrustedRedirectUrl(baseUrl: string, clientUrl: string | undefined, defaultPath: string): string {
  if (!clientUrl || typeof clientUrl !== 'string') {
    return `${baseUrl}${defaultPath}`;
  }

  // Safe relative paths (e.g. /settings?tab=subscription) are appended to trusted baseUrl
  if (clientUrl.startsWith('/')) {
    return `${baseUrl}${clientUrl}`;
  }

  try {
    const parsedClient = new URL(clientUrl);
    const parsedBase = new URL(baseUrl);
    // Only accept absolute URLs whose origin strictly matches the trusted application origin
    if (parsedClient.origin === parsedBase.origin) {
      return clientUrl;
    }
  } catch {
    // Malformed URL, fall back to trusted default
  }

  return `${baseUrl}${defaultPath}`;
}

export function createBillingRoutes(repo: DatabaseRepository, customProvider?: IBillingProvider): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);
  const getProvider = () => customProvider || getBillingProvider();
  const getBillingService = () => new BillingService(repo, getProvider());

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
      return res.status(400).json({ error: err.message || 'Failed to create checkout session' });
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

      // Preserves original raw request bytes captured by scoped raw-body middleware
      const rawBody = (req as any).rawBody || req.body;

      const billingService = getBillingService();
      const result = await billingService.handleWebhook(rawBody, signature);

      return res.status(200).json({
        received: true,
        action: result.action,
        message: result.message,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Webhook processing error:', err.message || err);
      const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 400;
      return res.status(statusCode).json({
        error: err.message || 'Webhook processing failed',
      });
    }
  });

  return router;
}

