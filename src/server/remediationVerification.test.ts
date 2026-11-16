import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PostgresRepository } from './db/postgresRepository';
import { WorkspaceLockOrderError } from './db/repository';
import { MemoryRepository } from './db/memoryRepository';
import { createApp } from './app';
import {
  evaluateDemoOverwriteProtection,
  DEMO_OVERWRITE_COLLECTIONS,
} from '../domain/catalog/demoMigrationProtection';
import { AuthContext } from '../context/AuthContext';
import { AppContext, AppContextType } from '../context/AppContext';
import { LandingPage } from '../pages/LandingPage';
import {
  SettingsPage,
  DemoCatalogMigrationSection,
  DemoCatalogMigrationSectionProps,
} from '../pages/SettingsPage';
import { initialStoreProfile } from '../data/mockData';

interface SimulatedClient {
  id: number;
  destroyed: boolean;
  releasedCount: number;
  releaseCalls: Array<{ destroy: boolean }>;
  queries: string[];
  heldLocks: Set<string>;
}

function findElementsByType(node: any, typeName: string): any[] {
  const results: any[] = [];
  const visit = (el: any) => {
    if (!el || typeof el !== 'object') return;
    if (Array.isArray(el)) {
      for (const child of el) visit(child);
      return;
    }
    if (el.type === typeName) {
      results.push(el);
    }
    if (el.props && el.props.children !== undefined) {
      visit(el.props.children);
    }
  };
  visit(node);
  return results;
}

function extractText(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (typeof node === 'object' && node.props && node.props.children !== undefined) {
    return extractText(node.props.children);
  }
  return '';
}

function buildMockAppContext(overrides: Partial<AppContextType> = {}): AppContextType {
  const baseOverwrite = evaluateDemoOverwriteProtection({
    isCloudWorkspace: true,
    cloudCatalogStatus: 'loaded',
    catalogVersion: 1,
    productsCount: 0,
    variantsCount: 0,
    offersCount: 0,
    findingsCount: 0,
    actionsCount: 0,
    evidenceCount: 0,
  });

  return {
    currentPage: 'home',
    previousPage: 'home',
    selectedProductId: null,
    selectedActionId: null,
    storeProfile: {
      ...initialStoreProfile,
      tier: 'Growth',
      skuLimit: 2500,
    },
    products: [],
    variantsCount: 0,
    offersCount: 0,
    findings: [],
    actionItems: [],
    evidenceCount: 0,
    toasts: [],
    quickCheckResult: null,
    lastIngestionResult: null,
    isCheckingStore: false,
    selectedProduct: null,
    mobileMenuOpen: false,
    isReadOnlyMode: false,
    readOnlyReason: null,
    storageLoadResult: null,
    isDurableStorage: true,
    isCloudWorkspace: true,
    cloudCatalogStatus: 'loaded',
    catalogVersion: 1,
    demoOverwriteProtection: baseOverwrite,
    setMobileMenuOpen: () => {},
    setSelectedActionId: () => {},
    navigateTo: () => {},
    viewProductDetail: () => {},
    returnFromProductDetail: () => {},
    runStoreCheck: async () => {},
    importDiscoveredProducts: async () => null,
    approveAction: async () => {},
    dismissAction: async () => {},
    recheckAction: async () => {},
    recheckProduct: () => {},
    updateStoreProfile: async () => ({ success: true }),
    toggleConnectorSync: async () => ({ success: true }),
    migrateDemoDataToCloud: async () => true,
    runAudit: async () => ({}),
    addToast: () => {},
    removeToast: () => {},
    resetToSeedData: () => {},
    reloadWorkspaceCatalog: async () => {},
    ...overrides,
  };
}

async function startTempServer(app: ReturnType<typeof createApp>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: http.Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('Workstreams A, B, C, H, I, K — Deterministic Remediation Verification', () => {
  // =========================================================================
  // WORKSTREAM A — Standalone & Held-Lock Transaction Pool Lifecycle
  // =========================================================================
  describe('Workstream A: withTransaction Pooled Client Lifecycle & Poison Tracking', () => {
    function createTransactionTestPool(opts: {
      failBegin?: boolean;
      failRollback?: boolean;
      failCommit?: boolean;
      failSavepointCreate?: boolean;
    } = {}) {
      let nextClientId = 1;
      const allClients: SimulatedClient[] = [];
      const idleClients: SimulatedClient[] = [];

      const pool: any = {
        connect: async () => {
          if (idleClients.length > 0) {
            return idleClients.shift()!;
          }
          const sim: SimulatedClient = {
            id: nextClientId++,
            destroyed: false,
            releasedCount: 0,
            releaseCalls: [],
            queries: [],
            heldLocks: new Set<string>(),
          };
          allClients.push(sim);

          const clientObj: any = {
            _sim: sim,
            query: async (sql: string, params?: any[]) => {
              sim.queries.push(sql);
              if (sql === 'BEGIN' && opts.failBegin) {
                throw new Error('BEGIN failed on wire');
              }
              if (sql === 'ROLLBACK' && opts.failRollback) {
                throw new Error('ROLLBACK failed: socket closed');
              }
              if (sql === 'COMMIT' && opts.failCommit) {
                throw new Error('COMMIT failed: serialization failure');
              }
              if (sql.startsWith('SAVEPOINT ') && opts.failSavepointCreate) {
                throw new Error('SAVEPOINT creation failed');
              }
              if (sql.includes('pg_try_advisory_lock')) {
                sim.heldLocks.add(String(params?.[0] || ''));
                return { rows: [{ locked: true }] };
              }
              if (sql.includes('pg_advisory_unlock')) {
                sim.heldLocks.delete(String(params?.[0] || ''));
                return { rows: [{ pg_advisory_unlock: true }] };
              }
              return { rows: [], rowCount: 1 };
            },
            release: (destroy?: boolean) => {
              sim.releasedCount += 1;
              sim.releaseCalls.push({ destroy: Boolean(destroy) });
              if (destroy) {
                sim.destroyed = true;
                sim.heldLocks.clear();
              } else {
                idleClients.push(clientObj);
              }
            },
          };
          return clientObj;
        },
        allClients,
        idleClients,
      };
      return pool;
    }

    test('A1. Normal commit returns healthy client to pool once and reuses it on next operation', async () => {
      const pool = createTransactionTestPool();
      const repo = new PostgresRepository(pool);

      const res1 = await (repo as any).withTransaction(async () => 'tx_ok_1');
      assert.equal(res1, 'tx_ok_1');
      assert.equal(pool.allClients.length, 1);
      assert.equal(pool.allClients[0].releasedCount, 1);
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: false }]);
      assert.equal(pool.allClients[0].destroyed, false);

      // Next operation reuses the same healthy pooled client
      const res2 = await (repo as any).withTransaction(async () => 'tx_ok_2');
      assert.equal(res2, 'tx_ok_2');
      assert.equal(pool.allClients.length, 1, 'Healthy client should be reused');
      assert.equal(pool.allClients[0].releasedCount, 2);
    });

    test('A2. Callback error + clean ROLLBACK rethrows original error and returns healthy client to pool once', async () => {
      const pool = createTransactionTestPool();
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () =>
          (repo as any).withTransaction(async () => {
            throw new Error('domain constraint failure');
          }),
        /domain constraint failure/
      );

      assert.equal(pool.allClients.length, 1);
      assert.equal(pool.allClients[0].releasedCount, 1);
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: false }]);
      assert.ok(pool.allClients[0].queries.includes('ROLLBACK'));
    });

    test('A3. Callback error + ROLLBACK failure calls client.release(true), preserves original error, and never reuses destroyed client', async () => {
      const pool = createTransactionTestPool({ failRollback: true });
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () =>
          (repo as any).withTransaction(async () => {
            throw new Error('ORIGINAL_CALLBACK_ERROR');
          }),
        (err: any) => err instanceof Error && err.message === 'ORIGINAL_CALLBACK_ERROR'
      );

      assert.equal(pool.allClients.length, 1);
      assert.equal(pool.allClients[0].releasedCount, 1);
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: true }]);
      assert.equal(pool.allClients[0].destroyed, true);

      // Next operation gets a brand new client (never the destroyed one)
      pool.allClients[0].queries.length = 0;
      const resNext = await (repo as any).withTransaction(async () => 'fresh_client_ok');
      assert.equal(resNext, 'fresh_client_ok');
      assert.equal(pool.allClients.length, 2, 'Destroyed client must never be reused');
    });

    test('A4. BEGIN failure skips ROLLBACK, destroys client once via release(true), and rethrows BEGIN error', async () => {
      const pool = createTransactionTestPool({ failBegin: true });
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () =>
          (repo as any).withTransaction(async () => {
            throw new Error('should not execute callback');
          }),
        /BEGIN failed on wire/
      );

      assert.equal(pool.allClients.length, 1);
      assert.equal(pool.allClients[0].releasedCount, 1);
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: true }]);
      assert.equal(pool.allClients[0].queries.includes('ROLLBACK'), false, 'ROLLBACK must NOT run if BEGIN failed');
    });

    test('A5. COMMIT failure attempts ROLLBACK and destroys client if ROLLBACK also fails while preserving COMMIT error', async () => {
      const pool = createTransactionTestPool({ failCommit: true, failRollback: true });
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () => (repo as any).withTransaction(async () => 'ignored'),
        /COMMIT failed: serialization failure/
      );

      assert.equal(pool.allClients[0].releasedCount, 1);
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: true }]);
    });

    test('A6. Held-lock path: BEGIN failure or SAVEPOINT failure marks ctx.poisoned = true so outer withWorkspaceLock destroys client cleanly', async () => {
      const poolBeginFail = createTransactionTestPool({ failBegin: true });
      const repoBeginFail = new PostgresRepository(poolBeginFail);

      await assert.rejects(
        () =>
          repoBeginFail.withWorkspaceLock('ws_tx_lock_1', async () => {
            return await (repoBeginFail as any).withTransaction(async () => 'unreachable');
          }),
        /BEGIN failed on wire/
      );
      assert.equal(poolBeginFail.allClients[0].destroyed, true);
      assert.equal(poolBeginFail.allClients[0].releasedCount, 1);

      const poolSpFail = createTransactionTestPool({ failSavepointCreate: true });
      const repoSpFail = new PostgresRepository(poolSpFail);

      await assert.rejects(
        () =>
          repoSpFail.withWorkspaceLock('ws_tx_lock_2', async () => {
            return await (repoSpFail as any).withTransaction(async () => {
              return await (repoSpFail as any).withTransaction(async () => 'unreachable');
            });
          }),
        /SAVEPOINT creation failed/
      );
      assert.equal(poolSpFail.allClients[0].destroyed, true, 'Savepoint creation failure must poison held-lock client');
      assert.equal(poolSpFail.allClients[0].releasedCount, 1);
    });
  });

  // =========================================================================
  // WORKSTREAM B — Distributed Workspace Lock Uncertain State & Poisoning
  // =========================================================================
  describe('Workstream B: withWorkspaceLock Uncertain Lock Acquisition & Connection Poisoning', () => {
    function createLockTestPool(opts: {
      outerTryThrowsOnce?: boolean;
      outerTryReturnsFalseTimes?: number;
      nestedTryThrowsForWs?: string;
      nestedUnlockThrowsForWs?: string;
      nestedUnlockFalseForWs?: string;
      failRollbackOnInner?: boolean;
    } = {}) {
      let nextClientId = 1;
      let outerTryThrowsRemaining = opts.outerTryThrowsOnce ? 1 : 0;
      let outerTryFalseRemaining = opts.outerTryReturnsFalseTimes ?? 0;

      const allClients: SimulatedClient[] = [];
      const idleClients: SimulatedClient[] = [];

      const pool: any = {
        connect: async () => {
          if (idleClients.length > 0) {
            return idleClients.shift()!;
          }
          const sim: SimulatedClient = {
            id: nextClientId++,
            destroyed: false,
            releasedCount: 0,
            releaseCalls: [],
            queries: [],
            heldLocks: new Set<string>(),
          };
          allClients.push(sim);

          const clientObj: any = {
            _sim: sim,
            query: async (sql: string, params?: any[]) => {
              sim.queries.push(sql);
              const key = String(params?.[0] || '');
              if (sql.includes('pg_try_advisory_lock')) {
                if (opts.nestedTryThrowsForWs && key === opts.nestedTryThrowsForWs) {
                  throw new Error(`timeout waiting for nested pg_try_advisory_lock(${key})`);
                }
                if (outerTryThrowsRemaining > 0) {
                  outerTryThrowsRemaining--;
                  throw new Error('network error during pg_try_advisory_lock response');
                }
                if (outerTryFalseRemaining > 0) {
                  outerTryFalseRemaining--;
                  return { rows: [{ locked: false }] };
                }
                sim.heldLocks.add(key);
                return { rows: [{ locked: true }] };
              }
              if (sql.includes('pg_advisory_unlock')) {
                if (opts.nestedUnlockThrowsForWs && key === opts.nestedUnlockThrowsForWs) {
                  throw new Error(`nested unlock socket error for ${key}`);
                }
                if (opts.nestedUnlockFalseForWs && key === opts.nestedUnlockFalseForWs) {
                  return { rows: [{ pg_advisory_unlock: false }] };
                }
                sim.heldLocks.delete(key);
                return { rows: [{ pg_advisory_unlock: true }] };
              }
              if (sql === 'ROLLBACK' && opts.failRollbackOnInner) {
                throw new Error('rollback failed inside held workspace lock');
              }
              return { rows: [], rowCount: 1 };
            },
            release: (destroy?: boolean) => {
              sim.releasedCount += 1;
              sim.releaseCalls.push({ destroy: Boolean(destroy) });
              if (destroy) {
                sim.destroyed = true;
                sim.heldLocks.clear();
              } else {
                idleClients.push(clientObj);
              }
            },
          };
          return clientObj;
        },
        allClients,
      };
      return pool;
    }

    test('B1. Outer pg_try_advisory_lock throwing destroys client via release(true) so uncertain session lock cannot return to pool', async () => {
      const pool = createLockTestPool({ outerTryThrowsOnce: true });
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () => repo.withWorkspaceLock('ws_b_uncertain', async () => 'unreachable'),
        /network error during pg_try_advisory_lock/
      );

      assert.equal(pool.allClients.length, 1);
      assert.equal(pool.allClients[0].destroyed, true, 'Uncertain lock acquisition MUST call client.release(true)');
      assert.deepEqual(pool.allClients[0].releaseCalls, [{ destroy: true }]);
    });

    test('B2. Outer pg_try_advisory_lock returning locked=false releases client cleanly before backoff and retries to completion', async () => {
      const pool = createLockTestPool({ outerTryReturnsFalseTimes: 2 });
      const repo = new PostgresRepository(pool);

      const out = await repo.withWorkspaceLock('ws_b_retry', async () => 'acquired_on_third');
      assert.equal(out, 'acquired_on_third');
      assert.equal(pool.allClients.length, 1, 'Clean releases let subsequent attempts reuse client without exhaustion');
      assert.equal(pool.allClients[0].destroyed, false);
      assert.equal(pool.allClients[0].releasedCount, 3);
    });

    test('B3. Nested pg_try_advisory_lock failure poisons ctx so outer withWorkspaceLock destroys client via release(true)', async () => {
      const pool = createLockTestPool({ nestedTryThrowsForWs: 'ws_b_nested' });
      const repo = new PostgresRepository(pool);

      await assert.rejects(
        () =>
          repo.withWorkspaceLock('ws_a_outer', async () => {
            return await repo.withWorkspaceLock('ws_b_nested', async () => 'unreachable');
          }),
        /timeout waiting for nested pg_try_advisory_lock/
      );

      assert.equal(pool.allClients[0].destroyed, true, 'Nested lock uncertainty MUST poison outer client');
      assert.equal(pool.allClients[0].releasedCount, 1);
    });

    test('B4. Nested unlock returning false or throwing, or ROLLBACK failing inside held lock, destroys client on outer exit', async () => {
      // Case 1: nested unlock returns false
      const pFalse = createLockTestPool({ nestedUnlockFalseForWs: 'ws_z_inner' });
      const rFalse = new PostgresRepository(pFalse);
      const ok = await rFalse.withWorkspaceLock('ws_a_outer', async () =>
        rFalse.withWorkspaceLock('ws_z_inner', async () => 'inner_done')
      );
      assert.equal(ok, 'inner_done');
      assert.equal(pFalse.allClients[0].destroyed, true);

      // Case 2: nested unlock throws
      const pThrow = createLockTestPool({ nestedUnlockThrowsForWs: 'ws_z_inner' });
      const rThrow = new PostgresRepository(pThrow);
      const ok2 = await rThrow.withWorkspaceLock('ws_a_outer', async () =>
        rThrow.withWorkspaceLock('ws_z_inner', async () => 'inner_done_2')
      );
      assert.equal(ok2, 'inner_done_2');
      assert.equal(pThrow.allClients[0].destroyed, true);

      // Case 3: rollback fails inside held lock even though outer unlock succeeds
      const pRb = createLockTestPool({ failRollbackOnInner: true });
      const rRb = new PostgresRepository(pRb);
      await assert.rejects(
        () =>
          rRb.withWorkspaceLock('ws_a_outer', async () =>
            (rRb as any).withTransaction(async () => {
              throw new Error('inner_tx_op_fail');
            })
          ),
        /inner_tx_op_fail/
      );
      assert.equal(pRb.allClients[0].destroyed, true);
    });

    test('B5. Clean outer unlock returns healthy client to pool, preserves same-ws reentrancy, and rejects reverse workspace order', async () => {
      const pool = createLockTestPool();
      const repo = new PostgresRepository(pool);

      const val = await repo.withWorkspaceLock('ws_alpha', async () =>
        repo.withWorkspaceLock('ws_alpha', async () =>
          repo.withWorkspaceLock('ws_beta', async () => 'ordered_reentrant_ok')
        )
      );
      assert.equal(val, 'ordered_reentrant_ok');
      assert.equal(pool.allClients[0].destroyed, false);
      assert.equal(pool.allClients[0].releasedCount, 1);

      await assert.rejects(
        () =>
          repo.withWorkspaceLock('ws_zeta', async () =>
            repo.withWorkspaceLock('ws_alpha', async () => 'should_not_run')
          ),
        (err: any) => err instanceof WorkspaceLockOrderError && err.code === 'WORKSPACE_LOCK_ORDER_VIOLATION'
      );
      assert.equal(pool.allClients[0].destroyed, false);
      assert.equal(pool.allClients[0].releasedCount, 2);
    });
  });

  // =========================================================================
  // WORKSTREAM C — Demo Catalog Migration Confirmation & UI Safety
  // =========================================================================
  describe('Workstream C: Demo Catalog Overwrite Protection & Optimistic Concurrency', () => {
    test('C1. evaluateDemoOverwriteProtection covers all 6 collections, catalogVersion > 1, and unknown loading/error states', () => {
      assert.deepEqual([...DEMO_OVERWRITE_COLLECTIONS], [
        'products',
        'variants',
        'offers',
        'findings',
        'actions',
        'evidence',
      ]);

      // Truly empty, initialized version=1, loaded -> no confirmation required
      const emptyLoaded = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 0,
        evidenceCount: 0,
      });
      assert.equal(emptyLoaded.requiresConfirmation, false);
      assert.equal(emptyLoaded.isUnknownState, false);

      // 0 products but findings > 0 -> MUST require confirmation
      const withFindings = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 3,
        actionsCount: 0,
        evidenceCount: 0,
      });
      assert.equal(withFindings.requiresConfirmation, true);
      assert.deepEqual(
        withFindings.nonEmptyCategories.map((c) => `${c.key}:${c.count}`),
        ['findings:3']
      );

      // 0 products but actions > 0 -> MUST require confirmation
      const withActions = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 4,
        evidenceCount: 0,
      });
      assert.equal(withActions.requiresConfirmation, true);
      assert.equal(withActions.nonEmptyCategories[0].key, 'actions');

      // 0 products but evidence > 0 -> MUST require confirmation
      const withEvidence = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 0,
        evidenceCount: 2,
      });
      assert.equal(withEvidence.requiresConfirmation, true);
      assert.equal(withEvidence.nonEmptyCategories[0].key, 'evidence');

      // 0 entities across all 6 collections, but catalogVersion > 1 -> MUST require confirmation
      const initializedVersion = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 2,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 0,
        evidenceCount: 0,
      });
      assert.equal(initializedVersion.requiresConfirmation, true);
      assert.equal(initializedVersion.isInitializedCatalog, true);

      // Unknown load state (loading, error, idle) -> MUST require confirmation & mark isUnknownState
      for (const status of ['idle', 'loading', 'error'] as const) {
        const unknown = evaluateDemoOverwriteProtection({
          isCloudWorkspace: true,
          cloudCatalogStatus: status,
          catalogVersion: 1,
          productsCount: 0,
          variantsCount: 0,
          offersCount: 0,
          findingsCount: 0,
          actionsCount: 0,
          evidenceCount: 0,
        });
        assert.equal(unknown.requiresConfirmation, true, `Status ${status} must require confirmation`);
        assert.equal(unknown.isUnknownState, true, `Status ${status} must flag isUnknownState`);
      }
    });

    test('C2. DemoCatalogMigrationSection component enforces confirmation, lists 6 collections, shows Reload in unknown state, and wires Cancel/Confirm cleanly', async () => {
      // 1. Loaded empty workspace -> initial click runs migration directly without confirmation prompt
      let migratedCalls = 0;
      let confirmStates: boolean[] = [];
      let emptyProps: DemoCatalogMigrationSectionProps = {
        isAuthenticated: true,
        openAuthModal: () => {},
        overwriteProtection: evaluateDemoOverwriteProtection({
          isCloudWorkspace: true,
          cloudCatalogStatus: 'loaded',
          catalogVersion: 1,
          productsCount: 0,
          variantsCount: 0,
          offersCount: 0,
          findingsCount: 0,
          actionsCount: 0,
          evidenceCount: 0,
        }),
        confirmingDemoOverwrite: false,
        setConfirmingDemoOverwrite: (next) => confirmStates.push(next),
        isMigratingDemo: false,
        setIsMigratingDemo: () => {},
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        migrateDemoDataToCloud: async () => {
          migratedCalls += 1;
          return true;
        },
        reloadWorkspaceCatalog: async () => {},
      };
      const emptyTree = DemoCatalogMigrationSection(emptyProps);
      const emptyBtn = findElementsByType(emptyTree, 'button')[0];
      await emptyBtn.props.onClick();
      assert.equal(migratedCalls, 1);
      assert.equal(confirmStates.length, 0);

      // 2. 0 products + 2 evidence docs -> initial click opens confirmation instead of calling migrateDemoDataToCloud
      migratedCalls = 0;
      confirmStates = [];
      const evidenceOnlyProtection = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'loaded',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 0,
        evidenceCount: 2,
      });
      const evidenceProps: DemoCatalogMigrationSectionProps = {
        ...emptyProps,
        overwriteProtection: evidenceOnlyProtection,
        confirmingDemoOverwrite: false,
      };
      const evTree1 = DemoCatalogMigrationSection(evidenceProps);
      const evBtn1 = findElementsByType(evTree1, 'button')[0];
      await evBtn1.props.onClick();
      assert.equal(migratedCalls, 0, 'Must NOT overwrite before explicit confirmation');
      assert.deepEqual(confirmStates, [true]);

      // Render confirming state HTML -> verifies non-empty category + all 6 collections mentioned
      const evHtml = renderToStaticMarkup(
        React.createElement(DemoCatalogMigrationSection, {
          ...evidenceProps,
          confirmingDemoOverwrite: true,
        })
      );
      assert.match(evHtml, /2 evidence documents/);
      assert.match(evHtml, /products, variants, offers, findings, actions, and evidence/);
      assert.match(evHtml, /Confirm Replace Workspace Catalog/);
      assert.match(evHtml, /Cancel/);
      assert.doesNotMatch(evHtml, /Reload Catalog State/);

      // Clicking Confirm triggers migration; clicking Cancel resets confirmation without migrating
      const confirmTree = DemoCatalogMigrationSection({
        ...evidenceProps,
        confirmingDemoOverwrite: true,
      });
      const buttons = findElementsByType(confirmTree, 'button');
      const cancelBtn = buttons.find((b) => extractText(b).includes('Cancel'));
      const confirmBtn = buttons.find((b) => extractText(b).includes('Confirm Replace Workspace Catalog'));
      await cancelBtn.props.onClick();
      assert.deepEqual(confirmStates, [true, false]);
      assert.equal(migratedCalls, 0);
      await confirmBtn.props.onClick();
      assert.equal(migratedCalls, 1);

      // 3. Unknown state (cloudCatalogStatus = 'error') shows Reload Catalog State + executes reload handler
      let reloaded = 0;
      const unknownProtection = evaluateDemoOverwriteProtection({
        isCloudWorkspace: true,
        cloudCatalogStatus: 'error',
        catalogVersion: 1,
        productsCount: 0,
        variantsCount: 0,
        offersCount: 0,
        findingsCount: 0,
        actionsCount: 0,
        evidenceCount: 0,
      });
      const unknownProps: DemoCatalogMigrationSectionProps = {
        ...emptyProps,
        cloudCatalogStatus: 'error',
        overwriteProtection: unknownProtection,
        confirmingDemoOverwrite: true,
        reloadWorkspaceCatalog: async () => {
          reloaded += 1;
        },
      };
      const unknownHtml = renderToStaticMarkup(React.createElement(DemoCatalogMigrationSection, unknownProps));
      assert.match(unknownHtml, /has not finished loading or failed to verify/);
      assert.match(unknownHtml, /Reload Catalog State/);

      const unknownTree = DemoCatalogMigrationSection(unknownProps);
      const reloadBtn = findElementsByType(unknownTree, 'button').find((b) =>
        extractText(b).includes('Reload Catalog State')
      );
      await reloadBtn.props.onClick();
      assert.equal(reloaded, 1);
    });

    test('C3. /api/catalog/migrate-demo enforces expectedVersion optimistic locking and rejects stale concurrent calls with 409', async () => {
      const repo = new MemoryRepository();
      const token = 'tok_c3_demo';
      await repo.registerUser({
        user: { id: 'u_c3', email: 'c3@example.com', passwordHash: 'h', fullName: 'C3 User' },
        workspace: { id: 'ws_c3', name: 'Workspace C3', slug: 'ws-c3' },
        session: {
          id: 'sess_c3',
          sessionTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          userId: 'u_c3',
          activeWorkspaceId: 'ws_c3',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      const existingStore = (await repo.getStoreByWorkspace('ws_c3'))!;
      await repo.saveStoreProfile('ws_c3', { ...existingStore, tier: 'Growth', skuLimit: 2500 });

      const app = createApp(repo);
      const { baseUrl, close } = await startTempServer(app);
      try {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };

        // Initial migrate with expectedVersion=1 -> succeeds and bumps catalogVersion to 2
        const r1 = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedVersion: 1 }),
        });
        assert.equal(r1.status, 200);
        const j1 = await r1.json();
        assert.equal(j1.catalogVersion, 2);

        // Stale client still holding expectedVersion=1 -> MUST reject 409 without overwriting
        const rConflict = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedVersion: 1 }),
        });
        assert.equal(rConflict.status, 409);
        const jConflict = await rConflict.json();
        assert.equal(jConflict.code, 'CATALOG_VERSION_CONFLICT');
        assert.equal(jConflict.currentVersion, 2);
      } finally {
        await close();
      }
    });
  });

  // =========================================================================
  // WORKSTREAMS H, I, K — SSR Rendering Truthfulness & Pricing Verification
  // =========================================================================
  describe('Workstreams H, I, K: UI Pricing Accuracy, Scope Boundaries & Copy Consistency', () => {
    test('UI1. LandingPage SSR markup shows $149 Growth pricing, zero $179/Woo/100%, and Workstream K-A approved copy', () => {
      const mockApp = buildMockAppContext({ isCloudWorkspace: false });
      const html = renderToStaticMarkup(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: null,
              activeWorkspace: null,
              workspaces: [],
              isAuthenticated: false,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: false }),
              register: async () => ({ success: false }),
              logout: async () => {},
              switchWorkspace: async () => false,
            },
          },
          React.createElement(
            AppContext.Provider,
            { value: mockApp },
            React.createElement(LandingPage)
          )
        )
      );

      assert.match(html, /\$149.*\/ month/, 'Growth Tier must show $149 / month matching backend AUTHORITATIVE_PLANS');
      assert.doesNotMatch(html, /\$179/, 'Legacy phantom $179 price must not appear');
      assert.doesNotMatch(html, /Woo/i, 'Unimplemented WooCommerce connector claims must not appear');
      assert.doesNotMatch(html, />100%</, 'Unverified 100% proof strip claim must not appear');
      assert.doesNotMatch(html, /the assistant drops the product/i, 'Removed unverified discovery outcome claim');
      assert.match(
        html,
        /Missing or conflicting product attributes can reduce machine-readable clarity/
      );
      assert.match(
        html,
        /Live write-back to Shopify or external ERPs is not implemented in this version/
      );
      assert.match(html, /Demo Reference Tier/);
      assert.match(html, /On-demand catalog schema audit/);
    });

    test('UI2. SettingsPage SSR across subscription & connectors tabs shows $149 / mo, On-Demand, and Read-Only Shopify copy', () => {
      const mockApp = buildMockAppContext({
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Growth',
          skuLimit: 2500,
        },
      });

      const renderSettingsTab = (tab: 'profile' | 'workspace' | 'connectors' | 'subscription') =>
        renderToStaticMarkup(
          React.createElement(
            AuthContext.Provider,
            {
              value: {
                user: { id: 'u1', email: 'u@example.com', fullName: 'Merchant Admin' },
                activeWorkspace: { id: 'ws1', name: 'Solstice WS', slug: 'solstice-ws', role: 'owner' },
                workspaces: [{ id: 'ws1', name: 'Solstice WS', slug: 'solstice-ws', role: 'owner' }],
                isAuthenticated: true,
                isLoading: false,
                authModalOpen: false,
                authModalMode: 'login',
                openAuthModal: () => {},
                closeAuthModal: () => {},
                login: async () => ({ success: true }),
                register: async () => ({ success: true }),
                logout: async () => {},
                switchWorkspace: async () => true,
              },
            },
            React.createElement(
              AppContext.Provider,
              { value: mockApp },
              React.createElement(SettingsPage, { initialTab: tab })
            )
          )
        );

      const profileHtml = renderSettingsTab('profile');
      assert.match(profileHtml, /Store &amp; Catalog Configuration/);

      const subscriptionHtml = renderSettingsTab('subscription');
      assert.match(subscriptionHtml, /\$149 \/ mo/, 'Subscription Growth price must show $149 / mo');
      assert.doesNotMatch(subscriptionHtml, /\$179/, 'Subscription tab must not show $179');
      assert.match(subscriptionHtml, /On-Demand/);
      assert.doesNotMatch(subscriptionHtml, /Manual Only/);
      assert.match(subscriptionHtml, /STRIPE_SECRET_KEY/);

      const connectorsHtml = renderSettingsTab('connectors');
      assert.match(connectorsHtml, /Read-only Shopify catalog synchronization/);
      assert.doesNotMatch(connectorsHtml, /bidirectional/i);
    });
  });
});
