import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool, PoolClient } from 'pg';
import { getPostgresPoolConfig } from './index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  totalMigrations: number;
}

/**
 * Runs pending PostgreSQL migrations in alphabetical order.
 * Creates schema_migrations table if not exists and tracks applied files.
 * Non-destructive and safe to run multiple times (idempotent).
 */
export async function runMigrations(customPool?: Pool): Promise<MigrationResult> {
  const poolConfig = getPostgresPoolConfig();
  if (!poolConfig && !customPool) {
    throw new Error(
      '[AIXSHOP Migration Error] Cannot run database migrations: PostgreSQL is not configured in the environment. Set DATABASE_URL or SQL_HOST before running migrations.'
    );
  }

  const pool = customPool || new Pool(poolConfig!);
  const shouldClosePool = !customPool;

  const client: PoolClient = await pool.connect();
  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Fetch already applied migration IDs
    const existingRes = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id ASC');
    const appliedSet = new Set(existingRes.rows.map(r => r.id));

    // 3. Read migration files from migrations directory
    const migrationsDir = path.resolve(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`[AIXSHOP Migration Error] Migrations directory not found at: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of files) {
      if (appliedSet.has(file)) {
        alreadyApplied.push(file);
        continue;
      }

      console.log(`[AIXSHOP Migration] Executing pending migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      // Execute within transaction
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[AIXSHOP Migration] ✓ Successfully applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[AIXSHOP Migration Failed] Error executing ${file}:`, err);
        throw err;
      }
    }

    console.log(
      `[AIXSHOP Migration Complete] ${applied.length} migration(s) applied, ${alreadyApplied.length} already up to date.`
    );

    return {
      applied,
      alreadyApplied,
      totalMigrations: files.length,
    };
  } finally {
    client.release();
    if (shouldClosePool) {
      await pool.end();
    }
  }
}

// CLI entry point
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('migrate.ts') || 
  process.argv[1].endsWith('migrate.js')
);

if (isDirectRun) {
  runMigrations()
    .then((result) => {
      console.log(`[AIXSHOP Migration] Completed successfully. Total migrations tracked: ${result.totalMigrations}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[AIXSHOP Migration Fatal Error]:', err.message || err);
      process.exit(1);
    });
}
