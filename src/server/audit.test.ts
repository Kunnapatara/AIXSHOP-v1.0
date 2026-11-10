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

  describe('Workstream B: Audit History & Evidence Snapshot Suite', () => {
    test('A. Historical Persistence: newly completed audit persists durable findings, evidence, and product observations', async () => {
      const tenant = await registerTenant('persist_snapshot@example.com', 'Persistence Goods');

      const testProduct: Product = {
        id: 'prod_persist_01',
        title: 'Organic Fair Trade French Roast Coffee Beans',
        brand: 'Origin Coffee Co',
        category: 'Food & Beverage / Coffee',
        description: 'Rich dark roasted whole bean coffee with chocolate notes.',
        image: 'https://example.com/coffee.jpg',
        status: 'active',
        completenessScore: 85,
        evidenceCoverageScore: 90,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {
          recommendedBrewMethods: '(none)', // triggers structured brew methods rule
        },
        variants: [
          { id: 'var_01', sku: 'COFFEE-12OZ', title: '12 oz Bag', barcode: '0850029381044', price: 18.5, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [
          {
            id: 'evid_fair_trade_01',
            title: 'Fair Trade Certified Registry Certificate',
            type: 'fair_trade_doc',
            issuer: 'Fair Trade USA',
            dateVerified: '2026-05-15',
            url: 'https://fairtradecertified.org/registry/10492',
            status: 'verified',
          },
        ],
        findingsCount: 0,
        lastAudited: '',
      };

      const store: StoreProfile = {
        name: 'Persistence Goods',
        domain: 'persist.myshopify.com',
        currency: 'USD',
        skuCount: 1,
        catalogCompletenessAvg: 85,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      };

      // Save catalog
      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [testProduct],
            variants: testProduct.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: testProduct.evidenceDocuments,
            storeProfile: store,
          },
        }),
      });

      // Execute audit
      const runRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(runRes.status, 200);
      const runData = await runRes.json();
      const runId = runData.auditRun.id;

      // Inspect detail endpoint with historical snapshot
      const detailRes = await fetch(`${baseUrl}/api/audit/${runId}`, {
        headers: {
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assert.equal(detailRes.status, 200);
      const detailData = await detailRes.json();
      assert.equal(detailData.success, true);
      assert.equal(detailData.snapshotAvailable, true);
      assert.ok(Array.isArray(detailData.findings));
      assert.ok(Array.isArray(detailData.evidence));
      assert.ok(Array.isArray(detailData.products));

      // Verify findings snapshot captured ruleCode, title, severity, and productTitle
      const brewFinding = detailData.findings.find((f: any) => f.ruleCode === 'RULE_STRUCTURED_BREW_METHODS');
      assert.ok(brewFinding, 'Must capture brew methods finding snapshot');
      assert.equal(brewFinding.productTitle, testProduct.title);
      assert.equal(brewFinding.productId, testProduct.id);

      // Verify evidence snapshot provenance captured
      const evidSnapshot = detailData.evidence.find((e: any) => e.originalEvidenceId === 'evid_fair_trade_01');
      assert.ok(evidSnapshot, 'Must capture Fair Trade evidence document snapshot');
      assert.equal(evidSnapshot.issuer, 'Fair Trade USA');
      assert.equal(evidSnapshot.status, 'verified');
      assert.equal(evidSnapshot.url, 'https://fairtradecertified.org/registry/10492');

      // Verify product observation snapshot captured
      const prodSnapshot = detailData.products.find((p: any) => p.productId === testProduct.id);
      assert.ok(prodSnapshot, 'Must capture product snapshot');
      assert.equal(prodSnapshot.title, testProduct.title);
      assert.equal(prodSnapshot.variants.length, 1);
      assert.equal(prodSnapshot.variants[0].sku, 'COFFEE-12OZ');
    });

    test('B. Historical Immutability: modifying current catalog and re-auditing does NOT alter historical snapshot of previous audit', async () => {
      const tenant = await registerTenant('immutability_tenant@example.com', 'Immutability Works');

      // Initial Product state: missing barcode
      const initialProduct: Product = {
        id: 'prod_immutable_01',
        title: 'Handmade Ceramic Planter Pot',
        brand: 'Clay & Co',
        category: 'Home & Garden / Planters',
        description: 'Terracotta ceramic plant pot with drainage dish included.',
        image: 'https://example.com/planter.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 50,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [
          { id: 'v_init', sku: 'PLANT-01', title: 'Terracotta', barcode: '', price: 28.0, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      };

      const store: StoreProfile = {
        name: 'Immutability Works',
        domain: 'immutability.myshopify.com',
        currency: 'USD',
        skuCount: 1,
        catalogCompletenessAvg: 80,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      };

      // 1. Save Initial Catalog
      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [initialProduct],
            variants: initialProduct.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // 2. Run Audit A
      const runResA = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const dataA = await runResA.json();
      const auditRunIdA = dataA.auditRun.id;

      // Retrieve Audit A snapshot
      const snapResA1 = await fetch(`${baseUrl}/api/audit/${auditRunIdA}`, {
        headers: {
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const snapA1 = await snapResA1.json();
      assert.equal(snapA1.findings.length > 0, true);
      const barcodeFindingA = snapA1.findings.find((f: any) => f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT');
      assert.ok(barcodeFindingA, 'Audit A should have missing barcode finding');
      assert.equal(barcodeFindingA.currentValue, '(empty)');

      // 3. Mutate Current Catalog: Merchant assigns valid barcode and changes product title
      const modifiedProduct: Product = {
        ...initialProduct,
        title: 'Renamed Premium Ceramic Planter Pot (Mutated Title)',
        variants: [
          { id: 'v_init', sku: 'PLANT-01', title: 'Terracotta', barcode: '0850029381044', price: 34.0, attributes: {} },
        ],
      };

      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [modifiedProduct],
            variants: modifiedProduct.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // 4. Run Audit B
      const runResB = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const dataB = await runResB.json();
      const auditRunIdB = dataB.auditRun.id;
      assert.notEqual(auditRunIdA, auditRunIdB);

      // 5. Retrieve Audit A snapshot AGAIN after current catalog was mutated and Audit B completed
      const snapResA2 = await fetch(`${baseUrl}/api/audit/${auditRunIdA}`, {
        headers: {
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const snapA2 = await snapResA2.json();

      // STRICT IMMUTABILITY VERIFICATION:
      // Audit A product title must still be the original title ('Handmade Ceramic Planter Pot')
      assert.equal(snapA2.products[0].title, 'Handmade Ceramic Planter Pot');
      // Audit A variant barcode must still be empty
      assert.equal(snapA2.products[0].variants[0].barcode, '');
      // Audit A findings must still include the missing GTIN finding with observed value '(empty)'
      const barcodeFindingA2 = snapA2.findings.find((f: any) => f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT');
      assert.ok(barcodeFindingA2);
      assert.equal(barcodeFindingA2.currentValue, '(empty)');
      assert.equal(barcodeFindingA2.productTitle, 'Handmade Ceramic Planter Pot');

      // Now inspect Audit B snapshot: it must reflect the new title and NO missing barcode finding
      const snapResB = await fetch(`${baseUrl}/api/audit/${auditRunIdB}`, {
        headers: {
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const snapB = await snapResB.json();
      assert.equal(snapB.products[0].title, 'Renamed Premium Ceramic Planter Pot (Mutated Title)');
      assert.equal(snapB.products[0].variants[0].barcode, '0850029381044');
      const barcodeFindingB = snapB.findings.find((f: any) => f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT');
      assert.equal(barcodeFindingB, undefined, 'Audit B should not have missing GTIN finding');
    });

    test('C. Historical API & Pagination: GET /api/audit/history supports ordering and pagination', async () => {
      const tenant = await registerTenant('paging_tenant@example.com', 'Paging WS');

      // Run 3 audits
      await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });

      // Page 1 with limit=2
      const page1Res = await fetch(`${baseUrl}/api/audit/history?limit=2`, {
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(page1Res.status, 200);
      const page1 = await page1Res.json();
      assert.equal(page1.success, true);
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor);
      assert.equal(page1.items[0].snapshotAvailable, true);

      // Page 2 using cursor
      const page2Res = await fetch(`${baseUrl}/api/audit/history?limit=2&cursor=${page1.nextCursor}`, {
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(page2Res.status, 200);
      const page2 = await page2Res.json();
      assert.equal(page2.success, true);
      assert.equal(page2.items.length, 1);
      assert.equal(page2.nextCursor, null);
    });

    test('D. Multi-Tenant Workspace Isolation: Workspace B cannot fetch Workspace A historical snapshots', async () => {
      const tenantA = await registerTenant('history_iso_a@example.com', 'Iso A Corp');
      const tenantB = await registerTenant('history_iso_b@example.com', 'Iso B Corp');

      // Tenant A runs audit
      const runRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenantA.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const runData = await runRes.json();
      const runIdA = runData.auditRun.id;

      // Tenant B tries to fetch Tenant A's historical snapshot
      const crossRes = await fetch(`${baseUrl}/api/audit/${runIdA}`, {
        headers: { 'Authorization': `Bearer ${tenantB.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(crossRes.status, 404);
      const crossData = await crossRes.json();
      assert.equal(crossData.code, 'AUDIT_NOT_FOUND');

      // Tenant B history list must NOT include Tenant A's run
      const histResB = await fetch(`${baseUrl}/api/audit/history`, {
        headers: { 'Authorization': `Bearer ${tenantB.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(histResB.status, 200);
      const histDataB = await histResB.json();
      assert.equal(histDataB.items.some((i: any) => i.id === runIdA), false);
    });

    test('E. Historical Comparison: GET /api/audit/compare detects resolved, persistent, and new findings', async () => {
      const tenant = await registerTenant('compare_tenant@example.com', 'Comparison Store');

      // Base catalog: has candle burn time conflict and missing GTIN
      const p1: Product = {
        id: 'p_candle_01',
        title: '60-Hour Soy Wax Candle',
        brand: 'Loom & Wick',
        category: 'Home Fragrance / Candles',
        description: 'Hand poured botanical wax candle.',
        image: 'https://example.com/candle.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 50,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {
          burnTime: '45-50 Hours', // triggers burn time conflict with 60h title claim
        },
        variants: [
          { id: 'v_c1', sku: 'CANDLE-01', title: 'Lavender', barcode: '', price: 24.0, attributes: {} }, // triggers missing GTIN
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      };

      const store: StoreProfile = {
        name: 'Comparison Store',
        domain: 'compare.myshopify.com',
        currency: 'USD',
        skuCount: 1,
        catalogCompletenessAvg: 80,
        truthBoundaryStrictness: 'standard',
        tier: 'Free Audit',
        connectors: [],
      };

      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [p1],
            variants: p1.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // Run Base Audit
      const baseRunRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const baseData = await baseRunRes.json();
      const baseId = baseData.auditRun.id;

      // Update Catalog: resolve missing GTIN by assigning valid barcode, but keep candle burn time conflict
      const p1Updated: Product = {
        ...p1,
        variants: [
          { id: 'v_c1', sku: 'CANDLE-01', title: 'Lavender', barcode: '0850029381044', price: 24.0, attributes: {} },
        ],
      };

      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [p1Updated],
            variants: p1Updated.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // Run Target Audit
      const targetRunRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const targetData = await targetRunRes.json();
      const targetId = targetData.auditRun.id;

      // Call comparison endpoint
      const compRes = await fetch(`${baseUrl}/api/audit/compare?baseId=${baseId}&targetId=${targetId}`, {
        headers: { 'Authorization': `Bearer ${tenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(compRes.status, 200);
      const compData = await compRes.json();
      assert.equal(compData.success, true);
      assert.ok(compData.comparison);

      const comparison = compData.comparison;
      assert.ok(comparison.persistentCount > 0, 'Burn time conflict should be persistent');
      assert.ok(comparison.resolvedCount > 0, 'GTIN missing issue should be marked resolved');

      // Check resolved item
      const resolvedItem = comparison.comparisonItems.find((i: any) => i.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT');
      assert.ok(resolvedItem);
      assert.equal(resolvedItem.status, 'RESOLVED');

      // Check persistent item
      const persistentItem = comparison.comparisonItems.find((i: any) => i.ruleCode === 'RULE_MARKETING_BURN_TIME_CONFLICT');
      assert.ok(persistentItem);
      assert.equal(persistentItem.status, 'PERSISTENT');
    });

    test('Zero-findings audit correctly marks snapshotAvailable: true via completion manifest', async () => {
      const cleanTenant = await registerTenant('clean_catalog_user@example.com', 'Clean Catalog Store');
      const storeRes = await fetch(`${baseUrl}/api/store/profile`, {
        headers: { 'Authorization': `Bearer ${cleanTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const store = await storeRes.json();

      // Seed with 0 products (clean catalog produces 0 findings)
      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cleanTenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [],
            variants: [],
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // Execute audit
      const runRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cleanTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(runRes.status, 200);
      const runData = await runRes.json();
      assert.equal(runData.auditRun.findingsCount, 0);

      // Verify history list reports snapshotAvailable: true
      const histRes = await fetch(`${baseUrl}/api/audit/history`, {
        headers: { 'Authorization': `Bearer ${cleanTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(histRes.status, 200);
      const histData = await histRes.json();
      const latestItem = histData.items.find((i: any) => i.id === runData.auditRun.id);
      assert.ok(latestItem, 'Must find clean audit in history');
      assert.equal(latestItem.snapshotAvailable, true, 'Clean audit with 0 findings must report snapshotAvailable: true');

      // Verify audit detail reports snapshotAvailable: true
      const detailRes = await fetch(`${baseUrl}/api/audit/${runData.auditRun.id}`, {
        headers: { 'Authorization': `Bearer ${cleanTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(detailRes.status, 200);
      const detailData = await detailRes.json();
      assert.equal(detailData.snapshotAvailable, true);
      assert.deepEqual(detailData.findings, []);
    });

    test('Evidence documents retain their associated productId in historical snapshots', async () => {
      const evidenceTenant = await registerTenant('evidence_test_user@example.com', 'Evidence Test Store');
      const storeRes = await fetch(`${baseUrl}/api/store/profile`, {
        headers: { 'Authorization': `Bearer ${evidenceTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const store = await storeRes.json();

      const productWithEvidence: Product = {
        id: 'p_organic_tea',
        title: 'Artisan Organic Herbal Tea 100g',
        brand: 'Nature Farm',
        category: 'Food & Beverage',
        description: 'Certified 100% organic herbal tea harvested sustainably.',
        image: 'https://example.com/tea.jpg',
        status: 'active',
        completenessScore: 85,
        evidenceCoverageScore: 100,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [
          { id: 'v_tea_1', sku: 'TEA-ORG-01', title: '100g Bag', barcode: '9780201379624', price: 15.0, inventoryCount: 50, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [
          {
            id: 'ev_usda_cert_456',
            title: 'USDA Organic Official Certificate',
            type: 'organic_certificate',
            issuer: 'USDA National Organic Program',
            dateVerified: '2026-05-01T00:00:00.000Z',
            url: 'https://example.com/cert/usda-456.pdf',
            status: 'verified',
          },
        ],
        findingsCount: 0,
        lastAudited: '',
      };

      await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${evidenceTenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            products: [productWithEvidence],
            variants: productWithEvidence.variants,
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          },
        }),
      });

      // Execute audit
      const runRes = await fetch(`${baseUrl}/api/audit/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${evidenceTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(runRes.status, 200);
      const runData = await runRes.json();

      // Retrieve detail
      const detailRes = await fetch(`${baseUrl}/api/audit/${runData.auditRun.id}`, {
        headers: { 'Authorization': `Bearer ${evidenceTenant.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(detailRes.status, 200);
      const detailData = await detailRes.json();
      assert.equal(detailData.snapshotAvailable, true);

      // Verify evidence retains productId
      const ev = detailData.evidence.find((e: any) => e.originalEvidenceId === 'ev_usda_cert_456');
      assert.ok(ev, 'Must find historical evidence record');
      assert.equal(ev.productId, 'p_organic_tea', 'Historical evidence must preserve associated productId');
      assert.equal(ev.issuer, 'USDA National Organic Program');
      assert.equal(ev.status, 'verified');
    });
  });
});

