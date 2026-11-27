import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { getDatabaseRepository } from './src/server/db/index';
import { validateProductionConfig } from './src/server/config/productionConfig';
import { getBillingProvider } from './src/server/billing/providerAdapter';
import {
  BillingEmailRetrySchedulerHandle,
  BillingService,
  DEFAULT_BILLING_RECOVERY_POLICY,
  resolveBillingEmailRetryPolicy,
  sanitizeBillingErrorMessage,
  startBillingEmailRetryScheduler,
} from './src/server/services/billingService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KNOWN_SPA_PATHS = new Set([
  '/',
  '/settings',
  '/privacy',
  '/privacy-policy',
  '/terms',
  '/terms-of-service',
  '/landing',
]);

export function normalizeSpaPath(rawPath: string): string {
  const pathOnly = String(rawPath || '/').split('?')[0].trim();
  if (pathOnly.length > 1) {
    return pathOnly.replace(/\/+$/, '').toLowerCase();
  }
  return pathOnly.toLowerCase() || '/';
}

export function isKnownSpaFrontendPath(rawPath: string): boolean {
  return KNOWN_SPA_PATHS.has(normalizeSpaPath(rawPath));
}

async function start() {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Acquire database repository — in production this strictly requires PostgreSQL configuration
  const repo = getDatabaseRepository();

  if (isProd) {
    console.log('[AIXSHOP Startup] Validating production environment configuration...');
    const configCheck = validateProductionConfig();
    if (!configCheck.valid) {
      throw new Error(
        `[AIXSHOP Fatal Startup Error] Invalid or incomplete production configuration: ${configCheck.missingOrInvalid.join(', ')}`
      );
    }

    console.log('[AIXSHOP Startup] Verifying PostgreSQL connection for production...');
    const isConnected = await repo.ping();
    if (!isConnected) {
      throw new Error(
        '[AIXSHOP Fatal Startup Error] Could not establish connection to PostgreSQL in production. Please check DATABASE_URL, network connectivity, and credentials.'
      );
    }
    console.log('[AIXSHOP Startup] PostgreSQL database connection verified successfully.');

    console.log('[AIXSHOP Startup] Verifying PostgreSQL database schema readiness...');
    const schemaStatus = await repo.checkSchemaReadiness();
    if (!schemaStatus.isReady) {
      throw new Error(
        `[AIXSHOP Fatal Startup Error] PostgreSQL database schema is not ready: ${schemaStatus.error}`
      );
    }
    console.log('[AIXSHOP Startup] PostgreSQL schema and migrations verified successfully.');
  }

  const app = createApp(repo);

  if (!isProd) {
    console.log('[AIXSHOP] Starting development server with Vite middleware...');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
        hmr: !disableHmr,
        ...(disableHmr ? { ws: false } : {}),
        watch: disableHmr ? null : {},
      },
      appType: 'spa',
    });

    if (disableHmr) {
      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript; charset=utf-8').send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
    decline() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== '.' && url[0] !== '/') return url;
  const pathname = url.replace(/[?#].*$/, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
export class ErrorOverlay extends HTMLElement {}
`);
      });
    }

    // Return genuine HTTP 404 status for unknown frontend HTML routes while rendering the SPA Custom 404 page
    app.get('*', async (req, res, next) => {
      const normalized = normalizeSpaPath(req.path);
      const isViteOrAssetPath =
        normalized.startsWith('/api') ||
        normalized.startsWith('/src/') ||
        normalized.startsWith('/@') ||
        normalized.startsWith('/node_modules/') ||
        normalized.startsWith('/assets/') ||
        normalized === '/robots.txt' ||
        normalized === '/sitemap.xml' ||
        normalized === '/favicon.svg' ||
        /\.[a-z0-9]{1,8}$/i.test(normalized);

      if (isViteOrAssetPath || isKnownSpaFrontendPath(normalized) || !req.accepts('html')) {
        return next();
      }

      try {
        const indexTemplatePath = path.resolve(__dirname, 'index.html');
        const rawTemplate = fs.readFileSync(indexTemplatePath, 'utf-8');
        const transformedHtml = await vite.transformIndexHtml(req.originalUrl, rawTemplate);
        return res.status(404).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(transformedHtml);
      } catch (err) {
        return next(err);
      }
    });

    app.use(vite.middlewares);
  } else {
    console.log('[AIXSHOP] Serving production build from dist directory...');
    const distPath = path.resolve(__dirname, 'dist');
    const distIndexHtml = path.resolve(distPath, 'index.html');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const normalized = normalizeSpaPath(req.path);
      if (normalized.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(normalized)) {
        return res.status(404).json({ error: 'Resource not found', code: 'RESOURCE_NOT_FOUND' });
      }
      if (isKnownSpaFrontendPath(normalized)) {
        return res.status(200).sendFile(distIndexHtml);
      }
      return res.status(404).sendFile(distIndexHtml);
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AIXSHOP] Server listening on http://0.0.0.0:${PORT}`);
  });

  // Optional, explicitly env-guarded billing webhook recovery scheduler
  let billingRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryInFlight = false;
  if (process.env.BILLING_RECOVERY_ENABLED === 'true' && process.env.NODE_ENV !== 'test') {
    const rawInterval = Number.parseInt(process.env.BILLING_RECOVERY_INTERVAL_MS || '60000', 10);
    const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 5000 ? rawInterval : 60000;
    const rawMaxAttempts = Number.parseInt(
      process.env.BILLING_RECOVERY_MAX_ATTEMPTS || String(DEFAULT_BILLING_RECOVERY_POLICY.maxAttempts),
      10
    );
    const maxAttempts =
      Number.isFinite(rawMaxAttempts) && rawMaxAttempts > 0
        ? rawMaxAttempts
        : DEFAULT_BILLING_RECOVERY_POLICY.maxAttempts;

    const runRecoverySweep = async () => {
      if (recoveryInFlight || isShuttingDown) return;
      recoveryInFlight = true;
      try {
        const provider = getBillingProvider();
        const billingService = new BillingService(repo, provider, undefined, { maxAttempts });
        const summary = await billingService.recoverPendingWebhookEvents({
          limit: 25,
          maxAttempts,
          leaseOwnerPrefix: 'scheduler_recovery',
        });
        if (summary.scanned > 0) {
          console.log('[AIXSHOP Billing Recovery]', {
            scanned: summary.scanned,
            recovered: summary.recovered,
            ignored: summary.ignored,
            retriedFailed: summary.retriedFailed,
            permanentlyFailed: summary.permanentlyFailed,
            skippedContended: summary.skippedContended,
            leaseLost: summary.leaseLost,
          });
        }
      } catch (recoveryErr) {
        console.error('[AIXSHOP Billing Recovery] Sweep error:', sanitizeBillingErrorMessage(recoveryErr));
      } finally {
        recoveryInFlight = false;
      }
    };

    billingRecoveryTimer = setInterval(() => {
      void runRecoverySweep();
    }, intervalMs);
    if (typeof billingRecoveryTimer.unref === 'function') {
      billingRecoveryTimer.unref();
    }
    console.log(`[AIXSHOP] Billing webhook recovery scheduler enabled (interval=${intervalMs}ms, maxAttempts=${maxAttempts}).`);
  }

  // Optional, explicitly env-guarded automatic billing email retry scheduler
  let billingEmailRetryHandle: BillingEmailRetrySchedulerHandle | null = null;
  const emailRetryEnabled =
    process.env.BILLING_EMAIL_RETRY_ENABLED === 'true' ||
    (process.env.BILLING_RECOVERY_ENABLED === 'true' &&
      process.env.BILLING_EMAIL_RETRY_ENABLED !== 'false');
  if (emailRetryEnabled && process.env.NODE_ENV !== 'test') {
    const emailPolicy = resolveBillingEmailRetryPolicy();
    const rawEmailInterval = Number.parseInt(
      process.env.BILLING_EMAIL_RETRY_INTERVAL_MS || '60000',
      10
    );
    const emailIntervalMs =
      Number.isFinite(rawEmailInterval) && rawEmailInterval >= 5000 ? rawEmailInterval : 60000;
    billingEmailRetryHandle = startBillingEmailRetryScheduler(repo, {
      intervalMs: emailIntervalMs,
      limit: 25,
      ...emailPolicy,
    });
    console.log(
      `[AIXSHOP] Billing email retry scheduler enabled (interval=${emailIntervalMs}ms, maxAttempts=${emailPolicy.maxAttempts}).`
    );
  }

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[AIXSHOP] Received ${signal}. Initiating graceful shutdown...`);

    if (billingRecoveryTimer) {
      clearInterval(billingRecoveryTimer);
      billingRecoveryTimer = null;
    }

    if (billingEmailRetryHandle) {
      billingEmailRetryHandle.stop();
      billingEmailRetryHandle = null;
    }

    server.close(async (err) => {
      if (err) {
        console.error('[AIXSHOP] Error closing HTTP server:', err);
      } else {
        console.log('[AIXSHOP] HTTP server closed.');
      }

      if (repo.close) {
        try {
          await repo.close();
          console.log('[AIXSHOP] Database pool connection closed.');
        } catch (dbErr) {
          console.error('[AIXSHOP] Error closing database pool:', dbErr);
        }
      }

      process.exit(err ? 1 : 0);
    });

    // Force exit if shutdown hangs beyond 10 seconds
    setTimeout(() => {
      console.error('[AIXSHOP] Graceful shutdown timeout exceeded (10s). Forcing process exit.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[AIXSHOP Fatal Startup Error]:', err?.message || err);
  process.exit(1);
});
