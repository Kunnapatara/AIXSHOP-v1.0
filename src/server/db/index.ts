import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseRepository } from './repository';
import { PostgresRepository } from './postgresRepository';
import { MemoryRepository } from './memoryRepository';

let defaultRepo: DatabaseRepository | null = null;

export function getDatabaseRepository(): DatabaseRepository {
  if (defaultRepo) return defaultRepo;

  const hasPgHost = Boolean(process.env.SQL_HOST || process.env.DATABASE_URL);
  
  if (hasPgHost) {
    const poolConfig = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.SQL_HOST,
          port: process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 5432,
          user: process.env.SQL_USER,
          password: process.env.SQL_PASSWORD,
          database: process.env.SQL_DB_NAME,
          max: 10,
          connectionTimeoutMillis: 10000,
        };

    console.log('[AIXSHOP Database] Initializing PostgreSQL connection pool...');
    const pool = new Pool(poolConfig);
    defaultRepo = new PostgresRepository(pool);
    return defaultRepo;
  }

  // MemoryRepository fallback when external PostgreSQL is not configured
  console.log('[AIXSHOP Database] PostgreSQL credentials not configured in environment. Using MemoryRepository with multi-tenant relational isolation.');
  defaultRepo = new MemoryRepository(true);
  return defaultRepo;
}

export function setDatabaseRepository(repo: DatabaseRepository): void {
  defaultRepo = repo;
}
