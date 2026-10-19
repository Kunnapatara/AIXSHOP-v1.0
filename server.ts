import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { getDatabaseRepository } from './src/server/db/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function start() {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Acquire database repository — in production this strictly requires PostgreSQL configuration
  const repo = getDatabaseRepository();

  if (isProd) {
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
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('[AIXSHOP] Serving production build from dist directory...');
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AIXSHOP] Server listening on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[AIXSHOP] Received ${signal}. Initiating graceful shutdown...`);

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
