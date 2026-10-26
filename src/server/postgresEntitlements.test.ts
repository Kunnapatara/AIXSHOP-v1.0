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

    test('11. SKU accounting: saveWorkspaceCatalog persists variant count to stores.sku_count, not products.length', async () => {
      let capturedSkuCountParam: number | null = null;
      let releaseCalled = false;

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          if (sql.includes('SELECT id, tier, sku_limit')) {
            return {
              rows: [
                {
                  id: 'store_ws_sku_acc',
                  tier: 'Growth',
                  sku_limit: 2500,
                  name: 'Growth Store',
                  domain: 'growth.myshopify.com',
                  currency: 'USD',
                  sku_count: 0,
                  catalog_completeness_avg: 80,
                  truth_boundary_strictness: 'standard',
                  connectors_json: '[]',
                },
              ],
            };
          }
          if (sql.includes('INSERT INTO stores')) {
            // Parameter index 6 is sku_count in INSERT INTO stores
            capturedSkuCountParam = params?.[5];
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => { releaseCalled = true; },
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);

      // 2 products with 3 variants each = 6 SKUs total
      const sampleProducts: Product[] = [
        {
          id: 'prod_1',
          title: 'T-Shirt',
          brand: 'FashionCo',
          category: 'Apparel',
          description: 'A fine shirt',
          image: '',
          status: 'active',
          completenessScore: 90,
          evidenceCoverageScore: 80,
          externalDiscoveryStatus: 'observed_in_sample',
          attributes: {},
          findingsCount: 0,
          lastAudited: '',
          variants: [
            { id: 'v1', sku: 'TS-S', title: 'Small', barcode: '', price: 20, inventoryCount: 5, attributes: {} },
            { id: 'v2', sku: 'TS-M', title: 'Medium', barcode: '', price: 20, inventoryCount: 5, attributes: {} },
            { id: 'v3', sku: 'TS-L', title: 'Large', barcode: '', price: 20, inventoryCount: 5, attributes: {} },
          ],
          offers: [],
          evidenceDocuments: [],
        },
        {
          id: 'prod_2',
          title: 'Jeans',
          brand: 'FashionCo',
          category: 'Apparel',
          description: 'Denim jeans',
          image: '',
          status: 'active',
          completenessScore: 90,
          evidenceCoverageScore: 80,
          externalDiscoveryStatus: 'observed_in_sample',
          attributes: {},
          findingsCount: 0,
          lastAudited: '',
          variants: [
            { id: 'v4', sku: 'JN-30', title: '30W', barcode: '', price: 60, inventoryCount: 3, attributes: {} },
            { id: 'v5', sku: 'JN-32', title: '32W', barcode: '', price: 60, inventoryCount: 3, attributes: {} },
            { id: 'v6', sku: 'JN-34', title: '34W', barcode: '', price: 60, inventoryCount: 3, attributes: {} },
          ],
          offers: [],
          evidenceDocuments: [],
        },
      ];

      await repo.saveWorkspaceCatalog('ws_sku_acc', {
        products: sampleProducts,
        variants: sampleProducts.flatMap(p => p.variants || []),
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: {
          name: 'Store',
          domain: 'store.myshopify.com',
          currency: 'USD',
          skuCount: 0,
          catalogCompletenessAvg: 80,
          truthBoundaryStrictness: 'standard',
          tier: 'Growth',
          connectors: [],
        },
      });

      assert.equal(capturedSkuCountParam, 6, 'stores.sku_count must record 6 variants, not products.length (2)');
      assert.equal(releaseCalled, true, 'Client must be released after save');
    });

    test('12. SKU accounting: Products without variants count as 1 SKU each', async () => {
      let capturedSkuCountParam: number | null = null;

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          if (sql.includes('SELECT id, tier, sku_limit')) {
            return {
              rows: [{
                id: 'store_ws_no_vars',
                tier: 'Starter',
                sku_limit: 250,
                name: 'Store',
                domain: 'store.myshopify.com',
                currency: 'USD',
                sku_count: 0,
                catalog_completeness_avg: 0,
                truth_boundary_strictness: 'standard',
                connectors_json: '[]',
              }],
            };
          }
          if (sql.includes('INSERT INTO stores')) {
            capturedSkuCountParam = params?.[5];
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);

      // 3 products, each with empty variants array
      const sampleProducts: Product[] = [
        { id: 'p1', title: 'Gift Card 10', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [], offers: [], evidenceDocuments: [] },
        { id: 'p2', title: 'Gift Card 25', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [], offers: [], evidenceDocuments: [] },
        { id: 'p3', title: 'Gift Card 50', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 100, evidenceCoverageScore: 100, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 0, lastAudited: '', variants: [], offers: [], evidenceDocuments: [] },
      ];

      await repo.saveWorkspaceCatalog('ws_no_vars', {
        products: sampleProducts,
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
          catalogCompletenessAvg: 80,
          truthBoundaryStrictness: 'standard',
          tier: 'Starter',
          connectors: [],
        },
      });

      assert.equal(capturedSkuCountParam, 3, 'Products with 0 variants must count as 1 SKU each');
    });

    test('13. Action update atomicity: approveAction executes in single transaction with SELECT FOR UPDATE', async () => {
      const executedQueries: string[] = [];
      let releaseCalled = false;

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql);
          if (sql.includes('SELECT id, tier, sku_limit') && sql.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 'store_ws_act',
                tier: 'Growth',
                sku_limit: 2500,
                name: 'Action Store',
                domain: 'action.myshopify.com',
                currency: 'USD',
                sku_count: 1,
                catalog_completeness_avg: 80,
                truth_boundary_strictness: 'standard',
                connectors_json: '[]',
              }],
            };
          }
          if (sql.includes('SELECT') && sql.includes('FROM products')) {
            return {
              rows: [{
                id: 'prod_1',
                title: 'Widget A',
                brand: 'Acme',
                category: 'Tools',
                description: 'A tool',
                image: '',
                status: 'active',
                completenessScore: 80,
                evidenceCoverageScore: 80,
                externalDiscoveryStatus: 'observed_in_sample',
                attributesJson: '{}',
                findingsCount: 1,
                lastAudited: '',
              }],
            };
          }
          if (sql.includes('SELECT') && sql.includes('FROM action_items')) {
            return {
              rows: [{
                id: 'act_1',
                findingId: 'find_1',
                productId: 'prod_1',
                title: 'Fix title',
                severity: 'medium',
                status: 'pending_review',
                verificationStatus: 'unverified',
                proposedChangeJson: JSON.stringify({ field: 'title / marketing claims', proposedValue: 'Widget A Pro' }),
                auditLogJson: '[]',
              }],
            };
          }
          if (sql.includes('FROM findings')) {
            return {
              rows: [{
                id: 'find_1',
                productId: 'prod_1',
                scope: 'product',
                type: 'inconsistency',
                severity: 'medium',
                title: 'Title mismatch',
                description: 'Desc',
                observedEvidence: 'E',
                derivedConclusion: 'C',
                merchantVerified: false,
                whyItMatters: 'W',
                actionItemId: 'act_1',
              }],
            };
          }
          return { rows: [] };
        },
        release: () => { releaseCalled = true; },
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);
      const res = await repo.approveAction('ws_act', 'act_1');

      assert.ok(res.action);
      assert.equal(res.action.status, 'approved');
      assert.equal(res.action.id, 'act_1');

      // Verify transaction sequence: BEGIN -> SELECT ... FOR UPDATE -> COMMIT
      const beginIdx = executedQueries.findIndex(q => q === 'BEGIN');
      const lockIdx = executedQueries.findIndex(q => q.includes('FOR UPDATE'));
      const commitIdx = executedQueries.findIndex(q => q === 'COMMIT');

      assert.ok(beginIdx !== -1, 'Must call BEGIN');
      assert.ok(lockIdx !== -1, 'Must acquire store lock with FOR UPDATE');
      assert.ok(commitIdx !== -1, 'Must call COMMIT');
      assert.ok(beginIdx < lockIdx, 'BEGIN must precede FOR UPDATE lock');
      assert.ok(lockIdx < commitIdx, 'Lock must be held until COMMIT');
      assert.equal(releaseCalled, true, 'Client must be released back to pool');
    });

    test('14. Action update atomicity: dismissAction and recheckAction execute under row lock and commit', async () => {
      const executedQueries: string[] = [];

      const mockClient = {
        query: async (sql: string) => {
          executedQueries.push(sql);
          if (sql.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 'store_ws_dismiss',
                tier: 'Starter',
                sku_limit: 250,
                name: 'Store',
                domain: 'store.myshopify.com',
                currency: 'USD',
                sku_count: 1,
                catalog_completeness_avg: 80,
                truth_boundary_strictness: 'standard',
                connectors_json: '[]',
              }],
            };
          }
          if (sql.includes('FROM action_items')) {
            return {
              rows: [{
                id: 'act_dismiss',
                findingId: 'find_d',
                productId: 'p_d',
                title: 'Optional field review',
                severity: 'low',
                status: 'pending',
                verificationStatus: 'unverified',
                proposedChangeJson: '{}',
                auditLogJson: '[]',
              }],
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
      const res = await repo.dismissAction('ws_dismiss', 'act_dismiss');

      assert.ok(res.action);
      assert.equal(res.action.status, 'dismissed');

      assert.ok(executedQueries.includes('BEGIN'));
      assert.ok(executedQueries.some(q => q.includes('FOR UPDATE')));
      assert.ok(executedQueries.includes('COMMIT'));
    });

    test('15. Action update failure triggers clean ROLLBACK and releases database client', async () => {
      let rollbackCalled = false;
      let releaseCalled = false;

      const mockClient = {
        query: async (sql: string) => {
          if (sql === 'ROLLBACK') {
            rollbackCalled = true;
            return { rows: [] };
          }
          if (sql.includes('FOR UPDATE')) {
            // Store not found
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => { releaseCalled = true; },
      };

      const mockPool = {
        connect: async () => mockClient,
      };

      const repo = new PostgresRepository(mockPool as unknown as Pool);

      await assert.rejects(
        async () => {
          await repo.approveAction('ws_missing', 'act_none');
        },
        (err: any) => {
          assert.match(err.message, /not found/);
          return true;
        }
      );

      assert.equal(rollbackCalled, true, 'ROLLBACK must be executed on action failure');
      assert.equal(releaseCalled, true, 'Client must be released on failure');
    });

    test('16. MemoryRepository concurrency: Overlapping approveAction and dismissAction on different actions preserve both mutations', async () => {
      const { MemoryRepository } = await import('./db/memoryRepository');
      const memRepo = new MemoryRepository(false);

      // Create owner user, workspace and initial store
      const user = await memRepo.createUser({
        id: 'usr_conc_owner',
        email: 'concurrency_owner@example.com',
        passwordHash: 'hash123',
        fullName: 'Concurrency Owner',
      });
      const { workspace } = await memRepo.createWorkspace(
        { id: 'ws_concurrency', name: 'Concurrency Retail', slug: 'concurrency-retail' },
        user.id
      );
      await memRepo.saveWorkspaceCatalog(workspace.id, {
        products: [
          {
            id: 'p_conc',
            title: 'Wireless Earbuds',
            brand: 'AudioTech',
            category: 'Electronics',
            description: 'Bluetooth earbuds',
            image: '',
            status: 'active',
            completenessScore: 85,
            evidenceCoverageScore: 80,
            externalDiscoveryStatus: 'observed_in_sample',
            attributes: {},
            findingsCount: 2,
            lastAudited: '',
            variants: [{ id: 'v_conc', sku: 'SKU-EARBUDS', title: 'Black', barcode: '', price: 99, inventoryCount: 10, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
          },
        ],
        variants: [],
        offers: [],
        findings: [
          {
            id: 'find_1',
            productId: 'p_conc',
            scope: 'product',
            type: 'inconsistent_attributes',
            severity: 'medium',
            title: 'Fix title formatting',
            description: '',
            observedEvidence: '',
            derivedConclusion: '',
            merchantVerified: false,
            whyItMatters: '',
            actionItemId: 'act_1',
          },
          {
            id: 'find_2',
            productId: 'p_conc',
            scope: 'product',
            type: 'inconsistent_attributes',
            severity: 'low',
            title: 'Optional barcode note',
            description: '',
            observedEvidence: '',
            derivedConclusion: '',
            merchantVerified: false,
            whyItMatters: '',
            actionItemId: 'act_2',
          },
        ],
        actions: [
          {
            id: 'act_1',
            findingId: 'find_1',
            productId: 'p_conc',
            title: 'Approve title fix',
            severity: 'medium',
            status: 'pending_review',
            verificationStatus: 'unverified',
            evidenceRequired: false,
            proposedChange: { field: 'title / marketing claims', from: 'Wireless Earbuds', to: 'AudioTech Wireless Earbuds Pro' },
            auditLog: [],
          },
          {
            id: 'act_2',
            findingId: 'find_2',
            productId: 'p_conc',
            title: 'Dismiss optional barcode',
            severity: 'low',
            status: 'pending_review',
            verificationStatus: 'unverified',
            evidenceRequired: false,
            proposedChange: { field: 'title / marketing claims', from: '', to: '' },
            auditLog: [],
          },
        ],
        evidence: [],
        storeProfile: {
          name: 'Concurrency Store',
          domain: 'conc.myshopify.com',
          currency: 'USD',
          skuCount: 1,
          catalogCompletenessAvg: 85,
          truthBoundaryStrictness: 'standard',
          tier: 'Growth',
          connectors: [],
        },
      });

      // Launch simultaneous approveAction(act_1) and dismissAction(act_2)
      const p1 = memRepo.approveAction(workspace.id, 'act_1');
      const p2 = memRepo.dismissAction(workspace.id, 'act_2');

      const [resApprove, resDismiss] = await Promise.all([p1, p2]);

      assert.equal(resApprove.action.status, 'approved');
      assert.equal(resDismiss.action.status, 'dismissed');

      // Verify the persisted catalog has BOTH mutations preserved
      const finalCatalog = await memRepo.loadWorkspaceCatalog(workspace.id);
      assert.ok(finalCatalog);

      const action1 = finalCatalog?.actions.find(a => a.id === 'act_1');
      const action2 = finalCatalog?.actions.find(a => a.id === 'act_2');

      assert.equal(action1?.status, 'approved', 'Action 1 must be approved');
      assert.equal(action2?.status, 'dismissed', 'Action 2 must be dismissed — neither mutation lost');
      assert.equal(finalCatalog?.storeProfile?.skuCount, 1, 'SKU count preserved as 1');
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'Workspace lock entry must be removed after operations complete');
    });

    test('17. MemoryRepository workspace lock cleanup: Sequential operations drain and remove map entries', async () => {
      const { MemoryRepository } = await import('./db/memoryRepository');
      const memRepo = new MemoryRepository(false);

      const op1 = await memRepo.withWorkspaceLock('ws_seq', async () => 'result_1');
      assert.equal(op1, 'result_1');
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'Map must be empty after first sequential operation');

      const op2 = await memRepo.withWorkspaceLock('ws_seq', async () => 'result_2');
      assert.equal(op2, 'result_2');
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'Map must remain empty after second sequential operation');
    });

    test('18. MemoryRepository workspace lock cleanup: Overlapping operations preserve queue and clean up after draining', async () => {
      const { MemoryRepository } = await import('./db/memoryRepository');
      const memRepo = new MemoryRepository(false);

      const executionOrder: number[] = [];
      let resolveFirst: () => void;
      const firstGate = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      // Launch Op 1 which blocks on firstGate
      const p1 = memRepo.withWorkspaceLock('ws_overlap', async () => {
        await firstGate;
        executionOrder.push(1);
        return 'res_1';
      });

      // Launch Op 2 immediately while Op 1 is running
      const p2 = memRepo.withWorkspaceLock('ws_overlap', async () => {
        executionOrder.push(2);
        return 'res_2';
      });

      // Launch Op 3 immediately while Op 1 and Op 2 are in flight
      const p3 = memRepo.withWorkspaceLock('ws_overlap', async () => {
        executionOrder.push(3);
        return 'res_3';
      });

      // Lock count should be 1 during execution
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 1, 'Lock map must have 1 active queue for ws_overlap');

      // Unblock Op 1
      resolveFirst!();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1, 'res_1');
      assert.equal(r2, 'res_2');
      assert.equal(r3, 'res_3');

      // Assert strictly sequential execution
      assert.deepEqual(executionOrder, [1, 2, 3], 'Operations must execute strictly in FIFO queued order');

      // Assert complete cleanup after the queue drained
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'Lock map entry must be deleted after queue drains');
    });

    test('19. MemoryRepository workspace lock: Rejected operations do not permanently block subsequent operations', async () => {
      const { MemoryRepository } = await import('./db/memoryRepository');
      const memRepo = new MemoryRepository(false);

      // Op 1 will fail with an error
      const pFail = memRepo.withWorkspaceLock('ws_fail', async () => {
        throw new Error('Simulated repository error');
      });

      // Op 2 queued behind the failing operation
      const pSuccess = memRepo.withWorkspaceLock('ws_fail', async () => {
        return 'recovered_ok';
      });

      await assert.rejects(
        pFail,
        (err: any) => {
          assert.equal(err.message, 'Simulated repository error');
          return true;
        }
      );

      // Op 2 must still execute successfully and not hang
      const res = await pSuccess;
      assert.equal(res, 'recovered_ok', 'Subsequent operation must succeed despite previous rejection');

      // Map must clean up properly
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'Lock map entry must be cleaned up after recovery');
    });

    test('20. MemoryRepository workspace lock: Multi-workspace accumulation does not leak memory', async () => {
      const { MemoryRepository } = await import('./db/memoryRepository');
      const memRepo = new MemoryRepository(false);

      // Run operations across 10 distinct workspaces
      const tasks = Array.from({ length: 10 }, (_, i) =>
        memRepo.withWorkspaceLock(`ws_tenant_${i}`, async () => `done_${i}`)
      );

      const results = await Promise.all(tasks);
      assert.equal(results.length, 10);
      assert.equal(memRepo.getActiveWorkspaceLockCount(), 0, 'All workspace locks must be removed upon completion, zero memory leakage');
    });
  });

  // 2. Live PostgreSQL Infrastructure Integration (Conditional on provisioned database)
  describe('Live PostgreSQL Infrastructure Entitlement Integration', () => {
    const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST || process.env.PGHOST);
    const skipReason = !hasLivePg 
      ? 'SKIPPED: Live PostgreSQL infrastructure credentials (DATABASE_URL / SQL_HOST / PGHOST) not provisioned in current environment' 
      : undefined;

    test('20. Live PostgreSQL: Real migration, schema readiness, and constraint check', { skip: skipReason }, async () => {
      const { runMigrations } = await import('./db/migrate');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        host: process.env.SQL_HOST || process.env.PGHOST,
        user: process.env.SQL_USER || process.env.PGUSER,
        password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
        database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
      });

      const pgRepo = new PostgresRepository(pool);
      assert.equal(await pgRepo.ping(), true, 'Live database must be reachable');

      // 1. Run migrations idempotently
      const migResult = await runMigrations(pool);
      assert.ok(migResult.totalMigrations >= 4, 'Must have at least 4 migrations applied');

      // 2. Verify schema readiness probe
      const ready = await pgRepo.checkSchemaReadiness();
      assert.equal(ready.isReady, true, 'Schema must be reported ready after running migrations');

      await pool.end();
    });

    test('21. Live PostgreSQL: Real transactions, quota enforcement, and multi-connection concurrency', { skip: skipReason }, async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        host: process.env.SQL_HOST || process.env.PGHOST,
        user: process.env.SQL_USER || process.env.PGUSER,
        password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
        database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
        max: 5,
      });

      const pgRepo = new PostgresRepository(pool);
      const testWsId = `ws_live_${Date.now()}`;
      const testUserId = `usr_live_${Date.now()}`;

      // Initialize test user, workspace, and store in Starter tier (250 SKUs)
      await pool.query(
        'INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [testUserId, `${testUserId}@example.com`, 'hash', 'Live Test User']
      );
      await pool.query(
        'INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)',
        [testWsId, 'Live Test Workspace', `live-${Date.now()}`]
      );
      await pool.query(
        'INSERT INTO workspace_memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [`mem_${testWsId}`, testWsId, testUserId, 'owner']
      );
      await pool.query(
        `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, tier, sku_limit, connectors_json)
         VALUES ($1, $2, $3, $4, $5, 0, 'Starter', 250, '[]'::jsonb)`,
        [`store_${testWsId}`, testWsId, 'Live Store', `${testWsId}.myshopify.com`, 'USD']
      );

      // Multi-connection concurrent test:
      // Two connections simultaneously try to import candidate batches (150 SKUs each).
      // Since Starter limit is 250, only one batch can succeed without oversubscribing!
      const batchA = Array.from({ length: 15 }, (_, i) => ({
        id: `p_a_${i}`,
        title: `Product A ${i}`,
        brand: 'Test',
        category: 'Apparel',
        description: 'Test Description',
        image: '',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 80,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: Array.from({ length: 10 }, (_, j) => ({
          id: `var_a_${i}_${j}`,
          sku: `SKU-A-${i}-${j}`,
          title: `V${j}`,
          barcode: '',
          price: 10,
          inventoryCount: 1,
          attributes: {},
        })),
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      })); // 15 products * 10 variants = 150 SKUs

      const batchB = Array.from({ length: 15 }, (_, i) => ({
        id: `p_b_${i}`,
        title: `Product B ${i}`,
        brand: 'Test',
        category: 'Apparel',
        description: 'Test Description',
        image: '',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 80,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: Array.from({ length: 10 }, (_, j) => ({
          id: `var_b_${i}_${j}`,
          sku: `SKU-B-${i}-${j}`,
          title: `V${j}`,
          barcode: '',
          price: 10,
          inventoryCount: 1,
          attributes: {},
        })),
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      })); // 15 products * 10 variants = 150 SKUs

      // Execute concurrently
      const results = await Promise.allSettled([
        pgRepo.importCatalog(testWsId, batchA as any),
        pgRepo.importCatalog(testWsId, batchB as any),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one concurrent batch must succeed within 250 limit');
      assert.equal(rejected.length, 1, 'Second concurrent batch must be rejected without oversubscribing quota');

      // Verify authoritative store SKU count is exactly 150
      const storeRes = await pool.query('SELECT sku_count FROM stores WHERE workspace_id = $1', [testWsId]);
      assert.equal(storeRes.rows[0].sku_count, 150, 'Persisted stores.sku_count must record exactly 150 SKUs');

      // Intentional transaction failure & rollback test
      let rollbackThrew = false;
      try {
        await (pgRepo as any).mutateCatalogUnderLock(testWsId, () => {
          throw new Error('Intentional transaction abort for rollback verification');
        });
      } catch (err: any) {
        rollbackThrew = true;
        assert.match(err.message, /Intentional transaction abort/);
      }
      assert.equal(rollbackThrew, true, 'Error must propagate');

      // Clean up test workspace
      await pool.query('DELETE FROM workspaces WHERE id = $1', [testWsId]);
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);

      await pool.end();
    });
  });
});
