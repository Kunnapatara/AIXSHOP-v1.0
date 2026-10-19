import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import { DatabaseRepository } from './repository';
import { PostgresRepository } from './postgresRepository';
import { MemoryRepository } from './memoryRepository';

let defaultRepo: DatabaseRepository | null = null;

/**
 * Builds PostgreSQL pool configuration respecting environment variable precedence:
 * Precedence:
 * 1. DATABASE_URL
 * 2. SQL_* variables: SQL_HOST, SQL_PORT, SQL_USER, SQL_PASSWORD, SQL_DB_NAME
 * 3. PG* variables: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 *
 * Returns null if no PostgreSQL configuration is present.
 * Throws a descriptive configuration error (without leaking secrets) if required discrete fields are missing or invalid.
 */
export function getPostgresPoolConfig(): PoolConfig | null {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  // Discrete variables: precedence SQL_* > PG*
  const host = process.env.SQL_HOST?.trim() || process.env.PGHOST?.trim();
  const portStr = process.env.SQL_PORT?.trim() || process.env.PGPORT?.trim();
  const user = process.env.SQL_USER?.trim() || process.env.PGUSER?.trim();
  const password = process.env.SQL_PASSWORD || process.env.PGPASSWORD;
  const database = process.env.SQL_DB_NAME?.trim() || process.env.PGDATABASE?.trim();

  if (!databaseUrl && !host) {
    return null;
  }

  let sslConfig: boolean | { rejectUnauthorized: boolean; ca?: string } | undefined = undefined;

  // Strict SSL evaluation: Never disable certificate verification indiscriminately
  const sslMode = process.env.PGSSLMODE?.trim();
  const isSslRequested = 
    process.env.DATABASE_SSL === 'true' || 
    sslMode === 'require' || 
    sslMode === 'verify-full' || 
    sslMode === 'verify-ca';

  if (isSslRequested) {
    const isRejectUnauthorizedDisabled = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false';
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && isRejectUnauthorizedDisabled) {
      console.warn(
        '[AIXSHOP Security Warning] SSL certificate verification is explicitly disabled (DATABASE_SSL_REJECT_UNAUTHORIZED=false). This is strongly discouraged in production.'
      );
    }

    let caCert: string | undefined = undefined;
    if (process.env.PGSSLROOTCERT && fs.existsSync(process.env.PGSSLROOTCERT)) {
      caCert = fs.readFileSync(process.env.PGSSLROOTCERT, 'utf-8');
    } else if (process.env.SQL_CA_CERT) {
      caCert = process.env.SQL_CA_CERT;
    }

    sslConfig = {
      rejectUnauthorized: !isRejectUnauthorizedDisabled,
      ...(caCert ? { ca: caCert } : {}),
    };
  }

  // 1. Primary: DATABASE_URL takes highest precedence
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ...(sslConfig !== undefined ? { ssl: sslConfig } : {}),
      max: 10,
      connectionTimeoutMillis: 10000,
    };
  }

  // 2. Discrete parameters validation
  if (!database) {
    throw new Error(
      '[AIXSHOP Configuration Error] Database name is missing. Please set SQL_DB_NAME or PGDATABASE.'
    );
  }

  if (!user) {
    throw new Error(
      '[AIXSHOP Configuration Error] Database user is missing. Please set SQL_USER or PGUSER.'
    );
  }

  let port = 5432;
  if (portStr) {
    const parsedPort = parseInt(portStr, 10);
    if (isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error(
        `[AIXSHOP Configuration Error] Invalid database port "${portStr}". Must be an integer between 1 and 65535.`
      );
    }
    port = parsedPort;
  }

  return {
    host,
    port,
    user,
    password,
    database,
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
      '[AIXSHOP Fatal Startup Error] Production environment (NODE_ENV=production) requires durable PostgreSQL database configuration (DATABASE_URL, SQL_HOST, or PGHOST). In-memory database fallback is strictly prohibited in production to prevent customer data loss.'
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
