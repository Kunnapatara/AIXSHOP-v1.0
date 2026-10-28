import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { getDatabaseRepository, setDatabaseRepository, getPostgresPoolConfig } from './db/index';
import { runMigrations, checkMigrationStatus } from './db/migrate';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AIXSHOP v1.0 — Production Backend Foundation & Multi-Tenant Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  before(async () => {
    repo = new MemoryRepository(false);
    const app = createApp(repo);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      // Listen on ephemeral port
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // 1. Health & Readiness Probes (Task C & Task D)
  describe('Health Checks & Readiness Probes', () => {
    afterEach(() => {
      // Ensure repo is reset to healthy state after each test
      repo.setConnected(true);
      repo.setSchemaReady(true);
    });

    test('GET /api/health returns service status and database backend', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.database.backend, 'memory');
      assert.equal(data.database.connected, true);
      assert.equal(data.database.schemaReady, true);
    });

    test('GET /api/health/live returns 200 OK even when database is disconnected', async () => {
      repo.setConnected(false);
      const res = await fetch(`${baseUrl}/api/health/live`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.probe, 'liveness');
      assert.ok(data.uptime >= 0);
    });

    test('GET /api/health/ready returns 200 OK when database and schema are ready', async () => {
      const res = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.probe, 'readiness');
      assert.equal(data.database.connected, true);
      assert.equal(data.database.schemaReady, true);
    });

    test('GET /api/health/ready returns 503 Unavailable when database connectivity fails', async () => {
      repo.setConnected(false);
      const res = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.status, 'unavailable');
      assert.equal(data.probe, 'readiness');
      assert.equal(data.database.connected, false);
      assert.match(data.database.reason, /unreachable/i);
    });

    test('GET /api/health/ready returns 503 Unavailable when database schema is not ready', async () => {
      repo.setSchemaReady(false, 'Missing required table: variants');
      const res = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.status, 'unavailable');
      assert.equal(data.database.connected, true);
      assert.equal(data.database.schemaReady, false);
      assert.match(data.database.reason, /Missing required table: variants/i);
    });

    test('GET /api/health?probe=live returns 200 OK regardless of database state', async () => {
      repo.setConnected(false);
      const res = await fetch(`${baseUrl}/api/health?probe=live`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.probe, 'liveness');
    });

    test('GET /api/health returns 503 Unavailable when database is not ready', async () => {
      repo.setConnected(false);
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.status, 'unavailable');
      assert.equal(data.database.connected, false);
    });
  });

  // 2. Authentication & Registration
  describe('Authentication & Session Management', () => {
    test('rejects registration with invalid email', async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'password123',
          fullName: 'Jane Merchant',
          workspaceName: 'Solstice Store',
        }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /email/i);
    });

    test('rejects registration with short password (< 8 chars)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'jane@example.com',
          password: 'short',
          fullName: 'Jane Merchant',
          workspaceName: 'Solstice Store',
        }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /8 characters/i);
    });

    test('registers User A successfully and returns session cookie', async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'user_a@example.com',
          password: 'securePasswordA123',
          fullName: 'Alice Merchant',
          workspaceName: 'Alice Goods',
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.user.email, 'user_a@example.com');
      assert.equal(data.workspace.name, 'Alice Goods');
      assert.equal(data.workspace.role, 'owner');
      assert.ok(data.token);

      const cookieHeader = res.headers.get('set-cookie');
      assert.ok(cookieHeader && cookieHeader.includes('aixshop_session'));
    });

    test('rejects duplicate email registration with 409 Conflict', async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'user_a@example.com',
          password: 'anotherPassword456',
          fullName: 'Imposter Alice',
          workspaceName: 'Fake Alice Store',
        }),
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.match(data.error, /already exists/i);
    });

    test('rejects login with incorrect password', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'user_a@example.com',
          password: 'wrongPassword!',
        }),
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /invalid email or password/i);
    });

    test('rejects login with non-existent email', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'nobody@example.com',
          password: 'securePasswordA123',
        }),
      });
      assert.equal(res.status, 401);
    });

    test('logs in User A with valid credentials and sets session', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'user_a@example.com',
          password: 'securePasswordA123',
        }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.email, 'user_a@example.com');
      assert.ok(data.token);
    });

    test('unauthorized request to protected endpoint returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/catalog`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'UNAUTHORIZED');
    });

    test('request with forged / invalid session token returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/catalog`, {
        headers: {
          Authorization: 'Bearer forged_session_token_1234567890abcdef',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'SESSION_EXPIRED');
    });

    test('logout invalidates session token', async () => {
      // 1. Login to get token
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'user_a@example.com',
          password: 'securePasswordA123',
        }),
      });
      const loginData = await loginRes.json();
      const token = loginData.token;

      // 2. Verify token works
      const meRes1 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(meRes1.status, 200);

      // 3. Logout
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(logoutRes.status, 200);

      // 4. Verify token is now rejected
      const meRes2 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(meRes2.status, 401);
    });
  });

  // 3. Multi-Tenant Isolation & Anti-Cross-Tenant Tampering
  describe('Multi-Tenant Workspace Isolation & Access Prevention', () => {
    let tokenA: string;
    let tokenB: string;
    let workspaceIdA: string;
    let workspaceIdB: string;

    before(async () => {
      // Register User A
      const resA = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'tenant_a@example.com',
          password: 'passwordTenantA1',
          fullName: 'Alice Tenant',
          workspaceName: 'Tenant A Workspace',
        }),
      });
      const dataA = await resA.json();
      tokenA = dataA.token;
      workspaceIdA = dataA.workspace.id;

      // Populate Workspace A with a product and an action
      await repo.saveWorkspaceCatalog(workspaceIdA, {
        products: [
          {
            id: 'prod_a_01',
            title: 'Tenant A Artisan Apron',
            brand: 'Brand A',
            category: 'Kitchen',
            description: 'Original apron',
            image: '',
            status: 'active',
            completenessScore: 80,
            evidenceCoverageScore: 70,
            externalDiscoveryStatus: 'observed_in_sample',
            attributes: {},
            variants: [
              {
                id: 'var_a_01',
                sku: 'SKU-A-01',
                title: 'Standard',
                barcode: '0850029381089',
                price: 45.0,
                attributes: {},
              },
            ],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 1,
            lastAudited: '2026-10-17',
          },
        ],
        variants: [],
        offers: [],
        findings: [],
        actions: [
          {
            id: 'act_a_01',
            findingId: 'find_a_01',
            productId: 'prod_a_01',
            title: 'Update price to 49.99',
            severity: 'medium',
            status: 'pending_review',
            verificationStatus: 'unverified',
            evidenceRequired: false,
            proposedChange: {
              field: 'variants[0].price',
              from: '45.00',
              to: '49.99',
            },
            auditLog: [],
          },
        ],
        evidence: [],
        storeProfile: {
          name: 'Tenant A Store',
          domain: 'tenant-a.myshopify.com',
          currency: 'USD',
          skuCount: 1,
          catalogCompletenessAvg: 80,
          truthBoundaryStrictness: 'standard',
          tier: 'Free Audit',
          connectors: [],
        },
      });

      // Register User B
      const resB = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'tenant_b@example.com',
          password: 'passwordTenantB1',
          fullName: 'Bob Tenant',
          workspaceName: 'Tenant B Workspace',
        }),
      });
      const dataB = await resB.json();
      tokenB = dataB.token;
      workspaceIdB = dataB.workspace.id;
    });

    test('User B cannot see User A products in GET /api/catalog', async () => {
      const res = await fetch(`${baseUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${tokenB}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.workspaceId, workspaceIdB);
      // Workspace B must have its own empty/isolated products, never User A products
      assert.equal(data.catalog.products.length, 0);
      assert.equal(data.catalog.products.some((p: any) => p.id === 'prod_a_01'), false);
    });

    test('User B attempting to approve User A action is rejected with 404 (anti-cross-tenant)', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/actions/act_a_01/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ACTION_NOT_FOUND');

      // Verify User A action was NOT mutated
      const catA = await repo.loadWorkspaceCatalog(workspaceIdA);
      const actionA = catA?.actions.find((a) => a.id === 'act_a_01');
      assert.equal(actionA?.status, 'pending_review');
    });

    test('User B attempting to dismiss User A action is rejected with 404', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/actions/act_a_01/dismiss`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(res.status, 404);
    });

    test('User B attempting to switch to Workspace A without membership returns 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/auth/switch-workspace`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ workspaceId: workspaceIdA }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /access denied/i);
    });

    test('User A can successfully approve action in their own workspace with two-decimal precision', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/actions/act_a_01/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.action.status, 'approved');
      assert.equal(data.product.variants[0].price, 49.99);

      // Verify persistence in repository
      const catA = await repo.loadWorkspaceCatalog(workspaceIdA);
      const actionA = catA?.actions.find((a) => a.id === 'act_a_01');
      assert.equal(actionA?.status, 'approved');
      const varA = catA?.products[0].variants[0];
      assert.equal(varA?.price, 49.99);
    });

    test('User B attempting to recheck User A action is rejected with 404 (anti-cross-tenant)', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/actions/act_a_01/recheck`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'ACTION_NOT_FOUND');
    });

    test('User B sending payload with workspaceId of User A in PUT /api/catalog does NOT overwrite User A', async () => {
      const res = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            workspaceId: workspaceIdA, // Malicious spoofing attempt
            storeId: `store_${workspaceIdA}`,
            products: [
              {
                id: 'prod_malicious',
                title: 'Malicious Injected Product',
                brand: 'Hacker',
                category: 'Spoofed',
                description: 'Attempt to pollute Tenant A',
                image: '',
                status: 'active',
                completenessScore: 10,
                evidenceCoverageScore: 10,
                externalDiscoveryStatus: 'unindexed',
                attributes: {},
                variants: [],
                offers: [],
                evidenceDocuments: [],
                findingsCount: 0,
                lastAudited: '2026-10-20',
              },
            ],
            variants: [],
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: {
              name: 'Spoofed Store',
              domain: 'spoofed.myshopify.com',
              currency: 'USD',
              skuCount: 1,
              catalogCompletenessAvg: 10,
              truthBoundaryStrictness: 'standard',
              tier: 'Free Audit',
              connectors: [],
            },
          },
        }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.workspaceId, workspaceIdB, 'Server must enforce session workspaceId, ignoring body workspaceId');

      // Verify User A data is untouched and unaffected
      const catA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catA?.products.some(p => p.id === 'prod_malicious'), false, 'User A catalog must not be polluted');

      // Verify User B data was saved under User B workspace
      const catB = await repo.loadWorkspaceCatalog(workspaceIdB);
      assert.equal(catB?.products.some(p => p.id === 'prod_malicious'), true, 'Saved under User B workspace');
    });

    test('User B importing catalog cannot affect or pollute User A workspace', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            {
              id: 'imported_b_01',
              title: 'User B Imported Item',
              brand: 'Brand B',
              category: 'Import',
              variants: [{ sku: 'SKU-B-IMP', price: 29.99 }],
            },
          ],
        }),
      });
      assert.equal(res.status, 200);

      const catA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catA?.products.some(p => p.id === 'imported_b_01'), false, 'User A catalog remains isolated');
    });
  });

  // 4. Invalid Request Payloads & Atomic Rollback
  describe('Payload Validation & Rollback Integrity', () => {
    let token: string;

    before(async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          email: 'validation_tester@example.com',
          password: 'passwordVal123',
          fullName: 'Val Tester',
          workspaceName: 'Validation Workspace',
        }),
      });
      const data = await res.json();
      token = data.token;
    });

    test('rejects PUT /api/catalog with malformed payload (not array)', async () => {
      const res = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ payload: 'invalid-non-object' }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid catalog payload/i);
    });

    test('rejects store profile update with empty store name', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ name: '   ' }),
      });
      assert.equal(res.status, 400);
    });

    test('honest connector toggle preserves disconnected state without simulating connection', async () => {
      const res = await fetch(`${baseUrl}/api/store/connectors/shopify_primary/toggle`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const connector = data.store.connectors.find((c: any) => c.id === 'shopify_primary');
      assert.ok(connector);
      // Must NOT claim connected
      assert.equal(connector.status, 'not_configured');
    });

    test('demo migration endpoint populates active workspace catalog cleanly', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.skuCount > 0);

      // Verify workspace catalog now contains imported products
      const catRes = await fetch(`${baseUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const catData = await catRes.json();
      assert.ok(catData.catalog.products.length > 0);
    });
  });

  // 5. Production Startup Configuration & Safety Rules
  describe('Production Startup Configuration & Safety Rules', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore environment and database repository state
      process.env = { ...originalEnv };
      setDatabaseRepository(null);
    });

    test('production environment strictly fails startup when PostgreSQL config is missing', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;
      delete process.env.PGHOST;
      setDatabaseRepository(null);

      assert.throws(
        () => {
          getDatabaseRepository();
        },
        (err: any) => {
          assert.match(err.message, /\[AIXSHOP Fatal Startup Error\]/i);
          assert.match(err.message, /NODE_ENV=production/i);
          assert.match(err.message, /strictly prohibited in production/i);
          return true;
        }
      );
    });

    test('development environment safely falls back to MemoryRepository when PostgreSQL is unconfigured', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;
      delete process.env.PGHOST;
      setDatabaseRepository(null);

      const devRepo = getDatabaseRepository();
      assert.equal(devRepo.getBackendType(), 'memory');
    });

    test('DATABASE_URL takes precedence over discrete SQL_* and PG* variables', () => {
      process.env.DATABASE_URL = 'postgresql://primary_user:secret_url_pass@url-host.internal:5432/primary_db';
      process.env.SQL_HOST = 'sql-host.internal';
      process.env.SQL_USER = 'sql_user';
      process.env.SQL_DB_NAME = 'sql_db';
      process.env.PGHOST = 'pg-host.internal';

      const poolConfig = getPostgresPoolConfig();
      assert.ok(poolConfig);
      assert.equal((poolConfig as any).connectionString, 'postgresql://primary_user:secret_url_pass@url-host.internal:5432/primary_db');
      assert.equal((poolConfig as any).host, undefined);
    });

    test('SQL_* variables take precedence over fallback PG* variables', () => {
      delete process.env.DATABASE_URL;
      process.env.SQL_HOST = 'sql-host.internal';
      process.env.SQL_PORT = '5433';
      process.env.SQL_USER = 'sql_user';
      process.env.SQL_PASSWORD = 'sql_password';
      process.env.SQL_DB_NAME = 'sql_db';

      process.env.PGHOST = 'pg-host.internal';
      process.env.PGPORT = '5434';
      process.env.PGUSER = 'pg_user';
      process.env.PGPASSWORD = 'pg_password';
      process.env.PGDATABASE = 'pg_db';

      const poolConfig = getPostgresPoolConfig();
      assert.ok(poolConfig);
      assert.equal((poolConfig as any).host, 'sql-host.internal');
      assert.equal((poolConfig as any).port, 5433);
      assert.equal((poolConfig as any).user, 'sql_user');
      assert.equal((poolConfig as any).database, 'sql_db');
    });

    test('PG* variables work as fallback when SQL_* are not defined', () => {
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;
      delete process.env.SQL_PORT;
      delete process.env.SQL_USER;
      delete process.env.SQL_PASSWORD;
      delete process.env.SQL_DB_NAME;

      process.env.PGHOST = 'pg-host.internal';
      process.env.PGPORT = '5432';
      process.env.PGUSER = 'pg_user';
      process.env.PGPASSWORD = 'pg_password';
      process.env.PGDATABASE = 'pg_db';

      const poolConfig = getPostgresPoolConfig();
      assert.ok(poolConfig);
      assert.equal((poolConfig as any).host, 'pg-host.internal');
      assert.equal((poolConfig as any).user, 'pg_user');
      assert.equal((poolConfig as any).database, 'pg_db');
    });

    test('throws configuration error without secrets when database name is missing', () => {
      delete process.env.DATABASE_URL;
      process.env.SQL_HOST = 'sql-host.internal';
      process.env.SQL_USER = 'sql_user';
      process.env.SQL_PASSWORD = 'super_secret_db_pass';
      delete process.env.SQL_DB_NAME;
      delete process.env.PGDATABASE;

      assert.throws(
        () => {
          getPostgresPoolConfig();
        },
        (err: any) => {
          assert.match(err.message, /\[AIXSHOP Configuration Error\]/i);
          assert.match(err.message, /Database name is missing/i);
          // Crucial: Must never leak password or connection secret
          assert.doesNotMatch(err.message, /super_secret_db_pass/);
          return true;
        }
      );
    });

    test('throws configuration error without secrets when user is missing', () => {
      delete process.env.DATABASE_URL;
      process.env.SQL_HOST = 'sql-host.internal';
      delete process.env.SQL_USER;
      delete process.env.PGUSER;
      process.env.SQL_PASSWORD = 'super_secret_db_pass';
      process.env.SQL_DB_NAME = 'sql_db';

      assert.throws(
        () => {
          getPostgresPoolConfig();
        },
        (err: any) => {
          assert.match(err.message, /\[AIXSHOP Configuration Error\]/i);
          assert.match(err.message, /Database user is missing/i);
          assert.doesNotMatch(err.message, /super_secret_db_pass/);
          return true;
        }
      );
    });

    test('throws configuration error when port is invalid integer', () => {
      delete process.env.DATABASE_URL;
      process.env.SQL_HOST = 'sql-host.internal';
      process.env.SQL_USER = 'sql_user';
      process.env.SQL_DB_NAME = 'sql_db';
      process.env.SQL_PORT = 'invalid_port';

      assert.throws(
        () => {
          getPostgresPoolConfig();
        },
        (err: any) => {
          assert.match(err.message, /\[AIXSHOP Configuration Error\]/i);
          assert.match(err.message, /Invalid database port/i);
          return true;
        }
      );
    });

    test('PostgreSQL pool configuration parses SSL securely without disabling verification indiscriminately', () => {
      process.env.SQL_HOST = 'db.internal.example.com';
      process.env.SQL_PORT = '5432';
      process.env.SQL_USER = 'app_user';
      process.env.SQL_PASSWORD = 'secret_password';
      process.env.SQL_DB_NAME = 'aixshop_db';
      process.env.DATABASE_SSL = 'true';
      delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;

      const poolConfig = getPostgresPoolConfig();
      assert.ok(poolConfig);
      assert.equal((poolConfig as any).host, 'db.internal.example.com');
      // Must enforce certificate verification by default
      assert.deepEqual((poolConfig as any).ssl, { rejectUnauthorized: true });

      // Only allows relaxed verification when explicitly requested by operator
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
      const relaxedConfig = getPostgresPoolConfig();
      assert.deepEqual((relaxedConfig as any).ssl, { rejectUnauthorized: false });
    });
  });

  // 6. Database Migration Runner & Schema Integrity
  describe('Database Migration Runner & Schema Integrity', () => {
    test('runMigrations fails clearly when no PostgreSQL configuration exists', async () => {
      const originalUrl = process.env.DATABASE_URL;
      const originalHost = process.env.SQL_HOST;
      const originalPgHost = process.env.PGHOST;
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;
      delete process.env.PGHOST;

      try {
        await assert.rejects(
          async () => {
            await runMigrations();
          },
          (err: any) => {
            assert.match(err.message, /\[AIXSHOP Migration Error\]/i);
            assert.match(err.message, /DATABASE_URL, SQL_HOST, or PGHOST/i);
            return true;
          }
        );
      } finally {
        if (originalUrl) process.env.DATABASE_URL = originalUrl;
        if (originalHost) process.env.SQL_HOST = originalHost;
        if (originalPgHost) process.env.PGHOST = originalPgHost;
      }
    });

    test('checkMigrationStatus fails clearly when no PostgreSQL configuration exists', async () => {
      const { checkMigrationStatus } = await import('./db/migrate');
      const originalUrl = process.env.DATABASE_URL;
      const originalHost = process.env.SQL_HOST;
      const originalPgHost = process.env.PGHOST;
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;
      delete process.env.PGHOST;

      try {
        await assert.rejects(
          async () => {
            await checkMigrationStatus();
          },
          (err: any) => {
            assert.match(err.message, /\[AIXSHOP Migration Error\]/i);
            assert.match(err.message, /DATABASE_URL, SQL_HOST, or PGHOST/i);
            return true;
          }
        );
      } finally {
        if (originalUrl) process.env.DATABASE_URL = originalUrl;
        if (originalHost) process.env.SQL_HOST = originalHost;
        if (originalPgHost) process.env.PGHOST = originalPgHost;
      }
    });

    test('001_initial_schema.sql exists and contains valid multi-tenant DDL and table definitions', () => {
      const migrationPath = path.resolve(process.cwd(), 'src/server/db/migrations/001_initial_schema.sql');
      assert.equal(fs.existsSync(migrationPath), true, '001_initial_schema.sql must exist');

      const sqlContent = fs.readFileSync(migrationPath, 'utf-8');
      // Must contain non-destructive DDL
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS users/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workspaces/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workspace_memberships/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS sessions/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS stores/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS products/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS variants/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS offers/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS evidence_documents/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS findings/i);
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS action_items/i);
      // Strict 2-decimal monetary precision
      assert.match(sqlContent, /NUMERIC\(14,\s*2\)/i);
      // No destructive DROP TABLE commands
      assert.doesNotMatch(sqlContent, /DROP TABLE/i);
    });

    test('002_tenant_referential_integrity.sql exists and contains composite foreign key constraints across stores, products, findings, and actions', () => {
      const migrationPath = path.resolve(process.cwd(), 'src/server/db/migrations/002_tenant_referential_integrity.sql');
      assert.equal(fs.existsSync(migrationPath), true, '002_tenant_referential_integrity.sql must exist');

      const sqlContent = fs.readFileSync(migrationPath, 'utf-8');
      // Must contain candidate key on stores
      assert.match(sqlContent, /uq_stores_workspace_id\s+UNIQUE\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on products -> stores
      assert.match(sqlContent, /fk_products_store_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*store_id\)[\s\S]*?REFERENCES stores\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on findings -> stores
      assert.match(sqlContent, /fk_findings_store_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*store_id\)[\s\S]*?REFERENCES stores\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on findings -> products
      assert.match(sqlContent, /fk_findings_product_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*product_id\)[\s\S]*?REFERENCES products\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on action_items -> stores
      assert.match(sqlContent, /fk_action_items_store_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*store_id\)[\s\S]*?REFERENCES stores\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on action_items -> findings
      assert.match(sqlContent, /fk_action_items_finding_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*finding_id\)[\s\S]*?REFERENCES findings\s*\(workspace_id,\s*id\)/i);
      // Must contain composite foreign key on action_items -> products
      assert.match(sqlContent, /fk_action_items_product_workspace[\s\S]*?FOREIGN KEY\s*\(workspace_id,\s*product_id\)[\s\S]*?REFERENCES products\s*\(workspace_id,\s*id\)/i);
      // Non-destructive: no DROP TABLE or TRUNCATE
      assert.doesNotMatch(sqlContent, /DROP TABLE/i);
      assert.doesNotMatch(sqlContent, /TRUNCATE/i);
    });
  });

  // 7. Migration Runner Resource Cleanup & Error Handling (Task 1 & Task 4)
  describe('Migration Runner Resource Cleanup & Error Handling', () => {
    function createMockPool(options: {
      connectReject?: Error;
      queryHandler?: (sql: string, params?: any[]) => Promise<any>;
      clientQueryRejectOn?: (sql: string) => Error | null;
      unlockReject?: boolean;
    }) {
      let endCalled = false;
      let releaseCalled = false;
      const executedQueries: string[] = [];

      const mockClient = {
        query: async (sql: string, params?: any[]) => {
          executedQueries.push(sql.trim());
          if (options.unlockReject && sql.includes('SELECT pg_advisory_unlock')) {
            throw new Error('Database connection terminated while unlocking');
          }
          if (options.clientQueryRejectOn) {
            const err = options.clientQueryRejectOn(sql);
            if (err) throw err;
          }
          if (options.queryHandler) {
            return options.queryHandler(sql, params);
          }
          if (sql.includes('SELECT pg_advisory_lock')) return { rows: [] };
          if (sql.includes('SELECT pg_advisory_unlock')) return { rows: [] };
          if (sql.includes('SELECT id FROM schema_migrations')) return { rows: [] };
          if (sql.includes('CREATE TABLE')) return { rows: [] };
          if (sql.includes('INSERT INTO schema_migrations')) return { rows: [] };
          if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return { rows: [] };
          return { rows: [], rowCount: 1 };
        },
        release: () => {
          releaseCalled = true;
        },
      };

      const mockPool = {
        connect: async () => {
          if (options.connectReject) throw options.connectReject;
          return mockClient;
        },
        end: async () => {
          endCalled = true;
        },
        query: async (sql: string, params?: any[]) => {
          return mockClient.query(sql, params);
        },
      };

      return {
        pool: mockPool as unknown as Pool,
        mockClient,
        getEndCalled: () => endCalled,
        getReleaseCalled: () => releaseCalled,
        getExecutedQueries: () => executedQueries,
      };
    }

    test('1. custom pool: pool.connect() rejects: preserves original error and does not close custom pool', async () => {
      const { pool, getEndCalled } = createMockPool({
        connectReject: new Error('ECONNREFUSED 127.0.0.1:5432 - Connection refused'),
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /ECONNREFUSED/);
          return true;
        }
      );
      // Custom pool must NOT be closed by runner
      assert.equal(getEndCalled(), false);
    });

    test('1b. internally created pool: pool.connect() rejects: calls pool.end() and preserves original error', async () => {
      process.env.DATABASE_URL = 'postgresql://mock_user:mock_pass@127.0.0.1:5432/mock_db';
      let internalPoolEndCalled = false;
      const originalConnect = Pool.prototype.connect;
      const originalEnd = Pool.prototype.end;

      Pool.prototype.connect = async function () {
        throw new Error('Connection refused on internal pool');
      };
      Pool.prototype.end = async function () {
        internalPoolEndCalled = true;
      };

      try {
        await assert.rejects(
          async () => {
            await runMigrations();
          },
          (err: any) => {
            assert.match(err.message, /Connection refused on internal pool/);
            return true;
          }
        );
        assert.equal(internalPoolEndCalled, true, 'Internally created pool must be closed via pool.end()');
      } finally {
        Pool.prototype.connect = originalConnect;
        Pool.prototype.end = originalEnd;
        delete process.env.DATABASE_URL;
      }
    });

    test('2. SQL migration failure triggers ROLLBACK, advisory unlock, and releases client', async () => {
      const { pool, getReleaseCalled, getExecutedQueries, getEndCalled } = createMockPool({
        clientQueryRejectOn: (sql) => {
          if (sql.includes('CREATE TABLE IF NOT EXISTS users')) {
            return new Error('syntax error at or near "MISTAKE"');
          }
          return null;
        },
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /syntax error/);
          return true;
        }
      );

      const queries = getExecutedQueries();
      assert.ok(queries.some((q) => q.includes('ROLLBACK')), 'Must issue ROLLBACK on migration failure');
      assert.ok(queries.some((q) => q.includes('SELECT pg_advisory_unlock')), 'Must release advisory lock in finally');
      assert.equal(getReleaseCalled(), true, 'Must release client back to pool');
      assert.equal(getEndCalled(), false, 'Must not close caller pool');
    });

    test('3. COMMIT failure triggers ROLLBACK attempt without masking original error', async () => {
      const { pool, getReleaseCalled, getExecutedQueries } = createMockPool({
        clientQueryRejectOn: (sql) => {
          if (sql === 'COMMIT') {
            return new Error('Transaction serialization conflict on COMMIT');
          }
          return null;
        },
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /serialization conflict/);
          return true;
        }
      );

      const queries = getExecutedQueries();
      assert.ok(queries.some((q) => q.includes('ROLLBACK')), 'Must attempt ROLLBACK on COMMIT failure');
      assert.ok(queries.some((q) => q.includes('SELECT pg_advisory_unlock')), 'Must unlock advisory lock');
      assert.equal(getReleaseCalled(), true);
    });

    test('4. Advisory lock unlock failure does not mask original migration error', async () => {
      const { pool, getReleaseCalled } = createMockPool({
        unlockReject: true,
        clientQueryRejectOn: (sql) => {
          if (sql.includes('CREATE TABLE IF NOT EXISTS users')) {
            return new Error('Primary database disk full');
          }
          return null;
        },
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /Primary database disk full/);
          return true;
        }
      );

      assert.equal(getReleaseCalled(), true, 'Must release client despite unlock failure');
    });

    test('5. Lock not acquired: does not attempt unlock if lock acquisition query fails', async () => {
      const { pool, getReleaseCalled, getExecutedQueries } = createMockPool({
        clientQueryRejectOn: (sql) => {
          if (sql.includes('SELECT pg_advisory_lock')) {
            return new Error('Deadlock detected when acquiring migration lock');
          }
          return null;
        },
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /Deadlock detected/);
          return true;
        }
      );

      const queries = getExecutedQueries();
      assert.ok(!queries.some((q) => q.includes('SELECT pg_advisory_unlock')), 'Must NOT attempt unlock if lock was not acquired');
      assert.equal(getReleaseCalled(), true, 'Must still release client back to pool');
    });

    test('6. Successful migration acquires advisory lock, commits transaction, unlocks, and releases client', async () => {
      const { pool, getReleaseCalled, getExecutedQueries, getEndCalled } = createMockPool({});

      const result = await runMigrations(pool);
      assert.ok(result.totalMigrations > 0);
      assert.ok(result.applied.length > 0);

      const queries = getExecutedQueries();
      assert.ok(queries.some((q) => q.includes('SELECT pg_advisory_lock')), 'Must acquire advisory lock');
      assert.ok(queries.some((q) => q.includes('BEGIN')), 'Must begin transaction');
      assert.ok(queries.some((q) => q.includes('INSERT INTO schema_migrations')), 'Must record migration');
      assert.ok(queries.some((q) => q.includes('COMMIT')), 'Must commit transaction');
      assert.ok(queries.some((q) => q.includes('SELECT pg_advisory_unlock')), 'Must release advisory lock');
      assert.equal(getReleaseCalled(), true, 'Must release client');
      assert.equal(getEndCalled(), false, 'Must not close caller pool');
    });

    test('7. checkMigrationStatus() is strictly read-only and does not mutate schema', async () => {
      const { checkMigrationStatus } = await import('./db/migrate');
      const { pool, getReleaseCalled, getExecutedQueries, getEndCalled } = createMockPool({
        queryHandler: async (sql) => {
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          if (sql.includes('SELECT id FROM schema_migrations')) {
            return { rows: [{ id: '001_initial_schema.sql' }, { id: '002_tenant_referential_integrity.sql' }, { id: '003_store_sku_limit.sql' }, { id: '004_backfill_store_sku_count.sql' }, { id: '005_billing_subscriptions.sql' }] };
          }
          return { rows: [] };
        },
      });

      const status = await checkMigrationStatus(pool);
      assert.equal(status.isUpToDate, true);
      assert.equal(status.pendingCount, 0);
      assert.equal(status.appliedCount, 5);

      const queries = getExecutedQueries();
      assert.ok(!queries.some((q) => q.includes('BEGIN') || q.includes('INSERT') || q.includes('CREATE')), 'Must be strictly read-only');
      assert.equal(getReleaseCalled(), true);
      assert.equal(getEndCalled(), false);
    });

    test('8. Migration 002 failure on incompatible same-named constraint triggers ROLLBACK and releases client', async () => {
      const { pool, getReleaseCalled, getExecutedQueries, getEndCalled } = createMockPool({
        clientQueryRejectOn: (sql) => {
          if (sql.includes('uq_stores_workspace_id') || sql.includes('002_tenant_referential_integrity')) {
            return new Error('[AIXSHOP Migration 002 Error] Incompatible constraint "uq_stores_workspace_id" already exists (table: public.stores, type: u, columns: {id,workspace_id}). Expected UNIQUE stores(workspace_id, id).');
          }
          return null;
        },
      });

      await assert.rejects(
        async () => {
          await runMigrations(pool);
        },
        (err: any) => {
          assert.match(err.message, /Incompatible constraint "uq_stores_workspace_id"/);
          return true;
        }
      );

      const queries = getExecutedQueries();
      assert.ok(queries.some((q) => q.includes('ROLLBACK')), 'Must issue ROLLBACK on migration failure');
      assert.ok(queries.some((q) => q.includes('SELECT pg_advisory_unlock')), 'Must release advisory lock in finally');
      assert.equal(getReleaseCalled(), true, 'Must release client back to pool');
      assert.equal(getEndCalled(), false, 'Must not close caller pool');
    });
  });

  // 8. PostgreSQL Schema Readiness Accuracy & Constraints (Task 2)
  describe('PostgreSQL Schema Readiness Accuracy & Constraints', () => {
    const ALL_REQUIRED_MIGRATIONS = [
      '001_initial_schema.sql',
      '002_tenant_referential_integrity.sql',
      '003_store_sku_limit.sql',
      '004_backfill_store_sku_count.sql',
      '005_billing_subscriptions.sql',
    ];

    function createMockPostgresPool(options: {
      columnRows: any[];
      fkRows?: any[];
      catalogConstraints?: any[];
      appliedMigrations?: string[];
      missingTable?: boolean;
      queryReject?: Error;
      currentSchema?: string;
    }) {
      let releaseCalled = false;
      const allRequiredTables = [
        'users', 'workspaces', 'workspace_memberships', 'sessions', 'stores',
        'products', 'variants', 'offers', 'evidence_documents', 'findings',
        'action_items', 'schema_migrations', 'subscriptions', 'billing_events',
      ];

      const defaultFkRows = [
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'products',
          source_column: 'workspace_id',
          target_schema: options.currentSchema || 'public',
          target_table: 'workspaces',
          target_column: 'id',
          on_delete: 'CASCADE',
        },
      ];

      const defaultConstraints = [
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'stores',
          target_schema: '',
          target_table: '',
          constraint_name: 'uq_stores_workspace_id',
          constraint_type: 'u',
          source_columns: 'workspace_id,id',
          target_columns: '',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'products',
          target_schema: options.currentSchema || 'public',
          target_table: 'stores',
          constraint_name: 'fk_products_store_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,store_id',
          target_columns: 'workspace_id,id',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'findings',
          target_schema: options.currentSchema || 'public',
          target_table: 'stores',
          constraint_name: 'fk_findings_store_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,store_id',
          target_columns: 'workspace_id,id',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'findings',
          target_schema: options.currentSchema || 'public',
          target_table: 'products',
          constraint_name: 'fk_findings_product_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,product_id',
          target_columns: 'workspace_id,id',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'action_items',
          target_schema: options.currentSchema || 'public',
          target_table: 'stores',
          constraint_name: 'fk_action_items_store_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,store_id',
          target_columns: 'workspace_id,id',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'action_items',
          target_schema: options.currentSchema || 'public',
          target_table: 'findings',
          constraint_name: 'fk_action_items_finding_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,finding_id',
          target_columns: 'workspace_id,id',
        },
        {
          source_schema: options.currentSchema || 'public',
          source_table: 'action_items',
          target_schema: options.currentSchema || 'public',
          target_table: 'products',
          constraint_name: 'fk_action_items_product_workspace',
          constraint_type: 'f',
          source_columns: 'workspace_id,product_id',
          target_columns: 'workspace_id,id',
        },
      ];

      const executedQueries: string[] = [];

      const mockClient = {
        query: async (sql: string) => {
          executedQueries.push(sql);
          if (options.queryReject) {
            throw options.queryReject;
          }
          if (sql.includes('SELECT current_schema()')) {
            return { rows: [{ schema_name: options.currentSchema || 'public' }] };
          }
          if (sql.includes('information_schema.tables')) {
            return {
              rows: (options.missingTable ? allRequiredTables.filter(t => t !== 'variants') : allRequiredTables).map(t => ({ table_name: t })),
            };
          }
          if (sql.includes('information_schema.columns')) {
            return { rows: options.columnRows };
          }
          if (sql.includes('information_schema.table_constraints')) {
            return { rows: options.fkRows !== undefined ? options.fkRows : defaultFkRows };
          }
          if (sql.includes('pg_constraint')) {
            return { rows: options.catalogConstraints !== undefined ? options.catalogConstraints : defaultConstraints };
          }
          if (sql.includes('SELECT id FROM schema_migrations')) {
            return { rows: (options.appliedMigrations || ALL_REQUIRED_MIGRATIONS).map(id => ({ id })) };
          }
          return { rows: [] };
        },
        release: () => {
          releaseCalled = true;
        },
      };

      const mockPool = {
        connect: async () => mockClient,
        end: async () => {},
      };

      return {
        repo: new PostgresRepository(mockPool as unknown as Pool),
        getReleaseCalled: () => releaseCalled,
        getExecutedQueries: () => executedQueries,
      };
    }

    const validColumns = [
      {
        table_name: 'variants',
        column_name: 'price',
        data_type: 'numeric',
        numeric_precision: 14,
        numeric_scale: 2,
        is_nullable: 'YES',
        character_maximum_length: null,
      },
      {
        table_name: 'sessions',
        column_name: 'session_token_hash',
        data_type: 'character varying',
        numeric_precision: null,
        numeric_scale: null,
        is_nullable: 'NO',
        character_maximum_length: 128,
      },
      {
        table_name: 'products',
        column_name: 'workspace_id',
        data_type: 'character varying',
        numeric_precision: null,
        numeric_scale: null,
        is_nullable: 'NO',
        character_maximum_length: 64,
      },
    ];

    test('1. valid schema returns isReady: true with details and releases client', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, true);
      assert.equal(getReleaseCalled(), true);
    });

    test('2. missing required table reports isReady: false with missingTables list', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, missingTable: true });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.ok(res.missingTables?.includes('variants'));
      assert.equal(getReleaseCalled(), true);
    });

    test('3. variants.price with wrong data type (e.g. varchar) reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'price' ? { ...c, data_type: 'character varying' } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /variants\.price has data type "character varying", expected "numeric"/);
      assert.equal(getReleaseCalled(), true);
    });

    test('4. variants.price with wrong precision or scale (e.g. 10, 4) reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'price' ? { ...c, numeric_precision: 10, numeric_scale: 4 } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /NUMERIC\(14, 2\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('5. sessions.session_token_hash nullable reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'session_token_hash' ? { ...c, is_nullable: 'YES' } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /sessions\.session_token_hash must be NOT NULL/);
      assert.equal(getReleaseCalled(), true);
    });

    test('6. sessions.session_token_hash with wrong length (e.g. 64 instead of 128) reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'session_token_hash' ? { ...c, character_maximum_length: 64 } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /sessions\.session_token_hash length is 64, expected VARCHAR\(128\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('7. products.workspace_id nullable reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'workspace_id' ? { ...c, is_nullable: 'YES' } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /products\.workspace_id must be NOT NULL/);
      assert.equal(getReleaseCalled(), true);
    });

    test('8. products.workspace_id with wrong length (e.g. 32 instead of 64) reports schema error', async () => {
      const invalidColumns = validColumns.map(c => c.column_name === 'workspace_id' ? { ...c, character_maximum_length: 32 } : c);
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: invalidColumns });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /products\.workspace_id length is 32, expected VARCHAR\(64\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('9. products.workspace_id missing foreign key constraint reports schema error', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, fkRows: [] });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /products table missing foreign key constraint on workspace_id/);
      assert.equal(getReleaseCalled(), true);
    });

    test('10. products.workspace_id foreign key referencing wrong table (e.g. stores) reports schema error', async () => {
      const wrongFk = [
        {
          source_table: 'products',
          source_column: 'workspace_id',
          target_table: 'stores',
          target_column: 'id',
          on_delete: 'CASCADE',
        },
      ];
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, fkRows: wrongFk });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /foreign key references wrong table "stores", expected "workspaces"/);
      assert.equal(getReleaseCalled(), true);
    });

    test('11. products.workspace_id foreign key referencing wrong column (e.g. slug) reports schema error', async () => {
      const wrongFk = [
        {
          source_table: 'products',
          source_column: 'workspace_id',
          target_table: 'workspaces',
          target_column: 'slug',
          on_delete: 'CASCADE',
        },
      ];
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, fkRows: wrongFk });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /foreign key references wrong column "slug", expected "id"/);
      assert.equal(getReleaseCalled(), true);
    });

    test('12. products.workspace_id foreign key with wrong delete rule (e.g. SET NULL) reports schema error', async () => {
      const wrongFk = [
        {
          source_table: 'products',
          source_column: 'workspace_id',
          target_table: 'workspaces',
          target_column: 'id',
          on_delete: 'SET NULL',
        },
      ];
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, fkRows: wrongFk });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /foreign key delete rule is "SET NULL", expected "CASCADE"/);
      assert.equal(getReleaseCalled(), true);
    });

    test('13. client is released back to pool even when query fails with database exception', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        queryReject: new Error('Postgres connection reset by peer during check'),
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /connection reset by peer/);
      assert.equal(getReleaseCalled(), true, 'Must release client in finally on query failure');
    });

    test('14. error message never exposes database password, session tokens, or secrets', async () => {
      const { repo } = createMockPostgresPool({ columnRows: validColumns, missingTable: true });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.doesNotMatch(res.error!, /password|secret|token/i);
    });

    test('[Mock Unit Test] 15. checkSchemaReadiness fails when 001_initial_schema.sql is recorded but 002_tenant_referential_integrity.sql is pending', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ['001_initial_schema.sql'], // 002, 003, 004, 005 are pending
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.deepEqual(res.pendingMigrations, ['002_tenant_referential_integrity.sql', '003_store_sku_limit.sql', '004_backfill_store_sku_count.sql', '005_billing_subscriptions.sql']);
      assert.match(res.error!, /Required migration "002_tenant_referential_integrity\.sql" has not been applied/);
      assert.equal(getReleaseCalled(), true, 'Must release client back to pool on pending migration');
    });

    test('[Mock Unit Test] 15b. checkSchemaReadiness fails when 004_backfill_store_sku_count.sql is pending', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ['001_initial_schema.sql', '002_tenant_referential_integrity.sql', '003_store_sku_limit.sql'], // 004, 005 are missing/pending
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.deepEqual(res.pendingMigrations, ['004_backfill_store_sku_count.sql', '005_billing_subscriptions.sql']);
      assert.match(res.error!, /Required migration "004_backfill_store_sku_count\.sql" has not been applied/);
      assert.equal(getReleaseCalled(), true, 'Must release client back to pool on pending migration');
    });

    test('[Mock Unit Test] 15c. checkSchemaReadiness fails when 005_billing_subscriptions.sql is pending', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ['001_initial_schema.sql', '002_tenant_referential_integrity.sql', '003_store_sku_limit.sql', '004_backfill_store_sku_count.sql'],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.deepEqual(res.pendingMigrations, ['005_billing_subscriptions.sql']);
      assert.match(res.error!, /Required migration "005_billing_subscriptions\.sql" has not been applied/);
      assert.equal(getReleaseCalled(), true, 'Must release client back to pool on pending migration');
    });

    test('[Mock Unit Test] 16. checkSchemaReadiness fails when both migrations recorded but stores(workspace_id, id) unique key is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          // Missing stores unique constraint
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /stores table missing unique key on \(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 17. checkSchemaReadiness fails when both migrations recorded but composite FK products(workspace_id, store_id) is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          // Missing fk_products_store_workspace
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: products\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 18. checkSchemaReadiness fails when both migrations recorded but composite FK action_items(workspace_id, finding_id) is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'stores',
            constraint_name: 'fk_findings_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'products',
            constraint_name: 'fk_findings_product_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,product_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'action_items',
            target_table: 'stores',
            constraint_name: 'fk_action_items_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          // action_items -> findings missing!
          {
            source_table: 'action_items',
            target_table: 'products',
            constraint_name: 'fk_action_items_product_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,product_id',
            target_columns: 'workspace_id,id',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /action_items\(workspace_id, finding_id\) -> findings\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 19. checkSchemaReadiness succeeds (isReady: true) when all 4 migrations recorded and all composite constraints exist', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, true);
      assert.deepEqual(res.details?.appliedMigrations, ALL_REQUIRED_MIGRATIONS);
      assert.ok(res.details?.verifiedConstraints?.includes('stores(workspace_id, id) UNIQUE'));
      assert.ok(res.details?.verifiedConstraints?.includes('products(workspace_id, store_id) -> stores(workspace_id, id)'));
      assert.ok(res.details?.verifiedConstraints?.includes('action_items(workspace_id, finding_id) -> findings(workspace_id, id)'));
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 20. checkSchemaReadiness strictly scopes all queries to current_schema() without hardcoded public leakage', async () => {
      const { repo, getExecutedQueries } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
      });
      await repo.checkSchemaReadiness();
      const queries = getExecutedQueries();
      assert.ok(queries.length >= 4, 'Must execute table, column, fk, migration, and constraint queries');

      for (const query of queries) {
        // Assert no hardcoded 'public' schema bypass
        assert.doesNotMatch(query, /table_schema\s*=\s*'public'/i, 'Query must not check public schema directly');
        assert.doesNotMatch(query, /nspname\s*=\s*'public'/i, 'Query must not check public namespace directly');
      }

      // Assert queries use current_schema()
      const tableQuery = queries.find(q => q.includes('information_schema.tables'));
      assert.ok(tableQuery && tableQuery.includes('table_schema = current_schema()'));

      const columnQuery = queries.find(q => q.includes('information_schema.columns'));
      assert.ok(columnQuery && columnQuery.includes('table_schema = current_schema()'));

      const fkQuery = queries.find(q => q.includes('information_schema.table_constraints'));
      assert.ok(fkQuery && fkQuery.includes('tc.table_schema = current_schema()'));
      assert.ok(fkQuery && fkQuery.includes('rc.unique_constraint_schema = ccu.constraint_schema'));

      const catalogQuery = queries.find(q => q.includes('pg_constraint'));
      assert.ok(catalogQuery && (catalogQuery.includes('src_ns.nspname = current_schema()') || catalogQuery.includes('nspname = current_schema()')));
    });

    test('[Mock Unit Test] 21. checkMigrationStatus strictly scopes schema_migrations check to current_schema()', async () => {
      const executedQueries: string[] = [];
      const mockClient = {
        query: async (sql: string) => {
          executedQueries.push(sql);
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          if (sql.includes('SELECT id FROM schema_migrations')) {
            return { rows: [{ id: '001_initial_schema.sql' }, { id: '002_tenant_referential_integrity.sql' }, { id: '003_store_sku_limit.sql' }, { id: '004_backfill_store_sku_count.sql' }, { id: '005_billing_subscriptions.sql' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      };
      const mockPool = {
        connect: async () => mockClient,
        end: async () => {},
      };

      const status = await checkMigrationStatus(mockPool as unknown as Pool);
      assert.equal(status.isUpToDate, true);
      assert.equal(status.appliedCount, 5);

      const tableCheckQuery = executedQueries.find(q => q.includes('information_schema.tables'));
      assert.ok(tableCheckQuery, 'Must query information_schema.tables');
      assert.ok(tableCheckQuery.includes('table_schema = current_schema()'));
      assert.doesNotMatch(tableCheckQuery, /table_schema\s*=\s*'public'/i);
    });

    test('[Mock Unit Test] 22. checkSchemaReadiness fails when findings(workspace_id, store_id) composite FK is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          // Missing findings(workspace_id, store_id)
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: findings\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 23. checkSchemaReadiness fails when findings(workspace_id, product_id) composite FK is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'stores',
            constraint_name: 'fk_findings_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          // Missing findings(workspace_id, product_id)
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: findings\(workspace_id, product_id\) -> products\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 24. checkSchemaReadiness fails when action_items(workspace_id, store_id) composite FK is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'stores',
            constraint_name: 'fk_findings_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'products',
            constraint_name: 'fk_findings_product_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,product_id',
            target_columns: 'workspace_id,id',
          },
          // Missing action_items(workspace_id, store_id)
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: action_items\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 25. checkSchemaReadiness fails when action_items(workspace_id, product_id) composite FK is absent', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_table: 'stores',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_table: 'products',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'stores',
            constraint_name: 'fk_findings_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'findings',
            target_table: 'products',
            constraint_name: 'fk_findings_product_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,product_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'action_items',
            target_table: 'stores',
            constraint_name: 'fk_action_items_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
          {
            source_table: 'action_items',
            target_table: 'findings',
            constraint_name: 'fk_action_items_finding_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,finding_id',
            target_columns: 'workspace_id,id',
          },
          // Missing action_items(workspace_id, product_id)
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: action_items\(workspace_id, product_id\) -> products\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 26. checkSchemaReadiness reports all 7 referential constraints and 5 migrations in details', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, true);
      assert.deepEqual(res.details?.appliedMigrations, ALL_REQUIRED_MIGRATIONS);
      const verified = res.details?.verifiedConstraints || [];
      assert.ok(verified.includes('stores(workspace_id, id) UNIQUE'));
      assert.ok(verified.includes('products(workspace_id, store_id) -> stores(workspace_id, id)'));
      assert.ok(verified.includes('findings(workspace_id, store_id) -> stores(workspace_id, id)'));
      assert.ok(verified.includes('findings(workspace_id, product_id) -> products(workspace_id, id)'));
      assert.ok(verified.includes('action_items(workspace_id, store_id) -> stores(workspace_id, id)'));
      assert.ok(verified.includes('action_items(workspace_id, finding_id) -> findings(workspace_id, id)'));
      assert.ok(verified.includes('action_items(workspace_id, product_id) -> products(workspace_id, id)'));
      assert.ok(verified.includes('products(workspace_id) -> workspaces(id)'));
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 27. checkSchemaReadiness rejects foreign key when source column order is reversed', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_schema: 'public',
            source_table: 'stores',
            target_schema: '',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_schema: 'public',
            source_table: 'products',
            target_schema: 'public',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'store_id,workspace_id', // REVERSED source column order!
            target_columns: 'workspace_id,id',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: products\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 28. checkSchemaReadiness rejects foreign key when target column order is reversed', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_schema: 'public',
            source_table: 'stores',
            target_schema: '',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_schema: 'public',
            source_table: 'products',
            target_schema: 'public',
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'id,workspace_id', // REVERSED target column order!
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: products\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 29. checkSchemaReadiness rejects foreign key pointing to same-named table in wrong schema', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_schema: 'public',
            source_table: 'stores',
            target_schema: '',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
          {
            source_schema: 'public',
            source_table: 'products',
            target_schema: 'analytics_schema', // WRONG target schema!
            target_table: 'stores',
            constraint_name: 'fk_products_store_workspace',
            constraint_type: 'f',
            source_columns: 'workspace_id,store_id',
            target_columns: 'workspace_id,id',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /missing required composite foreign key constraint: products\(workspace_id, store_id\) -> stores\(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 30. checkSchemaReadiness rejects constraint when source table is in unexpected schema', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_schema: 'staging_schema', // WRONG source schema!
            source_table: 'stores',
            target_schema: '',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'workspace_id,id',
            target_columns: '',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /stores table missing unique key on \(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 31. stores(workspace_id, id) unique key is rejected if actual ordered definition is reversed (id, workspace_id)', async () => {
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
        catalogConstraints: [
          {
            source_schema: 'public',
            source_table: 'stores',
            target_schema: '',
            target_table: '',
            constraint_name: 'uq_stores_workspace_id',
            constraint_type: 'u',
            source_columns: 'id,workspace_id', // REVERSED ordered unique definition!
            target_columns: '',
          },
        ],
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /stores table missing unique key on \(workspace_id, id\)/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 32. products(workspace_id) -> workspaces(id) is rejected if referenced table is in wrong schema', async () => {
      const wrongSchemaFk = [
        {
          source_schema: 'public',
          source_table: 'products',
          source_column: 'workspace_id',
          target_schema: 'other_tenant_schema', // WRONG target schema!
          target_table: 'workspaces',
          target_column: 'id',
          on_delete: 'CASCADE',
        },
      ];
      const { repo, getReleaseCalled } = createMockPostgresPool({ columnRows: validColumns, fkRows: wrongSchemaFk });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, false);
      assert.match(res.error!, /products\(workspace_id\) foreign key references target schema "other_tenant_schema", expected active schema "public"/);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 33. checkSchemaReadiness succeeds in custom active schema when constraints match that active schema', async () => {
      const customSchema = 'tenant_prod_app';
      const { repo, getReleaseCalled } = createMockPostgresPool({
        columnRows: validColumns,
        currentSchema: customSchema,
        appliedMigrations: ALL_REQUIRED_MIGRATIONS,
      });
      const res = await repo.checkSchemaReadiness();
      assert.equal(res.isReady, true);
      assert.equal(getReleaseCalled(), true);
    });

    test('[Mock Unit Test] 34. Migration 002 SQL source contains strict constraint definition verification and IS DISTINCT FROM guards', () => {
      const migrationPath = path.resolve(__dirname, 'db/migrations/002_tenant_referential_integrity.sql');
      const content = fs.readFileSync(migrationPath, 'utf-8');

      assert.ok(content.includes('IS DISTINCT FROM'), 'Migration 002 must use IS DISTINCT FROM to prevent NULL logic bypass');
      assert.ok(content.includes('[AIXSHOP Migration 002 Error] Incompatible constraint "uq_stores_workspace_id" already exists'), 'Must raise explicit error on incompatible unique constraint');
      assert.ok(content.includes('[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_products_store_workspace" already exists'), 'Must raise explicit error on incompatible foreign key');
      assert.ok(content.includes('ARRAY[\'workspace_id\', \'id\']'), 'Must validate exact array column order');
      assert.ok(!content.includes('OR n.nspname = \'public\''), 'Must not leak schema checks into public');
    });
  });

  // 9. Live PostgreSQL Infrastructure Check (Criterion 8 Compliance)
  describe('Live PostgreSQL Infrastructure Verification', () => {
    const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST);

    test('PostgreSQL live infrastructure status check', { skip: !hasLivePg ? 'SKIPPED: Live PostgreSQL infrastructure credentials (DATABASE_URL / SQL_HOST) not provisioned in current environment' : undefined }, async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        host: process.env.SQL_HOST,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        database: process.env.SQL_DB_NAME,
      });

      const pgRepo = new PostgresRepository(pool);
      const isConnected = await pgRepo.ping();
      assert.equal(isConnected, true);
      await pool.end();
    });
  });
});

