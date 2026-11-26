import { Router, Request, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getBillingProvider } from '../billing/providerAdapter';
import { BillingLeaseConfig, BillingService, sanitizeBillingErrorMessage } from '../services/billingService';
import { AUTHORITATIVE_PLANS, IBillingProvider } from '../billing/types';
import { getCommercialPlanSummary, resolveReportEntitlement } from '../services/entitlementService';
import { getTrustedBaseUrl, resolveTrustedRedirectUrl } from '../config/productionConfig';

export function createBillingRoutes(
  repo: DatabaseRepository,
  customProvider?: IBillingProvider,
  billingLeaseConfig?: BillingLeaseConfig
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const requireAuth = createAuthMiddleware(repo);
  const getProvider = () => customProvider || getBillingProvider();
  const getBillingService = () => new BillingService(repo, getProvider(), billingLeaseConfig);

  // GET /api/billing/plans — Returns authoritative server-defined plans and capacities
  router.get('/plans', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      plans: Object.values(AUTHORITATIVE_PLANS),
      commercialSummary: getCommercialPlanSummary(),
      currency: 'USD',
    });
  });

  // GET /api/billing/subscription — Returns active workspace subscription, capacity status, and report entitlement
  router.get('/subscription', requireAuth, async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const workspaceId = req.workspace!.id;
      const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);
      const reportEntitlement = resolveReportEntitlement(store, subscription);
      const safeStoreProfile = store && !reportEntitlement.hasFullReportAccess
        ? {
            ...store,
            catalogCompletenessAvg: 0,
            evidenceCoverageAvg: undefined,
            lastAuditDate: undefined,
          }
        : store;

      const isFreeTier = !subscription || subscription.tier === 'Free Audit';
      const normalizedSubscription = isFreeTier
        ? {
            tier: 'Free Audit',
            status: 'active',
            provider: 'none',
            billingInterval: 'none' as const,
            isRecurring: false,
            cancelAtPeriodEnd: false,
          }
        : {
            ...subscription,
            billingInterval: 'month' as const,
            isRecurring: true,
          };

      return res.json({
        workspaceId,
        subscription: normalizedSubscription,
        storeProfile: safeStoreProfile,
        reportEntitlement,
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
        '/?page=settings&tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}'
      );
      const effectiveCancelUrl = resolveTrustedRedirectUrl(
        trustedBaseUrl,
        cancelUrl,
        '/?page=settings&tab=subscription&checkout=canceled'
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
      console.error('[AIXSHOP Billing] Error creating checkout session:', sanitizeBillingErrorMessage(err));
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({ error: err.message || 'Failed to create checkout session', code: err?.code });
    }
  });

  // POST /api/billing/checkout-session/verify — Authoritatively verifies completed checkout session with billing provider
  router.post('/checkout-session/verify', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';

      if (!sessionId) {
        return res.status(400).json({
          error: 'Checkout sessionId is required for verification',
          code: 'INVALID_SESSION_ID',
        });
      }

      const billingService = getBillingService();
      const verification = await billingService.verifyCheckoutSession(workspaceId, sessionId);
      const reportEntitlement = resolveReportEntitlement(verification.storeProfile, verification.subscription);

      return res.json({
        success: true,
        verified: verification.verified,
        workspaceId,
        subscription: verification.subscription,
        storeProfile: verification.storeProfile,
        reportEntitlement,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error verifying checkout session:', sanitizeBillingErrorMessage(err));
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      return res.status(status).json({
        verified: false,
        error: err.message || 'Failed to verify checkout session',
        code: err?.code || 'CHECKOUT_VERIFICATION_FAILED',
      });
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
        '/?page=settings&tab=subscription'
      );

      const billingService = getBillingService();
      const portal = await billingService.createPortalSession(workspaceId, effectiveReturnUrl);

      return res.json({
        success: true,
        portalUrl: portal.portalUrl,
        provider: portal.provider,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error creating portal session:', sanitizeBillingErrorMessage(err));
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

      if (result.permanentlyFailed) {
        return res.status(200).json({
          received: true,
          deadLettered: true,
          retryable: false,
          action: result.action,
          message: result.message,
        });
      }

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
      console.error('[AIXSHOP Billing] Webhook processing error:', sanitizeBillingErrorMessage(err));
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

  // GET /api/billing/email-deliveries — Returns workspace-scoped billing lifecycle email delivery logs (redacted)
  router.get('/email-deliveries', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
      const deliveries = await repo.listBillingEmailDeliveries(workspaceId, limit);
      return res.json({
        success: true,
        workspaceId,
        deliveries,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Billing] Error loading billing email deliveries:', sanitizeBillingErrorMessage(err));
      return res.status(500).json({ error: 'Failed to retrieve billing email deliveries' });
    }
  });

  return router;
}

