import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { runMigrations, checkMigrationStatus } from './migrate';

interface TrackedClientRecord {
  id: number;
  queries: string[];
  releaseCalls: Array<boolean | Error | undefined>;
  normalReleaseCount: number;
  destroyCount: number;
  wasReturnedToPool: boolean;
}

function createFailureInjectablePool(options: {
  connectHandler?: (attempt: number) => Promise<{
    rejectUnlock?: boolean;
    unlockFalse?: boolean;
    failOnSql?: (sql: string) => Error | null;
    throwOnRelease?: Error;
    alreadyApplied?: string[];
  }>;
  rejectUnlock?: boolean;
  unlockFalse?: boolean;
  failOnSql?: (sql: string, clientId: number) => Error | null;
  throwOnRelease?: Error;
  alreadyApplied?: Array<{ id: string; checksum: string | null }>;
} = {}) {
  let nextClientId = 1;
  let connectCount = 0;
  let endCalled = 0;
  const idleQueue: any[] = [];
  const clientRecords: TrackedClientRecord[] = [];
  const appliedStore = new Map<string, string | null>(
    (options.alreadyApplied || []).map(r => [r.id, r.checksum])
  );

  const pool = {
    connect: async () => {
      connectCount += 1;
      if (idleQueue.length > 0) {
        return idleQueue.shift();
      }

      const behavior = options.connectHandler ? await options.connectHandler(connectCount) : {};
      const clientId = nextClientId++;
      const record: TrackedClientRecord = {
        id: clientId,
        queries: [],
        releaseCalls: [],
        normalReleaseCount: 0,
        destroyCount: 0,
        wasReturnedToPool: false,
      };
      clientRecords.push(record);

      let finalized = false;

      const client = {
        query: async (sql: string, params?: any[]) => {
          const trimmed = sql.trim();
          record.queries.push(trimmed);

          if (trimmed.includes('SELECT pg_advisory_unlock')) {
            if (behavior.rejectUnlock ?? options.rejectUnlock) {
              throw new Error('pg_advisory_unlock RPC failed: socket closed');
            }
            if (behavior.unlockFalse ?? options.unlockFalse) {
              return { rows: [{ pg_advisory_unlock: false }] };
            }
            return { rows: [{ pg_advisory_unlock: true }] };
          }

          if (behavior.failOnSql) {
            const err = behavior.failOnSql(trimmed);
            if (err) throw err;
          }
          if (options.failOnSql) {
            const err = options.failOnSql(trimmed, clientId);
            if (err) throw err;
          }

          if (trimmed.includes('SELECT id, checksum FROM schema_migrations')) {
            return {
              rows: Array.from(appliedStore.entries()).map(([id, checksum]) => ({ id, checksum })),
            };
          }
          if (trimmed.startsWith('INSERT INTO schema_migrations')) {
            if (params && params[0]) {
              appliedStore.set(String(params[0]), params[1] ? String(params[1]) : null);
            }
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: (destroyOrErr?: boolean | Error) => {
          record.releaseCalls.push(destroyOrErr);
          if (finalized) {
            throw new Error(`Double release detected on client #${clientId}`);
          }
          finalized = true;

          const shouldDestroy = destroyOrErr === true || destroyOrErr instanceof Error;
          if (shouldDestroy) {
            record.destroyCount += 1;
          } else {
            record.normalReleaseCount += 1;
            record.wasReturnedToPool = true;
            idleQueue.push(client);
          }

          const relErr = behavior.throwOnRelease ?? options.throwOnRelease;
          if (relErr) {
            throw relErr;
          }
        },
      };

      return client;
    },
    end: async () => {
      endCalled += 1;
    },
  };

  return {
    pool: pool as unknown as Pool,
    clientRecords,
    idleQueue,
    getConnectCount: () => connectCount,
    getEndCalled: () => endCalled,
    getAppliedIds: () => Array.from(appliedStore.keys()),
  };
}

describe('Migration Runner Connection Safety & Poisoned Client Cleanup', () => {
  let tempDirs: string[] = [];

  function createTempMigrations(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aixshop-migrate-test-'));
    tempDirs.push(dir);
    for (const [name, sql] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), sql, 'utf-8');
    }
    return dir;
  }

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('1. Successful migration: advisory lock & unlock succeed, client released normally (not destroyed)', async () => {
    const dir = createTempMigrations({
      '001_init.sql': 'CREATE TABLE test_items (id TEXT PRIMARY KEY);',
    });
    const rig = createFailureInjectablePool();

    const result = await runMigrations(rig.pool, { migrationsDir: dir });

    assert.deepEqual(result.applied, ['001_init.sql']);
    assert.equal(rig.clientRecords.length, 1);
    const c = rig.clientRecords[0];
    assert.equal(c.normalReleaseCount, 1);
    assert.equal(c.destroyCount, 0);
    assert.equal(c.wasReturnedToPool, true);
    assert.ok(c.queries.some(q => q.includes('SELECT pg_advisory_lock')));
    assert.ok(c.queries.some(q => q.includes('BEGIN')));
    assert.ok(c.queries.some(q => q.includes('COMMIT')));
    assert.ok(c.queries.some(q => q.includes('SELECT pg_advisory_unlock')));
    assert.equal(rig.getEndCalled(), 0);
  });

  test('2. Migration execution failure with successful ROLLBACK & unlock: propagates error and releases safely', async () => {
    const dir = createTempMigrations({
      '001_fail.sql': 'CREATE TABLE bad_syntax (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE bad_syntax')) {
          return new Error('relation "bad_syntax" syntax error');
        }
        return null;
      },
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /bad_syntax/);
        assert.equal(err.cleanupErrors, undefined);
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.ok(c.queries.some(q => q === 'ROLLBACK'));
    assert.ok(c.queries.some(q => q.includes('SELECT pg_advisory_unlock')));
    assert.equal(c.normalReleaseCount, 1, 'Cleanly rolled back & unlocked client is safe to return');
    assert.equal(c.destroyCount, 0);
  });

  test('3. Migration execution failure with ROLLBACK failure: destroys poisoned client and preserves primary + rollback error', async () => {
    const dir = createTempMigrations({
      '001_fail.sql': 'CREATE TABLE t_broken (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE t_broken')) {
          return new Error('Primary SQL error: invalid constraint');
        }
        if (sql === 'ROLLBACK') {
          return new Error('ROLLBACK failed: connection reset by peer');
        }
        return null;
      },
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /Primary SQL error: invalid constraint/);
        assert.ok(err.rollbackError instanceof Error);
        assert.match(err.rollbackError.message, /ROLLBACK failed/);
        assert.ok(Array.isArray(err.cleanupErrors));
        assert.equal(err.cleanupErrors[0].phase, 'rollback');
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.equal(c.normalReleaseCount, 0, 'Must NEVER normally release client after ROLLBACK failure');
    assert.equal(c.destroyCount, 1, 'Must destroy client via release(true)');
    assert.equal(c.wasReturnedToPool, false);
  });

  test('3b. BEGIN transaction failure: destroys poisoned client instead of returning uncertain connection', async () => {
    const dir = createTempMigrations({
      '001_begin_fail.sql': 'CREATE TABLE t_ok (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      failOnSql: (sql) => (sql === 'BEGIN' ? new Error('BEGIN aborted: server shutting down') : null),
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /BEGIN aborted/);
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.equal(c.normalReleaseCount, 0);
    assert.equal(c.destroyCount, 1);
  });

  test('4. Advisory-lock acquisition query failure: destroys client, does not attempt unlock, propagates original error', async () => {
    const dir = createTempMigrations({
      '001_init.sql': 'CREATE TABLE t_ok (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      failOnSql: (sql) =>
        sql.includes('SELECT pg_advisory_lock')
          ? new Error('pg_advisory_lock timeout: lock state uncertain')
          : null,
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /pg_advisory_lock timeout/);
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.ok(!c.queries.some(q => q.includes('SELECT pg_advisory_unlock')));
    assert.equal(c.normalReleaseCount, 0, 'Must destroy client when lock acquisition fails with uncertain lock state');
    assert.equal(c.destroyCount, 1);
  });

  test('5. Advisory-unlock query failure (thrown error and false return): destroys poisoned client cleanly', async () => {
    const dir = createTempMigrations({
      '001_init.sql': 'CREATE TABLE t_ok (id TEXT);',
    });

    // 5a: pg_advisory_unlock rejects
    const rigThrow = createFailureInjectablePool({ rejectUnlock: true });
    const res1 = await runMigrations(rigThrow.pool, { migrationsDir: dir });
    assert.deepEqual(res1.applied, ['001_init.sql']);
    assert.equal(rigThrow.clientRecords[0].normalReleaseCount, 0);
    assert.equal(rigThrow.clientRecords[0].destroyCount, 1);

    // 5b: pg_advisory_unlock returns false
    const rigFalse = createFailureInjectablePool({ unlockFalse: true });
    const res2 = await runMigrations(rigFalse.pool, { migrationsDir: dir });
    assert.deepEqual(res2.applied, ['001_init.sql']);
    assert.equal(rigFalse.clientRecords[0].normalReleaseCount, 0);
    assert.equal(rigFalse.clientRecords[0].destroyCount, 1);
  });

  test('6. Migration failure followed by unlock failure: keeps primary error, records unlock diagnostic, destroys client once', async () => {
    const dir = createTempMigrations({
      '001_fail.sql': 'CREATE TABLE t_broken (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      rejectUnlock: true,
      failOnSql: (sql) =>
        sql.includes('CREATE TABLE t_broken')
          ? new Error('Primary migration failure: column type mismatch')
          : null,
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /Primary migration failure: column type mismatch/);
        assert.ok(err.unlockError instanceof Error);
        assert.match(err.unlockError.message, /pg_advisory_unlock RPC failed/);
        assert.ok(Array.isArray(err.cleanupErrors));
        assert.equal(err.cleanupErrors.some((e: any) => e.phase === 'unlock'), true);
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.equal(c.normalReleaseCount, 0);
    assert.equal(c.destroyCount, 1);
    assert.equal(c.releaseCalls.length, 1);
  });

  test('7. Connection cleanup idempotency: rollback fail + unlock fail + release throws still calls destroy exactly once and preserves primary error', async () => {
    const dir = createTempMigrations({
      '001_fail.sql': 'CREATE TABLE t_multi_fail (id TEXT);',
    });
    const rig = createFailureInjectablePool({
      rejectUnlock: true,
      throwOnRelease: new Error('Secondary client.release error'),
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE t_multi_fail')) {
          return new Error('Primary DDL failure');
        }
        if (sql === 'ROLLBACK') {
          return new Error('Rollback connection dropped');
        }
        return null;
      },
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.equal(err.message, 'Primary DDL failure');
        assert.equal(err.cleanupErrors.length, 3);
        assert.deepEqual(
          err.cleanupErrors.map((e: any) => e.phase),
          ['rollback', 'unlock', 'release']
        );
        return true;
      }
    );

    const c = rig.clientRecords[0];
    assert.equal(c.releaseCalls.length, 1, 'release() must be called at most once');
    assert.equal(c.destroyCount, 1);
    assert.equal(c.normalReleaseCount, 0);
  });

  test('8. Pool/client acquisition failure: zero client unlock/release/destroy calls and internal pool still ends cleanly', async () => {
    const dir = createTempMigrations({
      '001_init.sql': 'CREATE TABLE t_ok (id TEXT);',
    });
    const acquireErr = new Error('Pool exhausted: connect timeout');
    const rig = createFailureInjectablePool({
      connectHandler: async () => {
        throw acquireErr;
      },
    });

    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.equal(err.message, 'Pool exhausted: connect timeout');
        return true;
      }
    );

    assert.equal(rig.clientRecords.length, 0);
    assert.equal(rig.getEndCalled(), 0, 'Caller-provided pool must not be closed by runner');

    // Internal pool when no customPool provided
    const origUrl = process.env.DATABASE_URL;
    const origConnect = Pool.prototype.connect;
    const origEnd = Pool.prototype.end;
    let internalEndCalls = 0;

    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/testdb';
    Pool.prototype.connect = async function () {
      throw new Error('ECONNREFUSED acquiring pool client');
    };
    Pool.prototype.end = async function () {
      internalEndCalls += 1;
    };

    try {
      await assert.rejects(
        () => runMigrations(undefined, { migrationsDir: dir }),
        (err: any) => {
          assert.match(err.message, /ECONNREFUSED acquiring pool client/);
          return true;
        }
      );
      assert.equal(internalEndCalls, 1);
    } finally {
      Pool.prototype.connect = origConnect;
      Pool.prototype.end = origEnd;
      if (origUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origUrl;
    }
  });

  test('9. Normal sequential migrations: runs 001 -> 002 -> 003 in alphabetical order inside separate transactions', async () => {
    const dir = createTempMigrations({
      '003_third.sql': 'CREATE TABLE step_three (id INT);',
      '001_first.sql': 'CREATE TABLE step_one (id INT);',
      '002_second.sql': 'CREATE TABLE step_two (id INT);',
      'README.txt': 'ignore non-sql file',
    });
    const rig = createFailureInjectablePool();

    const result = await runMigrations(rig.pool, { migrationsDir: dir });

    assert.deepEqual(result.applied, ['001_first.sql', '002_second.sql', '003_third.sql']);
    assert.equal(result.totalMigrations, 3);

    const c = rig.clientRecords[0];
    const executionOrder = c.queries.filter(
      q => q.includes('CREATE TABLE step_') || q === 'BEGIN' || q === 'COMMIT'
    );
    assert.deepEqual(executionOrder, [
      'BEGIN',
      'CREATE TABLE step_one (id INT);',
      'COMMIT',
      'BEGIN',
      'CREATE TABLE step_two (id INT);',
      'COMMIT',
      'BEGIN',
      'CREATE TABLE step_three (id INT);',
      'COMMIT',
    ]);
    assert.equal(c.normalReleaseCount, 1);
    assert.equal(c.destroyCount, 0);
  });

  test('10. Repeated execution after failed run: poisoned client #1 is destroyed & never reused; run #2 uses fresh healthy client #2', async () => {
    const dir = createTempMigrations({
      '001_first.sql': 'CREATE TABLE step_one (id INT);',
      '002_second.sql': 'CREATE TABLE step_two (id INT);',
    });

    const rig = createFailureInjectablePool({
      connectHandler: async (attempt) => {
        if (attempt === 1) {
          return {
            failOnSql: (sql) => {
              if (sql.includes('CREATE TABLE step_two')) {
                return new Error('Temporary failure on step_two');
              }
              if (sql === 'ROLLBACK') {
                return new Error('Connection #1 corrupted during rollback');
              }
              return null;
            },
          };
        }
        return {};
      },
    });

    // Run 1 applies 001_first.sql, then poisons Client #1 on 002_second.sql + ROLLBACK failure
    await assert.rejects(
      () => runMigrations(rig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /Temporary failure on step_two/);
        return true;
      }
    );

    assert.equal(rig.clientRecords.length, 1);
    assert.equal(rig.clientRecords[0].destroyCount, 1);
    assert.equal(rig.clientRecords[0].normalReleaseCount, 0);
    assert.equal(rig.idleQueue.length, 0, 'Poisoned client #1 must NOT be in idle pool');

    // Run 2 acquires fresh Client #2 (never poisoned Client #1) and applies remaining 002_second.sql cleanly
    const run2 = await runMigrations(rig.pool, { migrationsDir: dir });
    assert.deepEqual(run2.alreadyApplied, ['001_first.sql']);
    assert.deepEqual(run2.applied, ['002_second.sql']);

    assert.equal(rig.clientRecords.length, 2);
    assert.equal(rig.clientRecords[1].normalReleaseCount, 1);
    assert.equal(rig.clientRecords[1].destroyCount, 0);
    assert.equal(rig.idleQueue.length, 1);
  });

  test('11. checkMigrationStatus() destroys client on mid-query failure and releases cleanly on success', async () => {
    const dir = createTempMigrations({
      '001_init.sql': 'CREATE TABLE step_one (id INT);',
    });

    const failingRig = createFailureInjectablePool({
      failOnSql: (sql) =>
        sql.includes('information_schema.tables')
          ? new Error('Catalog metadata query error')
          : null,
    });

    await assert.rejects(
      () => checkMigrationStatus(failingRig.pool, { migrationsDir: dir }),
      (err: any) => {
        assert.match(err.message, /Catalog metadata query error/);
        return true;
      }
    );
    assert.equal(failingRig.clientRecords[0].normalReleaseCount, 0);
    assert.equal(failingRig.clientRecords[0].destroyCount, 1);

    const healthyRig = createFailureInjectablePool();
    const status = await checkMigrationStatus(healthyRig.pool, { migrationsDir: dir });
    assert.equal(status.pendingCount, 1);
    assert.equal(healthyRig.clientRecords[0].normalReleaseCount, 1);
    assert.equal(healthyRig.clientRecords[0].destroyCount, 0);
  });
});
