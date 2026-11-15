import crypto from 'node:crypto';
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
  verifiedChecksums: string[];
  legacyUnverifiedMigrations: string[];
}

export interface MigrationStatus {
  isUpToDate: boolean;
  totalMigrations: number;
  appliedCount: number;
  pendingCount: number;
  pendingMigrations: string[];
  appliedMigrations: string[];
  checksumMismatches: Array<{ id: string; recordedChecksum: string; actualChecksum: string }>;
  missingMigrationFiles: string[];
  legacyUnverifiedMigrations: string[];
  integrityVerified: boolean;
}

export interface MigrationRunOptions {
  migrationsDir?: string;
  backfillLegacyChecksums?: boolean;
}

// Documented 64-bit constant for PostgreSQL advisory locking:
// Key 1: 0x41495853 = 1095325779 ('AIXS' in ASCII)
// Key 2: 0x4d494752 = 1296656210 ('MIGR' in ASCII)
const MIGRATION_ADVISORY_LOCK_KEY_1 = 1095325779;
const MIGRATION_ADVISORY_LOCK_KEY_2 = 1296656210;

export function computeMigrationChecksum(sqlContent: string): string {
  const normalized = sqlContent.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function getDefaultMigrationsDir(): string {
  return path.resolve(__dirname, 'migrations');
}

/**
 * Runs pending PostgreSQL migrations in alphabetical order.
 * Verifies SHA-256 checksums of all previously applied migrations, detects missing or altered files,
 * records checksums for newly applied migrations, and logs auditable warnings for pre-checksum legacy rows.
 */
export async function runMigrations(
  customPool?: Pool,
  options: MigrationRunOptions = {}
): Promise<MigrationResult> {
  const poolConfig = getPostgresPoolConfig();
  if (!poolConfig && !customPool) {
    throw new Error(
      '[AIXSHOP Migration Error] Cannot run database migrations: PostgreSQL is not configured in the environment. Set DATABASE_URL, SQL_HOST, or PGHOST before running migrations.'
    );
  }

  const pool = customPool || new Pool(poolConfig!);
  const shouldClosePool = !customPool;
  let client: PoolClient | null = null;
  let lockAcquired = false;
  let clientReleased = false;
  let poolClosed = false;

  try {
    client = await pool.connect();

    // Acquire PostgreSQL advisory lock to serialize concurrent migration runs
    console.log('[AIXSHOP Migration] Acquiring migration advisory lock...');
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      MIGRATION_ADVISORY_LOCK_KEY_1,
      MIGRATION_ADVISORY_LOCK_KEY_2,
    ]);
    lockAcquired = true;

    // 1. Ensure migrations tracking table & checksum columns exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum VARCHAR(64),
        checksum_verified_at TIMESTAMPTZ
      );
    `);
    await client.query(`
      ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64);
    `);
    await client.query(`
      ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_verified_at TIMESTAMPTZ;
    `);

    // 2. Fetch already applied migration IDs and stored checksums
    const existingRes = await client.query<{ id: string; checksum: string | null }>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id ASC'
    );
    const appliedMap = new Map(existingRes.rows.map(r => [r.id, r.checksum ?? null]));

    // 3. Read migration files from migrations directory
    const migrationsDir = options.migrationsDir || getDefaultMigrationsDir();
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`[AIXSHOP Migration Error] Migrations directory not found at: ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    const fileSet = new Set(files);

    // 4. Detect applied migrations whose SQL file vanished from disk
    const missingFiles = existingRes.rows
      .map(r => r.id)
      .filter(id => !fileSet.has(id));
    if (missingFiles.length > 0) {
      throw new Error(
        `[AIXSHOP Migration Integrity Error] Previously applied migration file(s) missing on disk: ${missingFiles.join(', ')}. Refusing to proceed with inconsistent migration history.`
      );
    }

    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    const verifiedChecksums: string[] = [];
    const legacyUnverifiedMigrations: string[] = [];

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      const fileChecksum = computeMigrationChecksum(sql);

      if (appliedMap.has(file)) {
        const recordedChecksum = appliedMap.get(file);

        if (recordedChecksum && recordedChecksum !== fileChecksum) {
          throw new Error(
            `[AIXSHOP Migration Integrity Error] Checksum mismatch for applied migration "${file}": database recorded ${recordedChecksum}, disk file is ${fileChecksum}. Modifying already-applied migrations is prohibited; create a new forward migration instead.`
          );
        }

        if (recordedChecksum) {
          verifiedChecksums.push(file);
        } else {
          // Explicit auditable policy for pre-checksum legacy migrations:
          // Never silently overwrite NULL checksums as verified; record & warn unless operator passes explicit opt-in backfill.
          if (options.backfillLegacyChecksums) {
            await client.query(
              'UPDATE schema_migrations SET checksum = $2, checksum_verified_at = clock_timestamp() WHERE id = $1 AND checksum IS NULL',
              [file, fileChecksum]
            );
            verifiedChecksums.push(file);
            console.warn(
              `[AIXSHOP Migration Audit] Explicitly baselined legacy checksum for "${file}" (${fileChecksum}).`
            );
          } else {
            legacyUnverifiedMigrations.push(file);
            console.warn(
              `[AIXSHOP Migration Audit] Legacy applied migration "${file}" has NULL stored checksum (pre-checksum baseline; run with --backfill-legacy-checksums after operator audit to pin checksum).`
            );
          }
        }

        alreadyApplied.push(file);
        continue;
      }

      console.log(`[AIXSHOP Migration] Executing pending migration: ${file}...`);

      // Execute within transaction: schema changes + tracking entry + SHA-256 checksum succeed or rollback together
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum, checksum_verified_at) VALUES ($1, $2, clock_timestamp())',
          [file, fileChecksum]
        );
        await client.query('COMMIT');
        applied.push(file);
        verifiedChecksums.push(file);
        console.log(`[AIXSHOP Migration] ✓ Successfully applied ${file} (sha256: ${fileChecksum.slice(0, 12)}...)`);
      } catch (err: any) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr: any) {
          console.error(
            `[AIXSHOP Migration Rollback Warning] Rollback failed for ${file}:`,
            rollbackErr?.message || rollbackErr
          );
        }
        console.error(`[AIXSHOP Migration Failed] Error executing ${file}:`, err?.message || err);
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
      verifiedChecksums,
      legacyUnverifiedMigrations,
    };
  } finally {
    if (lockAcquired && client) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          MIGRATION_ADVISORY_LOCK_KEY_1,
          MIGRATION_ADVISORY_LOCK_KEY_2,
        ]);
      } catch {
        // Connection loss automatically releases session advisory lock in Postgres
      }
    }

    if (client && !clientReleased) {
      try {
        client.release();
        clientReleased = true;
      } catch {
        // Guard against double release
      }
    }

    if (shouldClosePool && !poolClosed) {
      try {
        await pool.end();
        poolClosed = true;
      } catch {
        // Guard against double end
      }
    }
  }
}

/**
 * Checks migration status and verifies SHA-256 checksums without applying any changes.
 */
export async function checkMigrationStatus(
  customPool?: Pool,
  options: { migrationsDir?: string } = {}
): Promise<MigrationStatus> {
  const poolConfig = getPostgresPoolConfig();
  if (!poolConfig && !customPool) {
    throw new Error(
      '[AIXSHOP Migration Error] Cannot check migration status: PostgreSQL is not configured in the environment. Set DATABASE_URL, SQL_HOST, or PGHOST before checking status.'
    );
  }

  const pool = customPool || new Pool(poolConfig!);
  const shouldClosePool = !customPool;
  let client: PoolClient | null = null;
  let clientReleased = false;
  let poolClosed = false;

  try {
    client = await pool.connect();
    const tableRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
      ) AS "exists";
    `);

    const tableExists = tableRes.rows[0]?.exists ?? false;
    const appliedMap = new Map<string, string | null>();
    let hasChecksumCol = false;

    if (tableExists) {
      const colRes = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'schema_migrations'
          AND column_name = 'checksum'
      `);
      hasChecksumCol = colRes.rows.length > 0;

      const existingRes = await client.query<{ id: string; checksum?: string | null }>(
        hasChecksumCol
          ? 'SELECT id, checksum FROM schema_migrations ORDER BY id ASC'
          : 'SELECT id FROM schema_migrations ORDER BY id ASC'
      );
      for (const r of existingRes.rows) {
        appliedMap.set(r.id, r.checksum ?? null);
      }
    }

    const migrationsDir = options.migrationsDir || getDefaultMigrationsDir();
    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
      : [];
    const fileSet = new Set(files);

    const pendingMigrations = files.filter(f => !appliedMap.has(f));
    const appliedMigrations = files.filter(f => appliedMap.has(f));
    const missingMigrationFiles = Array.from(appliedMap.keys()).filter(id => !fileSet.has(id));
    const checksumMismatches: Array<{ id: string; recordedChecksum: string; actualChecksum: string }> = [];
    const legacyUnverifiedMigrations: string[] = [];

    for (const file of appliedMigrations) {
      const recorded = appliedMap.get(file);
      if (recorded) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        const actual = computeMigrationChecksum(sql);
        if (recorded !== actual) {
          checksumMismatches.push({
            id: file,
            recordedChecksum: recorded,
            actualChecksum: actual,
          });
        }
      } else {
        legacyUnverifiedMigrations.push(file);
      }
    }

    const integrityVerified = checksumMismatches.length === 0 && missingMigrationFiles.length === 0;

    return {
      isUpToDate: tableExists && pendingMigrations.length === 0 && integrityVerified,
      totalMigrations: files.length,
      appliedCount: appliedMigrations.length,
      pendingCount: pendingMigrations.length,
      pendingMigrations,
      appliedMigrations,
      checksumMismatches,
      missingMigrationFiles,
      legacyUnverifiedMigrations,
      integrityVerified,
    };
  } finally {
    if (client && !clientReleased) {
      try {
        client.release();
        clientReleased = true;
      } catch {
        // Guard against double release
      }
    }

    if (shouldClosePool && !poolClosed) {
      try {
        await pool.end();
        poolClosed = true;
      } catch {
        // Guard against double end
      }
    }
  }
}

// CLI entry point
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isDirectRun) {
  const isStatusCheck = process.argv.includes('--status') || process.argv.includes('-s');
  const backfillLegacyChecksums = process.argv.includes('--backfill-legacy-checksums');

  if (isStatusCheck) {
    checkMigrationStatus()
      .then((status) => {
        console.log(
          `[AIXSHOP Migration Status] Total: ${status.totalMigrations}, Applied: ${status.appliedCount}, Pending: ${status.pendingCount}, IntegrityVerified: ${status.integrityVerified}`
        );
        if (status.checksumMismatches.length > 0) {
          console.error(
            `[AIXSHOP Migration Integrity Error] Checksum mismatch(es): ${status.checksumMismatches.map(m => m.id).join(', ')}`
          );
        }
        if (status.missingMigrationFiles.length > 0) {
          console.error(
            `[AIXSHOP Migration Integrity Error] Missing files for applied migrations: ${status.missingMigrationFiles.join(', ')}`
          );
        }
        if (status.legacyUnverifiedMigrations.length > 0) {
          console.warn(
            `[AIXSHOP Migration Audit] Legacy NULL-checksum migrations: ${status.legacyUnverifiedMigrations.join(', ')}`
          );
        }
        if (status.pendingMigrations.length > 0) {
          console.log(`[AIXSHOP Migration Status] Pending migrations: ${status.pendingMigrations.join(', ')}`);
        } else if (status.isUpToDate) {
          console.log('[AIXSHOP Migration Status] Schema and checksums are up to date.');
        }
        process.exit(status.isUpToDate ? 0 : 2);
      })
      .catch((err) => {
        console.error('[AIXSHOP Migration Status Error]:', err.message || err);
        process.exit(1);
      });
  } else {
    runMigrations(undefined, { backfillLegacyChecksums })
      .then((result) => {
        console.log(
          `[AIXSHOP Migration] Completed successfully. Total migrations tracked: ${result.totalMigrations}`
        );
        process.exit(0);
      })
      .catch((err) => {
        console.error('[AIXSHOP Migration Fatal Error]:', err.message || err);
        process.exit(1);
      });
  }
}
