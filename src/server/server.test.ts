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
import { runMigrations } from './db/migrate';
import { Pool } from 'pg';

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

  // 1. Health check
  test('GET /api/health returns service status and database backend', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.database.backend, 'memory');
    assert.equal(data.database.connected, true);
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
      setDatabaseRepository(null);

      const devRepo = getDatabaseRepository();
      assert.equal(devRepo.getBackendType(), 'memory');
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
      delete process.env.DATABASE_URL;
      delete process.env.SQL_HOST;

      try {
        await assert.rejects(
          async () => {
            await runMigrations();
          },
          (err: any) => {
            assert.match(err.message, /\[AIXSHOP Migration Error\]/i);
            assert.match(err.message, /DATABASE_URL or SQL_HOST/i);
            return true;
          }
        );
      } finally {
        if (originalUrl) process.env.DATABASE_URL = originalUrl;
        if (originalHost) process.env.SQL_HOST = originalHost;
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
  });

  // 7. Live PostgreSQL Infrastructure Check (Criterion 8 Compliance)
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

