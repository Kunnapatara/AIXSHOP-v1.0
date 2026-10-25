import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresRepository } from './db/postgresRepository';
import { 
  resolveWorkspacePlanEntitlement,
  countCatalogSkus,
  getActiveWorkspaceLockCount,
  withWorkspaceLock
} from './services/entitlementService';
import { StoreProfile, Product } from '../types';

describe('AIXSHOP v1.0 — PostgreSQL Entitlement Persistence & Plan Integrity Suite', () => {

  // 1. PostgreSQL Schema & SQL Query Exactness Tests for PostgresRepository
  describe('PostgresRepository SQL Query & Entitlement Mapping', () => {

    test('1. getStoreByWorkspace selects sku_limit and maps it without hardcoded 2500 default', async () => {
      let executedSql = '';
      let executedParams: any[] = [];

      const mockClient = {
        query: async (sql: string, params: any[]) => {
          executedSql = sql;
          executedParams = params;
          return {
            rows: [
              {
                id: 'store_ws_starter_01',
                name: 'Starter Boutique',
                domain: 'starter-boutique.myshopify.com',
                currency: 'USD',
                skuCount: 15,
                skuLimit: null, // NULL in PostgreSQL database
                catalogCompletenessAvg: 90,
                truthBoundaryStrictness: 'standard',
                tier: 'Starter Tier',
                connectorsJson: '[]',
              },
            ],
          };
        },
        release: () => {},
      };

      const mockPool = {
        query: mockClient.query,
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);
      const store = await repo.getStoreByWorkspace('ws_starter_01');

      assert.ok(store);
      assert.ok(executedSql.includes('sku_limit AS "skuLimit"'), 'SQL must query sku_limit column from stores table');
      assert.deepEqual(executedParams, ['ws_starter_01']);
      assert.equal(store?.skuLimit, undefined, 'Null sku_limit in DB must return undefined, not hardcoded 2500');
      assert.equal(store?.tier, 'Starter Tier');

      // Verify that resolveWorkspacePlanEntitlement resolves Starter to 250, not 2500
      const entitlement = resolveWorkspacePlanEntitlement(store);
      assert.equal(entitlement.isValid, true);
      assert.equal(entitlement.tier, 'Starter');
      assert.equal(entitlement.skuLimit, 250, 'Starter must receive verified 250 SKU limit, not 2500');
    });

    test('2. Starter cannot receive Growth limit because of a hardcoded default (even if legacy DB returned 2500)', () => {
      // Scenario where a legacy store row had skuLimit: 2500
      const legacyStarterStore: StoreProfile = {
        name: 'Legacy Starter',
        domain: 'legacy-starter.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: 2500, // Legacy default from previous version
        tier: 'Starter',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      };

      const ent = resolveWorkspacePlanEntitlement(legacyStarterStore);
      assert.equal(ent.isValid, true);
      assert.equal(ent.tier, 'Starter');
      assert.equal(ent.skuLimit, 250, 'Stale 2500 default must be filtered out for Starter tier');
      assert.equal(ent.isUnlimited, false);
    });

    test('3. Enterprise Unlimited is not capped at 2,500 SKUs by stale default or missing limit', () => {
      // Scenario A: Enterprise with null/undefined skuLimit
      const entStoreA: StoreProfile = {
        name: 'Enterprise Store A',
        domain: 'enterprise-a.myshopify.com',
        currency: 'USD',
        skuCount: 10000,
        skuLimit: undefined,
        tier: 'Enterprise',
        connectors: [],
        catalogCompletenessAvg: 95,
        truthBoundaryStrictness: 'strict',
      };
      const entA = resolveWorkspacePlanEntitlement(entStoreA);
      assert.equal(entA.isValid, true);
      assert.equal(entA.tier, 'Enterprise');
      assert.equal(entA.skuLimit, Infinity, 'Enterprise without limit must be Infinity');
      assert.equal(entA.isUnlimited, true);

      // Scenario B: Enterprise store where legacy DB returned 2500
      const entStoreB: StoreProfile = {
        name: 'Enterprise Store B',
        domain: 'enterprise-b.myshopify.com',
        currency: 'USD',
        skuCount: 5000,
        skuLimit: 2500, // Stale default
        tier: 'Enterprise Tier',
        connectors: [],
        catalogCompletenessAvg: 92,
        truthBoundaryStrictness: 'strict',
      };
      const entB = resolveWorkspacePlanEntitlement(entStoreB);
      assert.equal(entB.isValid, true);
      assert.equal(entB.skuLimit, Infinity, 'Enterprise must NEVER be capped at 2500 by stale default');
      assert.equal(entB.isUnlimited, true);
    });

    test('4. saveStoreProfile persists clean whole-number sku_limit into stores table', async () => {
      let insertedSql = '';
      let insertedParams: any[] = [];

      const mockClient = {
        query: async (sql: string, params: any[]) => {
          insertedSql = sql;
          insertedParams = params;
          return {
            rows: [
              {
                name: 'Growth Store',
                domain: 'growth.myshopify.com',
                currency: 'USD',
                skuCount: 100,
                skuLimit: 500, // Custom whole-number limit saved
                catalogCompletenessAvg: 90,
                truthBoundaryStrictness: 'standard',
                tier: 'Growth',
                connectorsJson: '[]',
              },
            ],
          };
        },
        release: () => {},
      };

      const mockPool = {
        query: mockClient.query,
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);
      const saved = await repo.saveStoreProfile('ws_growth_01', {
        name: 'Growth Store',
        domain: 'growth.myshopify.com',
        currency: 'USD',
        skuCount: 100,
        skuLimit: 500,
        tier: 'Growth',
        connectors: [],
        catalogCompletenessAvg: 90,
        truthBoundaryStrictness: 'standard',
      });

      assert.ok(insertedSql.includes('sku_limit'), 'Insert query must include sku_limit column');
      assert.ok(insertedSql.includes('sku_limit = EXCLUDED.sku_limit'), 'ON CONFLICT must update sku_limit');
      assert.equal(insertedParams[6], 500, 'Parameter 7 must be clean integer 500');
      assert.equal(saved.skuLimit, 500);
    });

    test('5. saveWorkspaceCatalog acquires row lock with FOR UPDATE and protects tier from client overwrite', async () => {
      const executedStatements: string[] = [];

      const mockClient = {
        query: async (sql: string) => {
          executedStatements.push(sql);
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);
      await repo.saveWorkspaceCatalog('ws_lock_test', {
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: {
          name: 'Store',
          domain: 'store.myshopify.com',
          currency: 'USD',
          skuCount: 0,
          skuLimit: 999999, // Malicious user-supplied override
          tier: 'Enterprise', // Malicious user-supplied override
          connectors: [],
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard',
        },
      });

      // Verify BEGIN was called
      assert.ok(executedStatements.some(s => s === 'BEGIN'));
      // Verify row lock was acquired on stores table with FOR UPDATE
      assert.ok(
        executedStatements.some(s => s.includes('SELECT id FROM stores WHERE workspace_id = $1 FOR UPDATE')),
        'Must execute SELECT ... FOR UPDATE on stores to serialize cross-instance mutations'
      );
      // Verify that ON CONFLICT in saveWorkspaceCatalog does NOT overwrite tier
      const storeInsertSql = executedStatements.find(s => s.includes('INSERT INTO stores'));
      assert.ok(storeInsertSql);
      assert.ok(!storeInsertSql.includes('tier = EXCLUDED.tier'), 'saveWorkspaceCatalog must never allow tier to be overwritten by user payload');
    });

    test('6. Invalid entitlement data (negative or non-integer) fails safely with limit 0', () => {
      // Fractional SKU limit
      const fractionalStore: StoreProfile = {
        name: 'Fractional Store',
        domain: 'store.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: 12.5 as any,
        tier: 'Growth',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      };
      const fractionalEnt = resolveWorkspacePlanEntitlement(fractionalStore);
      assert.equal(fractionalEnt.isValid, false);
      assert.equal(fractionalEnt.skuLimit, 0);

      // Negative limit
      const negativeStore: StoreProfile = {
        name: 'Negative Store',
        domain: 'store.myshopify.com',
        currency: 'USD',
        skuCount: 0,
        skuLimit: -50,
        tier: 'Growth',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      };
      const negEnt = resolveWorkspacePlanEntitlement(negativeStore);
      assert.equal(negEnt.isValid, false);
      assert.equal(negEnt.skuLimit, 0);
    });

    test('7. Workspace lock cleanup empties map entries after sequential execution', async () => {
      const wsId = 'ws_cleanup_test';
      assert.equal(getActiveWorkspaceLockCount(), 0);

      await withWorkspaceLock(wsId, async () => {
        // While inside lock, map may hold entry
        assert.ok(getActiveWorkspaceLockCount() >= 1);
        return 42;
      });

      // After task completion, lock must be cleaned up
      assert.equal(getActiveWorkspaceLockCount(), 0, 'Active workspace locks count must be 0 after completion');
    });
  });

  // 2. Live PostgreSQL Infrastructure Integration (Conditional)
  describe('Live PostgreSQL Infrastructure Entitlement Integration', () => {
    const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST || process.env.PGHOST);

    test('PostgreSQL live database entitlement integration check', {
      skip: !hasLivePg 
        ? 'SKIPPED: Live PostgreSQL infrastructure credentials (DATABASE_URL / SQL_HOST / PGHOST) not provisioned in current environment' 
        : undefined 
    }, async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        host: process.env.SQL_HOST || process.env.PGHOST,
        user: process.env.SQL_USER || process.env.PGUSER,
        password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
        database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
      });

      const pgRepo = new PostgresRepository(pool);
      assert.equal(await pgRepo.ping(), true);

      // Verify schema readiness
      const ready = await pgRepo.checkSchemaReadiness();
      assert.equal(ready.isReady, true);

      await pool.end();
    });
  });
});
