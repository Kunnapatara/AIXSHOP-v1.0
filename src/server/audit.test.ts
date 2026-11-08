import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { Product, StoreProfile } from '../types';

describe('AIXSHOP v1.0 — Phase 1: Real Audit Execution Integration Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  before(async () => {
    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
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

  // Helper to register a test user and obtain auth session token
  async function registerTenant(email: string, wsName: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        fullName: 'Audit Test Merchant',
        workspaceName: wsName,
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    return { token: data.token, workspace: data.workspace, user: data.user };
  }

  describe('Authentication & Workspace Authorization Guard', () => {
    test('POST /api/audit/run rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 401);
    });

    test('GET /api/audit/latest rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/audit/latest`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 401);
    });

    test('GET /api/audit/:id rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/audit/some-id`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('Real Catalog Audit Execution Lifecycle', () => {
    test('executes real audit on populated workspace catalog, records metrics, and persists results', async () => {
      const tenantA = await registerTenant('audit_tenant_a@example.com', 'Tenant A Goods');

      // Seed catalog with products for Tenant A
      const testProduct: Product = {
        id: 'p_prod_a',
        title: 'Handmade Stoneware Pour Over Coffee Dripper',
        brand: 'Ceramics Co',
        category: 'Coffee & Tea',
        description: 'Ceramic coffee dripper with spiral ridges for pour over brewing.',
        image: 'https://example.com/dripper.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 50,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [
          { id: 'v1', sku: 'DRIP-01', title: 'White', barcode: '', price: 32.0, inventoryCount: 10, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      };

      const storeProfile: StoreProfile = {
        name: 'Tenant A Goods',
        domain: 'tenant-a.myshopify.com',
        currency: 'USD',
        skuCount: 1,
        catalogCompletenessAvg: 80,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      };

      // Save catalog via API
      const saveRes = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [testProduct],
            variants: testProduct.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile,
          },
        }),
      });
      assert.equal(saveRes.status, 200);

      // Execute audit via POST /api/audit/run
      const auditRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      assert.equal(auditRes.status, 200);
      const auditData = await auditRes.json();
      assert.equal(auditData.success, true);
      assert.ok(auditData.auditRun);
      assert.equal(auditData.auditRun.status, 'COMPLETED');
      assert.equal(auditData.auditRun.workspaceId, tenantA.workspace.id);
      assert.equal(auditData.auditRun.productsEvaluated, 1);
      assert.ok(auditData.auditRun.rulesEvaluated > 0);
      assert.ok(auditData.auditRun.findingsCount > 0);
      assert.ok(auditData.auditRun.completedAt);

      // Verify that findings include the missing barcode on testProduct
      assert.ok(Array.isArray(auditData.catalog.findings));
      const gtinFinding = auditData.catalog.findings.find((f: any) => f.productId === 'p_prod_a');
      assert.ok(gtinFinding);
      assert.equal(gtinFinding.severity, 'critical');

      // Verify that latest audit run endpoint returns this record
      const latestRes = await fetch(`${baseUrl}/api/audit/latest`, {
        headers: {
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(latestRes.status, 200);
      const latestData = await latestRes.json();
      assert.equal(latestData.auditRun.id, auditData.auditRun.id);
      assert.equal(latestData.auditRun.status, 'COMPLETED');

      // Verify fetching by ID
      const byIdRes = await fetch(`${baseUrl}/api/audit/${auditData.auditRun.id}`, {
        headers: {
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(byIdRes.status, 200);
      const byIdData = await byIdRes.json();
      assert.equal(byIdData.auditRun.id, auditData.auditRun.id);
    });

    test('handles empty workspace catalog gracefully without throwing', async () => {
      const tenantEmpty = await registerTenant('empty_tenant@example.com', 'Empty WS');

      const auditRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantEmpty.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      assert.equal(auditRes.status, 200);
      const data = await auditRes.json();
      assert.equal(data.success, true);
      assert.equal(data.auditRun.status, 'COMPLETED');
      assert.equal(data.auditRun.productsEvaluated, 0);
      assert.equal(data.auditRun.findingsCount, 0);
      assert.equal(data.catalog.products.length, 0);
    });
  });

  describe('Multi-Tenant Isolation & Workspace Boundary', () => {
    test('Workspace B cannot retrieve Workspace A audit run by ID', async () => {
      const tenantA = await registerTenant('isolated_a@example.com', 'Tenant Isolation A');
      const tenantB = await registerTenant('isolated_b@example.com', 'Tenant Isolation B');

      // Tenant A runs audit
      const runResA = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(runResA.status, 200);
      const dataA = await runResA.json();
      const auditRunIdA = dataA.auditRun.id;

      // Tenant B tries to fetch Tenant A's audit run by ID
      const fetchCrossRes = await fetch(`${baseUrl}/api/audit/${auditRunIdA}`, {
        headers: {
          'Authorization': `Bearer ${tenantB.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      // Must be 404 Not Found (isolated from Tenant B)
      assert.equal(fetchCrossRes.status, 404);
      const errData = await fetchCrossRes.json();
      assert.equal(errData.code, 'AUDIT_NOT_FOUND');
    });

    test('Workspace B latest audit run does not return Workspace A audit run', async () => {
      const tenantA = await registerTenant('iso_latest_a@example.com', 'WS Latest A');
      const tenantB = await registerTenant('iso_latest_b@example.com', 'WS Latest B');

      // Tenant A runs audit
      await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantA.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      // Tenant B queries latest (has never run audit)
      const resB = await fetch(`${baseUrl}/api/audit/latest`, {
        headers: {
          'Authorization': `Bearer ${tenantB.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      assert.equal(resB.status, 200);
      const dataB = await resB.json();
      assert.equal(dataB.auditRun, null, 'Tenant B latest audit run must be null');
    });
  });

  describe('Concurrency & Idempotency Guards', () => {
    test('concurrent audit runs on same workspace are serialized under workspace lock without crashing', async () => {
      const tenantConc = await registerTenant('concurrency_audit@example.com', 'Concurrency WS');

      // Launch 2 simultaneous audit run requests
      const p1 = fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantConc.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const p2 = fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenantConc.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);

      const d1 = await res1.json();
      const d2 = await res2.json();
      assert.equal(d1.success, true);
      assert.equal(d2.success, true);
      assert.equal(d1.auditRun.status, 'COMPLETED');
      assert.equal(d2.auditRun.status, 'COMPLETED');
      assert.notEqual(d1.auditRun.id, d2.auditRun.id, 'Two runs should have distinct IDs');
    });
  });
});
