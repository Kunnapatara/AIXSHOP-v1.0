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
        executedStatements.some(s => s.includes('FROM stores') && s.includes('FOR UPDATE')),
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

    test('8. Independent DB connection concurrency: simulated 2 parallel DB connections calling importCatalog directly (bypassing in-memory lock) serialize via FOR UPDATE', async () => {
      const clientLocks = new Map<string, Promise<void>>();
      const connectionLog: string[] = [];

      function createSimulatedDbClient(clientLabel: string) {
        let releaseLock: (() => void) | null = null;
        return {
          query: async (sql: string, params?: any[]) => {
            if (sql === 'BEGIN') {
              connectionLog.push(`${clientLabel}:BEGIN`);
              return { rows: [] };
            }
            if (sql.includes('FOR UPDATE')) {
              connectionLog.push(`${clientLabel}:ACQUIRE_ROW_LOCK`);
              const existingLock = clientLocks.get('ws_concurrency');
              if (existingLock) {
                // Wait for the other DB transaction to finish, simulating PostgreSQL row-level wait
                await existingLock;
              }
              const lockPromise = new Promise<void>((resolve) => {
                releaseLock = resolve;
              });
              clientLocks.set('ws_concurrency', lockPromise);

              return {
                rows: [
                  {
                    id: 'store_ws_concurrency',
                    tier: 'Starter',
                    sku_limit: 250,
                    name: 'Concurrency Store',
                    domain: 'concurrency.myshopify.com',
                    currency: 'USD',
                    sku_count: 0,
                    catalog_completeness_avg: 0,
                    truth_boundary_strictness: 'standard',
                    connectors_json: '[]',
                  },
                ],
              };
            }
            if (sql.includes('SELECT') && sql.includes('FROM products')) {
              return { rows: [] };
            }
            if (sql.includes('SELECT') && sql.includes('FROM variants')) {
              return { rows: [] };
            }
            if (sql.includes('SELECT') && (sql.includes('FROM offers') || sql.includes('FROM findings') || sql.includes('FROM action_items') || sql.includes('FROM evidence_documents'))) {
              return { rows: [] };
            }
            if (sql === 'COMMIT') {
              connectionLog.push(`${clientLabel}:COMMIT`);
              if (releaseLock) {
                releaseLock();
                clientLocks.delete('ws_concurrency');
              }
              return { rows: [] };
            }
            if (sql === 'ROLLBACK') {
              connectionLog.push(`${clientLabel}:ROLLBACK`);
              if (releaseLock) {
                releaseLock();
                clientLocks.delete('ws_concurrency');
              }
              return { rows: [] };
            }
            return { rows: [] };
          },
          release: () => {
            connectionLog.push(`${clientLabel}:RELEASE`);
            if (releaseLock) {
              releaseLock();
              clientLocks.delete('ws_concurrency');
            }
          },
        };
      }

      let clientCounter = 0;
      const simulatedPool = {
        connect: async () => {
          clientCounter++;
          return createSimulatedDbClient(`Client${clientCounter}`);
        },
      };

      const repo = new PostgresRepository(simulatedPool as unknown as Pool);

      // Call importCatalog from 2 parallel connections directly (NO withWorkspaceLock in-memory wrapper!)
      const candidateBatchA = [
        {
          id: 'cand_a1',
          name: 'Product A1',
          variants: [{ id: 'var_a1', sku: 'SKU-A1', title: 'Default', price: 20 }],
        },
      ];
      const candidateBatchB = [
        {
          id: 'cand_b1',
          name: 'Product B1',
          variants: [{ id: 'var_b1', sku: 'SKU-B1', title: 'Default', price: 30 }],
        },
      ];

      const [resA, resB] = await Promise.all([
        repo.importCatalog('ws_concurrency', candidateBatchA),
        repo.importCatalog('ws_concurrency', candidateBatchB),
      ]);

      assert.ok(resA);
      assert.ok(resB);
      assert.ok(connectionLog.includes('Client1:ACQUIRE_ROW_LOCK'));
      assert.ok(connectionLog.includes('Client2:ACQUIRE_ROW_LOCK'));
      assert.ok(connectionLog.includes('Client1:COMMIT'));
      assert.ok(connectionLog.includes('Client2:COMMIT'));
      assert.equal(clientLocks.size, 0, 'Database row locks must be cleanly released');
    });

    test('9. Transactional rollback in saveWorkspaceCatalog on quota violation leaves 0 modified rows', async () => {
      const executedStatements: string[] = [];
      const mockClient = {
        query: async (sql: string) => {
          executedStatements.push(sql);
          if (sql.includes('FOR UPDATE')) {
            return {
              rows: [
                {
                  id: 'store_ws_rb',
                  tier: 'Starter',
                  sku_limit: 2, // Hard limit 2 SKUs
                  name: 'Rollback Store',
                  domain: 'rollback.myshopify.com',
                  currency: 'USD',
                  sku_count: 0,
                  catalog_completeness_avg: 0,
                  truth_boundary_strictness: 'standard',
                  connectors_json: '[]',
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);

      // Attempt to save 3 products (> 2 SKU limit)
      await assert.rejects(
        async () => {
          await repo.saveWorkspaceCatalog('ws_rb', {
            products: [
              { id: 'p1', title: 'P1', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [{ id: 'v1', sku: 'SKU-1', title: 'V1', barcode: '', price: 10, inventoryCount: 1, attributes: {} }], offers: [], evidenceDocuments: [] },
              { id: 'p2', title: 'P2', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [{ id: 'v2', sku: 'SKU-2', title: 'V2', barcode: '', price: 20, inventoryCount: 1, attributes: {} }], offers: [], evidenceDocuments: [] },
              { id: 'p3', title: 'P3', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [{ id: 'v3', sku: 'SKU-3', title: 'V3', barcode: '', price: 30, inventoryCount: 1, attributes: {} }], offers: [], evidenceDocuments: [] },
            ],
            variants: [],
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: {
              name: 'Rollback Store',
              domain: 'rollback.myshopify.com',
              currency: 'USD',
              skuCount: 0,
              catalogCompletenessAvg: 0,
              truthBoundaryStrictness: 'standard',
              tier: 'Starter',
              connectors: [],
            },
          });
        },
        (err: any) => {
          assert.equal(err.code, 'PLAN_QUOTA_EXCEEDED');
          return true;
        }
      );

      // Verify that ROLLBACK was executed and no DELETE or INSERT INTO products occurred
      assert.ok(executedStatements.includes('ROLLBACK'), 'Must execute ROLLBACK when quota is exceeded');
      assert.ok(!executedStatements.some(s => s.includes('DELETE FROM products')), 'Must never delete products if quota check failed');
      assert.ok(!executedStatements.some(s => s.includes('INSERT INTO products')), 'Must never insert products if quota check failed');
    });

    test('10. Workspace isolation: Workspace A query strictly scopes to workspace_id parameter', async () => {
      const executedParamsList: any[][] = [];
      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          if (params) executedParamsList.push(params);
          if (sql.includes('FROM stores')) {
            return {
              rows: [
                {
                  name: 'Isolated Store A',
                  domain: 'iso-a.myshopify.com',
                  currency: 'USD',
                  skuCount: 5,
                  catalogCompletenessAvg: 80,
                  truthBoundaryStrictness: 'standard',
                  tier: 'Starter',
                  connectorsJson: '[]',
                  skuLimit: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        query: mockClient.query,
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);
      await repo.getStoreByWorkspace('workspace_tenant_a');

      assert.ok(executedParamsList.length > 0);
      assert.equal(executedParamsList[0][0], 'workspace_tenant_a', 'Query must parameterize workspace_id strictly');
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
