import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import { DatabaseRepository } from './repository';
import { PostgresRepository } from './postgresRepository';
import { MemoryRepository } from './memoryRepository';

let defaultRepo: DatabaseRepository | null = null;

/**
 * Builds PostgreSQL pool configuration respecting SSL settings without indiscriminately disabling verification.
 * Returns null if neither DATABASE_URL nor SQL_HOST is present.
 */
export function getPostgresPoolConfig(): PoolConfig | null {
  const hasPgHost = Boolean(process.env.SQL_HOST || process.env.DATABASE_URL);
  if (!hasPgHost) return null;

  let sslConfig: boolean | { rejectUnauthorized: boolean; ca?: string } | undefined = undefined;

  // Strict SSL evaluation: Never disable certificate verification indiscriminately
  const sslMode = process.env.PGSSLMODE || (process.env.DATABASE_SSL === 'true' ? 'require' : undefined);
  if (sslMode === 'require' || sslMode === 'verify-full' || sslMode === 'verify-ca' || process.env.DATABASE_SSL === 'true') {
    const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
    let caCert: string | undefined = undefined;

    if (process.env.PGSSLROOTCERT && fs.existsSync(process.env.PGSSLROOTCERT)) {
      caCert = fs.readFileSync(process.env.PGSSLROOTCERT, 'utf-8');
    } else if (process.env.SQL_CA_CERT) {
      caCert = process.env.SQL_CA_CERT;
    }

    sslConfig = {
      rejectUnauthorized,
      ...(caCert ? { ca: caCert } : {}),
    };
  }

  return process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ...(sslConfig !== undefined ? { ssl: sslConfig } : {}),
        max: 10,
        connectionTimeoutMillis: 10000,
      }
    : {
        host: process.env.SQL_HOST,
        port: process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 5432,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        database: process.env.SQL_DB_NAME,
        ...(sslConfig !== undefined ? { ssl: sslConfig } : {}),
        max: 10,
        connectionTimeoutMillis: 10000,
      };
}

/**
 * Retrieves or initializes the active DatabaseRepository.
 * In production (NODE_ENV === 'production'), PostgreSQL configuration is strictly required;
 * attempting to fall back to MemoryRepository in production will throw an explicit fatal error.
 */
export function getDatabaseRepository(): DatabaseRepository {
  if (defaultRepo) return defaultRepo;

  const isProduction = process.env.NODE_ENV === 'production';
  const poolConfig = getPostgresPoolConfig();

  if (poolConfig) {
    console.log('[AIXSHOP Database] Initializing PostgreSQL connection pool...');
    const pool = new Pool(poolConfig);
    defaultRepo = new PostgresRepository(pool);
    return defaultRepo;
  }

  // Production safety rule: Fail startup clearly when PostgreSQL configuration is missing
  if (isProduction) {
    throw new Error(
      '[AIXSHOP Fatal Startup Error] Production environment (NODE_ENV=production) requires durable PostgreSQL database configuration (DATABASE_URL or SQL_HOST). In-memory database fallback is strictly prohibited in production to prevent customer data loss.'
    );
  }

  // MemoryRepository fallback ONLY for local development and automated tests
  console.log('[AIXSHOP Database] PostgreSQL credentials not configured in environment. Using MemoryRepository with multi-tenant relational isolation (development/test mode).');
  defaultRepo = new MemoryRepository(true);
  return defaultRepo;
}

export function setDatabaseRepository(repo: DatabaseRepository | null): void {
  defaultRepo = repo;
}
