import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { DatabaseRepository } from './db/repository';
import { getDatabaseRepository } from './db/index';
import { createAuthRoutes } from './routes/authRoutes';
import { createCatalogRoutes } from './routes/catalogRoutes';
import { createStoreRoutes } from './routes/storeRoutes';
import { csrfProtection } from './middleware/auth';

export function createApp(customRepo?: DatabaseRepository): Express {
  const app = express();
  const repo = customRepo || getDatabaseRepository();

  // Basic middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use(csrfProtection);

  const DB_TIMEOUT_MS = 3000;

  async function checkReadiness(r: DatabaseRepository): Promise<{
    connected: boolean;
    schemaReady: boolean;
    reason?: string;
  }> {
    try {
      // Live connectivity check with timeout
      const isConnected = await Promise.race([
        r.ping(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Database connectivity check timed out')), DB_TIMEOUT_MS)
        ),
      ]);

      if (!isConnected) {
        return { connected: false, schemaReady: false, reason: 'Database connection unreachable' };
      }

      // Live schema readiness check with timeout
      const schemaResult = await Promise.race([
        r.checkSchemaReadiness(),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error('Schema readiness check timed out')), DB_TIMEOUT_MS)
        ),
      ]);

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
    const isReady = readiness.connected && readiness.schemaReady;

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
    const isReady = readiness.connected && readiness.schemaReady;

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
      timestamp: new Date().toISOString(),
    });
  });

  // Mount API routers
  app.use('/api/auth', createAuthRoutes(repo));
  app.use('/api/catalog', createCatalogRoutes(repo));
  app.use('/api/store', createStoreRoutes(repo));

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error('[AIXSHOP API Error]:', err?.message || err);
    if (res.headersSent) {
      return next(err);
    }
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    res.status(statusCode).json({
      error: err.expose ? err.message : 'An unexpected server error occurred',
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
  });

  return app;
}
