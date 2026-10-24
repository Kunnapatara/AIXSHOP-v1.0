import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { ProductCandidate } from '../types';
import { 
  countCatalogSkus, 
  calculateImportUsage, 
  checkPlanQuota, 
  resolveWorkspacePlanEntitlement 
} from './services/entitlementService';

describe('AIXSHOP v1.0 — Server-Side Plan Entitlement & Quota Enforcement Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  // Test identities
  let tokenUserA: string;
  let workspaceIdA: string;

  let tokenUserB: string;
  let workspaceIdB: string;

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

    // 1. Register Workspace A (Quota testing)
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'workspace_a_owner@example.com',
        password: 'passwordA123',
        fullName: 'Alice Merchant',
        workspaceName: 'Workspace A Retail',
      }),
    });
    assert.equal(regResA.status, 201);
    const dataA = await regResA.json();
    tokenUserA = dataA.token;
    workspaceIdA = dataA.workspace.id;

    // 2. Register Workspace B (Tenant isolation testing)
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'workspace_b_owner@example.com',
        password: 'passwordB123',
        fullName: 'Bob Merchant',
        workspaceName: 'Workspace B Retail',
      }),
    });
    assert.equal(regResB.status, 201);
    const dataB = await regResB.json();
    tokenUserB = dataB.token;
    workspaceIdB = dataB.workspace.id;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Helper fixture builder
  function buildCandidateProduct(id: string, variantSkus: string[], price = 19.99): ProductCandidate {
    return {
      id,
      title: `Product Title ${id}`,
      brand: 'Test Brand',
      category: 'Home & Kitchen',
      description: 'Standard product description',
      image: 'https://example.com/p.jpg',
      status: 'active',
      completenessScore: 85,
      evidenceCoverageScore: 70,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {
        sourceProductId: id,
      },
      variants: variantSkus.map((sku, idx) => ({
        id: `var_${id}_${idx}`,
        sku,
        title: `Variant ${sku}`,
        barcode: '',
        price,
        attributes: {
          sourceVariantId: `var_${id}_${idx}`,
        },
      })),
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };
  }

  // 1. Authoritative SKU Counting Unit Tests
  describe('SKU Definition and Usage Counting', () => {
    test('existing SKUs are counted correctly as 1 SKU per variant', () => {
      const p1 = buildCandidateProduct('p1', ['SKU-1A', 'SKU-1B', 'SKU-1C']); // 3 variants
      const p2 = buildCandidateProduct('p2', ['SKU-2A']); // 1 variant
      const count = countCatalogSkus([p1, p2]);
      assert.equal(count, 4, 'Should count 3 + 1 = 4 total variants/SKUs');
    });

    test('deduplication rules avoid double-counting duplicates against existing catalog', () => {
      const existing = [buildCandidateProduct('p1', ['SKU-1A', 'SKU-1B'])];
      // Incoming includes p1 (already in catalog) and new p2 (with 2 variants)
      const incoming = [
        buildCandidateProduct('p1', ['SKU-1A', 'SKU-1B']), // duplicate
        buildCandidateProduct('p2', ['SKU-2A', 'SKU-2B']), // new
      ];

      const { additionalSkus, eligibleProducts, candidateDetails } = calculateImportUsage(incoming, existing);
      assert.equal(additionalSkus, 2, 'Only eligible new product p2 variants should count');
      assert.equal(eligibleProducts.length, 1);
      assert.equal(eligibleProducts[0].id, 'p2');
      assert.equal(candidateDetails.find(d => d.productId === 'p1')?.status, 'duplicate');
    });

    test('intra-batch duplicate SKUs are not double-counted', () => {
      const incoming = [
        buildCandidateProduct('p1', ['SKU-COLLIDE-A']),
        buildCandidateProduct('p2', ['SKU-COLLIDE-A']), // duplicate SKU within batch
      ];
      const { additionalSkus, eligibleProducts } = calculateImportUsage(incoming, []);
      assert.equal(additionalSkus, 1, 'Only first product in batch should be eligible');
      assert.equal(eligibleProducts.length, 1);
    });
  });

  // 2. Authoritative Plan Entitlement Resolution & Safe Defaults
  describe('Authoritative Plan Resolution & Safety Rules', () => {
    test('resolves explicit positive skuLimit regardless of tier name', () => {
      const ent = resolveWorkspacePlanEntitlement({
        name: 'Store',
        domain: 'store.myshopify.com',
        skuCount: 0,
        skuLimit: 50,
        tier: 'Custom Tier',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      });
      assert.equal(ent.isValid, true);
      assert.equal(ent.skuLimit, 50);
      assert.equal(ent.isUnlimited, false);
    });

    test('resolves Starter Tier default to 250 SKUs when skuLimit is undefined', () => {
      const ent = resolveWorkspacePlanEntitlement({
        name: 'Store',
        domain: 'store.myshopify.com',
        skuCount: 0,
        tier: 'Starter Tier',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      });
      assert.equal(ent.isValid, true);
      assert.equal(ent.skuLimit, 250);
      assert.equal(ent.isUnlimited, false);
    });

    test('resolves Growth Tier default to 2,500 SKUs when skuLimit is undefined', () => {
      const ent = resolveWorkspacePlanEntitlement({
        name: 'Store',
        domain: 'store.myshopify.com',
        skuCount: 0,
        tier: 'Growth Tier',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      });
      assert.equal(ent.isValid, true);
      assert.equal(ent.skuLimit, 2500);
      assert.equal(ent.isUnlimited, false);
    });

    test('resolves Enterprise Tier to unlimited SKUs when skuLimit is undefined', () => {
      const ent = resolveWorkspacePlanEntitlement({
        name: 'Store',
        domain: 'store.myshopify.com',
        skuCount: 0,
        tier: 'Enterprise Tier',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      });
      assert.equal(ent.isValid, true);
      assert.equal(ent.skuLimit, Infinity);
      assert.equal(ent.isUnlimited, true);
    });

    test('missing store profile fails safely (limit: 0, isValid: false)', () => {
      const ent = resolveWorkspacePlanEntitlement(null);
      assert.equal(ent.isValid, false);
      assert.equal(ent.skuLimit, 0);
      assert.equal(ent.isUnlimited, false);
      assert.match(ent.error || '', /not found/i);
    });

    test('invalid negative skuLimit fails safely (limit: 0, isValid: false)', () => {
      const ent = resolveWorkspacePlanEntitlement({
        name: 'Store',
        domain: 'store.myshopify.com',
        skuCount: 0,
        skuLimit: -10,
        tier: 'Growth Tier',
        currency: 'USD',
        connectors: [],
        catalogCompletenessAvg: 0,
        truthBoundaryStrictness: 'standard',
      });
      assert.equal(ent.isValid, false);
      assert.equal(ent.skuLimit, 0);
      assert.equal(ent.isUnlimited, false);
    });
  });

  // 3. HTTP Server-Side Entitlement Enforcement Tests
  describe('POST /api/catalog/import Server-Side Enforcement', () => {
    test('1. An import within the authoritative limit succeeds', async () => {
      // Configure Workspace A with limit of 5 SKUs
      const currentStoreA = await repo.getStoreByWorkspace(workspaceIdA);
      assert.ok(currentStoreA);
      await repo.saveStoreProfile(workspaceIdA, {
        ...currentStoreA,
        skuLimit: 5,
        tier: 'Free Audit',
      });

      // Import 2 products (1 variant each = 2 SKUs <= 5)
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('prod_within_1', ['SKU-W-1']),
            buildCandidateProduct('prod_within_2', ['SKU-W-2']),
          ],
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.result.importedCount, 2);

      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catalogA?.products.length, 2);
    });

    test('2. An import that exceeds the limit is rejected with 403 PLAN_QUOTA_EXCEEDED', async () => {
      // Workspace A currently has 2 SKUs. Limit is 5.
      // Attempting to import 4 new SKUs (total 6 > 5)
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('prod_exceed_1', ['SKU-EX-1', 'SKU-EX-2']), // 2 variants
            buildCandidateProduct('prod_exceed_2', ['SKU-EX-3', 'SKU-EX-4']), // 2 variants
          ],
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'PLAN_QUOTA_EXCEEDED');
      assert.equal(data.limit, 5);
      assert.equal(data.currentUsage, 2);
      assert.equal(data.additionalUsage, 4);
      assert.equal(data.projectedUsage, 6);
      assert.match(data.error, /Plan quota exceeded/i);
    });

    test('3. A rejected import does not partially persist catalog changes', async () => {
      // Confirm Workspace A catalog still only contains the original 2 products
      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catalogA?.products.length, 2);
      assert.equal(catalogA?.products.some(p => p.id === 'prod_exceed_1'), false);
      assert.equal(catalogA?.products.some(p => p.id === 'prod_exceed_2'), false);
    });

    test('4. Duplicate import semantics do not double-count records already present', async () => {
      // Workspace A limit is 5, currently has 2 SKUs ('prod_within_1' and 'prod_within_2').
      // Re-importing 'prod_within_1' (already in catalog) + 1 new SKU (1 SKU + 0 dupes = 3 total <= 5)
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('prod_within_1', ['SKU-W-1']), // duplicate!
            buildCandidateProduct('prod_within_3', ['SKU-W-3']), // 1 new variant
          ],
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.result.importedCount, 1);
      assert.equal(data.result.skippedCount, 1);

      // Now total SKUs = 3 (within limit of 5)
      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catalogA?.products.length, 3);
    });

    test('5. Re-importing exact duplicate products succeeds even when at exact quota limit', async () => {
      // Fill Workspace A to exact limit of 5 SKUs by adding 2 more SKUs
      const fillRes = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('prod_fill_4', ['SKU-W-4']),
            buildCandidateProduct('prod_fill_5', ['SKU-W-5']),
          ],
        }),
      });
      assert.equal(fillRes.status, 200);

      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catalogA?.products.length, 5); // at capacity (5 / 5)

      // Re-importing all 5 existing products should compute 0 additional SKUs and succeed
      const dupRes = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('prod_within_1', ['SKU-W-1']),
            buildCandidateProduct('prod_within_2', ['SKU-W-2']),
            buildCandidateProduct('prod_within_3', ['SKU-W-3']),
          ],
        }),
      });
      assert.equal(dupRes.status, 200);
      const dupData = await dupRes.json();
      assert.equal(dupData.result.importedCount, 0);
      assert.equal(dupData.result.skippedCount, 3);
    });

    test('6. Client cannot bypass limits by changing request-body plan fields', async () => {
      // Workspace A is at capacity (5/5).
      // Client maliciously supplies tier: 'Enterprise' and skuLimit: 999999 in request body.
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [buildCandidateProduct('prod_malicious_bypass', ['SKU-MAL-1'])],
          tier: 'Enterprise',
          skuLimit: 999999,
          plan: 'enterprise',
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'PLAN_QUOTA_EXCEEDED');
      assert.equal(data.limit, 5, 'Server must enforce authoritative store limit 5, ignoring body tier/limit');
    });

    test('7. Client cannot escalate quota via PUT /api/store/profile', async () => {
      const putRes = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          name: 'Updated Name',
          tier: 'Enterprise',
          skuLimit: 50000,
        }),
      });

      assert.equal(putRes.status, 200);
      const storeA = await repo.getStoreByWorkspace(workspaceIdA);
      assert.equal(storeA?.name, 'Updated Name');
      assert.equal(storeA?.tier, 'Free Audit', 'tier must remain untouched on server');
      assert.equal(storeA?.skuLimit, 5, 'skuLimit must remain 5 on server');
    });

    test('8. Workspace cannot use another workspace catalog count or subscription', async () => {
      // Workspace B currently has 0 products and limit 2500 (Free Audit default).
      // User B attempts to import products while spoofing Workspace A ID in request body
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          workspaceId: workspaceIdA, // spoofed
          candidates: [buildCandidateProduct('prod_b_01', ['SKU-B-1'])],
        }),
      });

      assert.equal(res.status, 200);

      // Verify product was imported into Workspace B, NOT Workspace A
      const catalogB = await repo.loadWorkspaceCatalog(workspaceIdB);
      assert.equal(catalogB?.products.some(p => p.id === 'prod_b_01'), true);

      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.equal(catalogA?.products.some(p => p.id === 'prod_b_01'), false);
    });

    test('9. Missing or invalid entitlement data fails safely', async () => {
      // Temporarily set an invalid negative skuLimit on Workspace B
      const storeB = await repo.getStoreByWorkspace(workspaceIdB);
      assert.ok(storeB);
      await repo.saveStoreProfile(workspaceIdB, {
        ...storeB,
        skuLimit: -5,
      });

      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [buildCandidateProduct('prod_b_safe_fail', ['SKU-SAFE-1'])],
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'PLAN_QUOTA_EXCEEDED');
      assert.equal(data.limit, 0);

      // Restore Workspace B limit
      await repo.saveStoreProfile(workspaceIdB, {
        ...storeB,
        skuLimit: 2500,
      });
    });

    test('10. Unauthenticated guest/demo requests to /api/catalog/import are rejected with 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [buildCandidateProduct('prod_unauth', ['SKU-UNAUTH'])],
        }),
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'UNAUTHORIZED');
    });

    test('11. Equivalent API path PUT /api/catalog enforces the same plan quota', async () => {
      // Workspace A has limit 5. Attempting to PUT a catalog with 6 products.
      const catalogA = await repo.loadWorkspaceCatalog(workspaceIdA);
      assert.ok(catalogA);

      const oversizedProducts = [
        buildCandidateProduct('ov_1', ['SKU-O-1']),
        buildCandidateProduct('ov_2', ['SKU-O-2']),
        buildCandidateProduct('ov_3', ['SKU-O-3']),
        buildCandidateProduct('ov_4', ['SKU-O-4']),
        buildCandidateProduct('ov_5', ['SKU-O-5']),
        buildCandidateProduct('ov_6', ['SKU-O-6']), // 6th product
      ];

      const res = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          payload: {
            ...catalogA,
            products: oversizedProducts,
          },
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'PLAN_QUOTA_EXCEEDED');
      assert.equal(data.limit, 5);
      assert.equal(data.additionalUsage, 6);
    });

    test('12. Concurrent import requests for the same workspace are serialized and prevent quota race conditions', async () => {
      // Set Workspace B limit to exactly 3 SKUs
      const storeB = await repo.getStoreByWorkspace(workspaceIdB);
      assert.ok(storeB);
      await repo.saveStoreProfile(workspaceIdB, {
        ...storeB,
        skuLimit: 3,
      });

      // Clear Workspace B catalog so currentUsage = 0
      const catalogB = await repo.loadWorkspaceCatalog(workspaceIdB);
      assert.ok(catalogB);
      await repo.saveWorkspaceCatalog(workspaceIdB, {
        ...catalogB,
        products: [],
      });

      // Launch 2 simultaneous import requests each wanting to import 2 SKUs (total 4 > 3).
      // Without workspace serialization mutex, both could read usage=0 concurrently and both succeed.
      const req1 = fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('concurrent_batch1_a', ['SKU-C1-A']),
            buildCandidateProduct('concurrent_batch1_b', ['SKU-C1-B']),
          ],
        }),
      });

      const req2 = fetch(`${baseUrl}/api/catalog/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          candidates: [
            buildCandidateProduct('concurrent_batch2_a', ['SKU-C2-A']),
            buildCandidateProduct('concurrent_batch2_b', ['SKU-C2-B']),
          ],
        }),
      });

      const [res1, res2] = await Promise.all([req1, req2]);
      const statuses = [res1.status, res2.status].sort();

      // Exactly one request must succeed (200) and the second must be rejected (403 PLAN_QUOTA_EXCEEDED)
      assert.equal(statuses[0], 200, 'One request within capacity must succeed');
      assert.equal(statuses[1], 403, 'The second concurrent request exceeding quota must be rejected');

      const failedRes = res1.status === 403 ? res1 : res2;
      const failedData = await failedRes.json();
      assert.equal(failedData.code, 'PLAN_QUOTA_EXCEEDED');

      // Final catalog count must not exceed 3
      const finalCatalogB = await repo.loadWorkspaceCatalog(workspaceIdB);
      assert.equal(finalCatalogB?.products.length, 2, 'Catalog must contain exactly 2 SKUs and never exceed limit 3');
    });
  });
});
