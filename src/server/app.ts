import fs from 'node:fs';
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
import {
  createRequestCorrelationMiddleware,
  defaultOpsAlertService,
  getMonitoringDiagnostics,
  redactMonitoringText,
  structuredLog,
} from './services/monitoringService';

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

  app.use(createRequestCorrelationMiddleware());

  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(blockInternalPromptArtifactsMiddleware);

  // SEO & Brand Assets (served directly in both API/test apps and full server mode)
  const resolveConfiguredPublicBaseUrl = (): string | null => {
    const raw = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (!raw || raw === 'MY_APP_URL') return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return raw;
      }
    } catch {
      return null;
    }
    return null;
  };

  app.get('/robots.txt', (_req, res) => {
    const baseUrl = resolveConfiguredPublicBaseUrl();
    const sitemapLine = baseUrl ? `Sitemap: ${baseUrl}/sitemap.xml\n` : '';
    res
      .status(200)
      .type('text/plain; charset=utf-8')
      .send(
        `User-agent: *\nAllow: /\nAllow: /privacy\nAllow: /terms\nDisallow: /api/\nDisallow: /assets/aistudio/\n${sitemapLine}`
      );
  });

  app.get('/sitemap.xml', (_req, res) => {
    const baseUrl = resolveConfiguredPublicBaseUrl();
    const prefix = baseUrl || '';
    const urls = [
      { loc: `${prefix}/`, changefreq: 'weekly', priority: '1.0' },
      { loc: `${prefix}/privacy`, changefreq: 'monthly', priority: '0.4' },
      { loc: `${prefix}/terms`, changefreq: 'monthly', priority: '0.4' },
    ];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      )
      .join('\n')}\n</urlset>\n`;
    res.status(200).type('application/xml; charset=utf-8').send(body);
  });

  app.get('/favicon.svg', (_req, res) => {
    const faviconPath = path.resolve(process.cwd(), 'public', 'favicon.svg');
    if (fs.existsSync(faviconPath)) {
      return res.status(200).type('image/svg+xml; charset=utf-8').sendFile(faviconPath);
    }
    return res
      .status(200)
      .type('image/svg+xml; charset=utf-8')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#EA580C"/></svg>'
      );
  });

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
      requestId: (req as any).requestId,
      monitoring: getMonitoringDiagnostics(),
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

    if (!isReady) {
      void defaultOpsAlertService.sendAlert({
        severity: 'critical',
        alertKey: 'health_readiness_degraded',
        title: 'AIXSHOP Readiness Probe Degraded (HTTP 503)',
        summary: readiness.reason || 'Database or production config readiness check failed',
        requestId: (req as any).requestId,
        details: {
          connected: readiness.connected,
          schemaReady: readiness.schemaReady,
          configReady,
        },
      });
    }

    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ok' : 'unavailable',
      probe: 'readiness',
      service: 'AIXSHOP Commerce Intel API',
      version: '1.0.0',
      requestId: (req as any).requestId,
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
      monitoring: getMonitoringDiagnostics(),
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
        requestId: (req as any).requestId,
        monitoring: getMonitoringDiagnostics(),
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
      requestId: (req as any).requestId,
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
      monitoring: getMonitoringDiagnostics(),
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

  // Explicit API 404 catch-all (prevents unknown /api/* paths from falling through to SPA index.html)
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'API endpoint not found',
      code: 'API_ROUTE_NOT_FOUND',
      path: String(req.originalUrl || req.path || '/api').split('?')[0],
      requestId: (req as any).requestId,
    });
  });

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    const safeErrorMsg = redactMonitoringText(err?.message || err);
    const statusCode =
      typeof err.statusCode === 'number'
        ? err.statusCode
        : typeof err.status === 'number'
        ? err.status
        : 500;
    const requestId = req?.requestId;
    const reqPath = String(req?.originalUrl || req?.path || '/').split('?')[0];

    if (process.env.NODE_ENV !== 'test') {
      structuredLog('error', 'api_unhandled_error', {
        requestId,
        method: req?.method,
        path: reqPath,
        statusCode,
        error: safeErrorMsg,
      });
    } else {
      console.error('[AIXSHOP API Error]:', safeErrorMsg);
    }

    if (statusCode >= 500) {
      void defaultOpsAlertService.sendAlert({
        severity: 'error',
        alertKey: `api_5xx:${req?.method || 'UNKNOWN'}:${reqPath}`,
        title: `Unhandled API ${statusCode} on ${req?.method || 'UNKNOWN'} ${reqPath}`,
        summary: safeErrorMsg,
        requestId,
        workspaceId: req?.workspace?.id,
        details: { statusCode, path: reqPath, method: req?.method },
      });
    }

    if (res.headersSent) {
      return next(err);
    }
    if (err?.type === 'entity.too.large' || err?.statusCode === 413 || err?.status === 413) {
      return res.status(413).json({
        error: 'Request payload exceeds the maximum allowed size limit for this endpoint.',
        code: 'PAYLOAD_TOO_LARGE',
        requestId,
      });
    }
    res.status(statusCode).json({
      error: err.expose ? err.message : 'An unexpected server error occurred',
      code: err.code || 'INTERNAL_SERVER_ERROR',
      requestId,
    });
  });

  return app;
}
