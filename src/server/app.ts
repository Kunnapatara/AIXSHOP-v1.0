import path from 'path';
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { DatabaseRepository } from './db/repository';
import { getDatabaseRepository } from './db/index';
import { createAuthRoutes } from './routes/authRoutes';
import { createCatalogRoutes } from './routes/catalogRoutes';
import { createStoreRoutes } from './routes/storeRoutes';
import { createBillingRoutes } from './routes/billingRoutes';
import { createAuditRoutes } from './routes/auditRoutes';
import { createShopifyRoutes } from './routes/shopifyRoutes';
import { createDiscoveryRoutes } from './routes/discoveryRoutes';
import { createBusinessProfileRoutes } from './routes/businessProfileRoutes';
import { createFeedRoutes } from './routes/feedRoutes';
import { createVisibilityRoutes } from './routes/visibilityRoutes';
import { csrfProtection, getAuthRateLimiterDiagnostics } from './middleware/auth';
import { parseTrustProxySetting, validateProductionConfig } from './config/productionConfig';
import { ExternalRegistryProviderAdapter } from './services/externalRegistryService';

/**
 * Blocks public HTTP access to unreferenced internal AI Studio prompt/attachment artifacts
 * under /assets/aistudio/* before dev Vite middleware or production static/SPA handlers run.
 * Does not mutate or delete any files on disk.
 */
export function blockInternalPromptArtifactsMiddleware(req: any, res: any, next: any) {
  const rawPath = String(req.path || req.originalUrl?.split('?')[0] || '');
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  const normalized = path.posix.normalize(decodedPath.replace(/\\/g, '/'));
  if (
    /^\/+assets\/aistudio(\/|$)/i.test(normalized) ||
    /\/Paste_November_/i.test(normalized) ||
    /\/Allbirds_Shopify_products_/i.test(normalized)
  ) {
    return res.status(404).json({
      error: 'Not found',
      code: 'RESOURCE_NOT_FOUND',
    });
  }
  return next();
}

export interface CreateAppOptions {
  externalRegistryProvider?: ExternalRegistryProviderAdapter;
}

export function createApp(
  customRepo?: DatabaseRepository,
  options: CreateAppOptions = {}
): Express {
  const app = express();
  const repo = customRepo || getDatabaseRepository();

  const proxyConfig = parseTrustProxySetting();
  app.set('trust proxy', proxyConfig.value);

  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(blockInternalPromptArtifactsMiddleware);

  // Narrowly scoped raw-body capture for billing and Shopify webhook routes
  // Scoped JSON body size limits: 256kb default, 5mb for /api/catalog, 2mb for /api/visibility/upload
  app.use((req, res, next) => {
    const reqPath = req.path || req.originalUrl?.split('?')[0] || '';
    const isWebhook =
      reqPath === '/api/billing/webhook' ||
      reqPath === '/api/shopify/webhooks';

    if (isWebhook) {
      return express.raw({ type: '*/*', limit: '5mb' })(req, res, (err) => {
        if (err) return next(err);
        (req as any).rawBody = req.body;
        next();
      });
    }

    const jsonLimit =
      reqPath.startsWith('/api/catalog')
        ? '5mb'
        : reqPath.startsWith('/api/visibility/upload')
        ? '2mb'
        : '256kb';

    return express.json({ limit: jsonLimit })(req, res, next);
  });
  app.use(cookieParser());
  app.use(csrfProtection);

  const DB_TIMEOUT_MS = 3000;

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  }

  async function checkReadiness(r: DatabaseRepository): Promise<{
    connected: boolean;
    schemaReady: boolean;
    reason?: string;
  }> {
    try {
      // Live connectivity check with timeout and timer cleanup
      const isConnected = await withTimeout(
        r.ping(),
        DB_TIMEOUT_MS,
        'Database connectivity check timed out'
      );

      if (!isConnected) {
        return { connected: false, schemaReady: false, reason: 'Database connection unreachable' };
      }

      // Live schema readiness check with timeout and timer cleanup
      const schemaResult = await withTimeout(
        r.checkSchemaReadiness(),
        DB_TIMEOUT_MS,
        'Schema readiness check timed out'
      );

      if (!schemaResult.isReady) {
        return {
          connected: true,
          schemaReady: false,
          reason: schemaResult.error || 'Database schema incomplete or migrations pending',
        };
      }

      return { connected: true, schemaReady: true };
    } catch (err: any) {
      return {
        connected: false,
        schemaReady: false,
        reason: err.message || 'Database check failed',
      };
    }
  }

  // 1. Dedicated Liveness probe (Kubernetes / Cloud Run liveness probe)
  app.get('/api/health/live', (req, res) => {
    res.status(200).json({
      status: 'ok',
      probe: 'liveness',
      service: 'AIXSHOP Commerce Intel API',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 2. Dedicated Readiness probe (Kubernetes / Cloud Run readiness probe)
  app.get('/api/health/ready', async (req, res) => {
    const readiness = await checkReadiness(repo);
    const configValidation = validateProductionConfig();
    const isProd = process.env.NODE_ENV === 'production';
    const configReady = isProd ? configValidation.valid : true;
    const isReady = readiness.connected && readiness.schemaReady && configReady;

    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ok' : 'unavailable',
      probe: 'readiness',
      service: 'AIXSHOP Commerce Intel API',
      version: '1.0.0',
      database: {
        backend: repo.getBackendType(),
        connected: readiness.connected,
        schemaReady: readiness.schemaReady,
        ...(readiness.reason ? { reason: readiness.reason } : {}),
      },
      config: {
        valid: configValidation.valid,
        environment: configValidation.environment,
        ...(configValidation.missingOrInvalid.length > 0 ? { missingOrInvalid: configValidation.missingOrInvalid } : {}),
      },
      authRateLimiter: getAuthRateLimiterDiagnostics(),
      timestamp: new Date().toISOString(),
    });
  });

  // 3. Main Health check endpoint
  app.get('/api/health', async (req, res) => {
    if (req.query.probe === 'live' || req.query.probe === 'liveness') {
      return res.status(200).json({
        status: 'ok',
        probe: 'liveness',
        service: 'AIXSHOP Commerce Intel API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    }

    const readiness = await checkReadiness(repo);
    const configValidation = validateProductionConfig();
    const isProd = process.env.NODE_ENV === 'production';
    const configReady = isProd ? configValidation.valid : true;
    const isReady = readiness.connected && readiness.schemaReady && configReady;

    return res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ok' : 'unavailable',
      service: 'AIXSHOP Commerce Intel API',
      version: '1.0.0',
      database: {
        backend: repo.getBackendType(),
        connected: readiness.connected,
        schemaReady: readiness.schemaReady,
        ...(readiness.reason ? { reason: readiness.reason } : {}),
      },
      config: {
        valid: configValidation.valid,
        environment: configValidation.environment,
        ...(configValidation.missingOrInvalid.length > 0 ? { missingOrInvalid: configValidation.missingOrInvalid } : {}),
      },
      authRateLimiter: getAuthRateLimiterDiagnostics(),
      timestamp: new Date().toISOString(),
    });
  });

  // Mount API routers
  app.use('/api/auth', createAuthRoutes(repo));
  app.use(
    '/api/catalog',
    createCatalogRoutes(repo, {
      externalRegistryProvider: options.externalRegistryProvider,
    })
  );
  app.use('/api/store', createStoreRoutes(repo));
  app.use('/api/billing', createBillingRoutes(repo));
  app.use('/api/audit', createAuditRoutes(repo));
  app.use('/api/shopify', createShopifyRoutes(repo));
  app.use('/api/discovery', createDiscoveryRoutes(repo));
  app.use('/api/business-profile', createBusinessProfileRoutes(repo));
  app.use('/api/feed', createFeedRoutes(repo));
  app.use('/api/visibility', createVisibilityRoutes(repo));

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error('[AIXSHOP API Error]:', err?.message || err);
    if (res.headersSent) {
      return next(err);
    }
    if (err?.type === 'entity.too.large' || err?.statusCode === 413 || err?.status === 413) {
      return res.status(413).json({
        error: 'Request payload exceeds the maximum allowed size limit for this endpoint.',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : (typeof err.status === 'number' ? err.status : 500);
    res.status(statusCode).json({
      error: err.expose ? err.message : 'An unexpected server error occurred',
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
  });

  return app;
}
