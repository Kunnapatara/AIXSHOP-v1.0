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

  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    const isDbConnected = await repo.ping();
    res.json({
      status: 'ok',
      service: 'AIXSHOP Commerce Intel API',
      version: '1.0.0',
      database: {
        backend: repo.getBackendType(),
        connected: isDbConnected,
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
