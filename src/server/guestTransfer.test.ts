import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { initialProducts, initialStoreProfile, initialFindings, initialActionItems } from '../data/mockData';
import type { StoragePayloadV1 } from '../domain/storage/storageTypes';
import type { Product } from '../types';
import {
  authorizeGuestTransfer,
  commitGuestTransfer,
} from './services/guestTransferService';

function makeGuestProduct(overrides: Partial<Product> & { id: string; title: string }): Product {
  return {
    brand: 'Solstice Goods',
    category: 'Kitchen',
    description: `${overrides.title} description`,
    image: '',
    status: 'active',
    completenessScore: 88,
    evidenceCoverageScore: 70,
    externalDiscoveryStatus: 'observed_in_sample',
    lastAudited: '2026-11-20T00:00:00Z',
    findingsCount: 0,
    sourceClassification: 'public_feed',
    sourceOrigin: 'https://guest-shop.example.com',
    acquisitionMethod: 'public_products_json_sample',
    attributes: {},
    variants: [
      {
        id: `var_${overrides.id}`,
        sku: `SKU-${overrides.id.toUpperCase()}`,
        title: 'Default',
        barcode: '0123456789012',
        price: 34.0,
        inventoryCount: 10,
        attributes: {},
      },
    ],
    offers: [
      {
        id: `off_${overrides.id}`,
        channel: 'Direct Storefront',
        price: 34.0,
        currency: 'USD',
        availability: 'in_stock',
        condition: 'new',
        url: 'https://guest-shop.example.com/products/1',
        merchantId: 'guest_merch',
        lastSync: '2026-11-20T00:00:00Z',
      },
    ],
    evidenceDocuments: [
      {
        id: `ev_${overrides.id}`,
        title: 'Supplier Spec Sheet',
        type: 'manufacturer_spec',
        issuer: 'Acme Labs',
        dateVerified: '2026-11-01',
        url: 'https://guest-shop.example.com/spec.pdf',
        evidencePurpose: 'product_claim',
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

function makeGuestPayload(overrides?: Partial<StoragePayloadV1>): StoragePayloadV1 {
  const prod = makeGuestProduct({
    id: 'guest_prod_1',
    title: 'Guest Handwoven Throw',
  });
  return {
    products: [prod],
    variants: prod.variants,
    offers: prod.offers,
    findings: [
      {
        id: 'guest_find_1',
        scope: 'product',
        productId: prod.id,
        productTitle: prod.title,
        type: 'missing_information',
        severity: 'medium',
        title: 'Missing material care note',
        description: 'Material care details are incomplete.',
        observedEvidence: 'Empty care_instructions attribute',
        derivedConclusion: 'AI shoppers may ask about washing instructions',
        merchantVerified: false,
        whyItMatters: 'Reduces returns',
        suggestedCorrection: 'Add washing care details',
      },
    ],
    actions: [
      {
        id: 'guest_act_1',
        findingId: 'guest_find_1',
        productId: prod.id,
        productTitle: prod.title,
        title: 'Add washing instructions',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'attributes.care',
          from: '(empty)',
          to: 'Machine wash cold',
        },
        verificationStatus: 'unverified',
      },
    ],
    evidence: prod.evidenceDocuments,
    storeProfile: {
      name: 'Guest Shop Mercantile',
      domain: 'guest-shop.example.com',
      websiteUrl: 'https://guest-shop.example.com',
      platform: 'Public Storefront Feed',
      sourceClassification: 'public_feed',
      shopifyConnected: false,
      currency: 'USD',
      skuCount: 1,
      catalogCompletenessAvg: 88,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    },
    ...overrides,
  };
}

function extractSessionCookie(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const m = raw.match(/aixshop_session=([^;]+)/);
    if (m?.[1]) return m[1];
  }
  const single = res.headers.get('set-cookie') || '';
  const m = single.match(/aixshop_session=([^;]+)/);
  return m?.[1] || '';
}

async function startTestServer(repo: MemoryRepository) {
  const app = createApp(repo);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function registerUser(baseUrl: string, email: string, fullName: string) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      email,
      password: 'Password1234!',
      fullName,
      workspaceName: `${fullName} Store`,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const cookieToken = extractSessionCookie(res);
  assert.ok(cookieToken);
  return {
    cookieToken,
    userId: body.user.id as string,
    workspaceId: body.workspace.id as string,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `aixshop_session=${cookieToken}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  };
}

describe('Workstream 5: Guest-to-Cloud Catalog Transfer', () => {
  test('0. Migration 018 SQL defines single-use authorization tables, unique constraints, and audit log', () => {
    const sqlPath = path.resolve(
      process.cwd(),
      'src/server/db/migrations/018_guest_transfer_authorizations.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS guest_transfer_authorizations/i);
    assert.match(sql, /token_hash VARCHAR\(128\) NOT NULL UNIQUE/i);
    assert.match(sql, /UNIQUE\s*\(workspace_id,\s*user_id,\s*idempotency_key\)/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS guest_transfer_audit_log/i);
  });

  test('1. Successful guest-to-cloud transfer of demo and public_feed/manual_import catalogs with evidence, findings, and actions', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startTestServer(repo);
    try {
      const owner = await registerUser(srv.baseUrl, 'ws5_ok@example.com', 'Owner One');

      // Mix of demo seed product (with authentic verified seed doc) and public_feed imported product
      const demoSeedProd = JSON.parse(JSON.stringify(initialProducts[0])) as Product;
      demoSeedProd.sourceClassification = 'demo';
      const feedProd = makeGuestProduct({
        id: 'feed_prod_1',
        title: 'Public Feed Matcha Tin',
        sourceClassification: 'public_feed',
        acquisitionMethod: 'public_products_json_sample',
      });
      const payload = makeGuestPayload({
        products: [demoSeedProd, feedProd],
        variants: [...demoSeedProd.variants, ...feedProd.variants],
        offers: [...demoSeedProd.offers, ...feedProd.offers],
        evidence: [...demoSeedProd.evidenceDocuments, ...feedProd.evidenceDocuments],
        findings: [initialFindings[0], ...makeGuestPayload().findings.map(f => ({ ...f, productId: feedProd.id }))],
        actions: [initialActionItems[0], ...makeGuestPayload().actions.map(a => ({ ...a, productId: feedProd.id }))],
        storeProfile: {
          ...initialStoreProfile,
          name: 'Guest Mixed Store',
          domain: 'guest-mixed.example.com',
          sourceClassification: 'public_feed',
          shopifyConnected: false,
        },
      });

      const authRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          idempotencyKey: 'gt_idem_success_001',
          conflictStrategy: 'abort_on_conflict',
          payload,
        }),
      });
      assert.equal(authRes.status, 200);
      const authBody = await authRes.json();
      assert.equal(authBody.success, true);
      assert.ok(authBody.transferToken);
      assert.equal(authBody.preflight.incomingProductsCount, 2);
      assert.equal(authBody.preflight.conflictsCount, 0);

      const commitRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          transferToken: authBody.transferToken,
          idempotencyKey: 'gt_idem_success_001',
          conflictStrategy: 'abort_on_conflict',
          payload,
        }),
      });
      assert.equal(commitRes.status, 200);
      const commitBody = await commitRes.json();
      assert.equal(commitBody.success, true);
      assert.equal(commitBody.importedCount, 2);
      assert.equal(commitBody.idempotentReplay, false);
      assert.ok(!commitBody.preservedSourceClassifications.includes('shopify_oauth'));

      const catRes = await fetch(`${srv.baseUrl}/api/catalog`, { headers: owner.headers });
      assert.equal(catRes.status, 200);
      const catBody = await catRes.json();
      assert.equal(catBody.workspaceId, owner.workspaceId);
      assert.equal(catBody.catalog.products.length, 2);
      const savedDemo = catBody.catalog.products.find((p: Product) => p.id === demoSeedProd.id);
      const savedFeed = catBody.catalog.products.find((p: Product) => p.id === 'feed_prod_1');
      assert.equal(savedDemo.sourceClassification, 'demo');
      assert.equal(savedFeed.sourceClassification, 'public_feed');
      assert.equal(savedFeed.evidenceDocuments[0].status, 'pending');
      assert.equal(savedFeed.evidenceDocuments[0].externalVerificationStatus, 'not_externally_verified');
      assert.ok(savedFeed.evidenceDocuments[0].integrityHash);
      assert.equal(catBody.catalog.storeProfile.shopifyConnected, false);
      assert.equal(catBody.catalog.storeProfile.sourceClassification, 'public_feed');

      const auditRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/audit-log`, {
        headers: owner.headers,
      });
      assert.equal(auditRes.status, 200);
      const auditBody = await auditRes.json();
      assert.equal(auditBody.entries.length, 1);
      assert.equal(auditBody.entries[0].outcome, 'committed');
      assert.equal(auditBody.entries[0].importedCount, 2);
    } finally {
      await srv.close();
    }
  });

  test('2. Unauthorized, viewer-role, and missing-token attempts are rejected', async () => {
    const repo = new MemoryRepository(false);
    // Inject viewer membership check override for testing viewer RBAC
    const origGetMembership = repo.getMembership.bind(repo);
    let viewerUserId = '';
    repo.getMembership = async (wsId: string, uId: string) => {
      if (viewerUserId && uId === viewerUserId) {
        return {
          id: 'mem_viewer',
          workspaceId: wsId,
          userId: uId,
          role: 'viewer' as any,
          createdAt: new Date().toISOString(),
        };
      }
      return origGetMembership(wsId, uId);
    };

    const srv = await startTestServer(repo);
    try {
      const anonAuth = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ payload: makeGuestPayload() }),
      });
      assert.equal(anonAuth.status, 401);

      const anonCommit = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ transferToken: 'tok', payload: makeGuestPayload() }),
      });
      assert.equal(anonCommit.status, 401);

      const owner = await registerUser(srv.baseUrl, 'ws5_owner@example.com', 'Owner');
      const missingTokenRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ payload: makeGuestPayload() }),
      });
      assert.equal(missingTokenRes.status, 401);
      const missingBody = await missingTokenRes.json();
      assert.equal(missingBody.code, 'TRANSFER_AUTHORIZATION_REQUIRED');

      const viewer = await registerUser(srv.baseUrl, 'ws5_viewer@example.com', 'Viewer');
      viewerUserId = viewer.userId;

      const viewerAuthRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: viewer.headers,
        body: JSON.stringify({ payload: makeGuestPayload() }),
      });
      assert.equal(viewerAuthRes.status, 403);

      const viewerCommitRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: viewer.headers,
        body: JSON.stringify({ transferToken: 'tok', payload: makeGuestPayload() }),
      });
      assert.equal(viewerCommitRes.status, 403);
    } finally {
      await srv.close();
    }
  });

  test('3. Cross-workspace / cross-user token binding and targetWorkspaceId mismatch are rejected with audit entry', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startTestServer(repo);
    try {
      const userA = await registerUser(srv.baseUrl, 'ws5_usera@example.com', 'User A');
      const userB = await registerUser(srv.baseUrl, 'ws5_userb@example.com', 'User B');
      const payload = makeGuestPayload();

      // Explicit targetWorkspaceId mismatch on authorize
      const targetMismatchAuth = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: userA.headers,
        body: JSON.stringify({
          targetWorkspaceId: userB.workspaceId,
          payload,
        }),
      });
      assert.equal(targetMismatchAuth.status, 403);
      assert.equal((await targetMismatchAuth.json()).code, 'TRANSFER_TENANT_MISMATCH');

      // User A creates a valid authorization in Workspace A
      const authRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: userA.headers,
        body: JSON.stringify({
          idempotencyKey: 'gt_cross_tenant_001',
          payload,
        }),
      });
      assert.equal(authRes.status, 200);
      const authBody = await authRes.json();

      // User B tries to redeem User A's token into Workspace B
      const crossCommit = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: userB.headers,
        body: JSON.stringify({
          transferToken: authBody.transferToken,
          idempotencyKey: 'gt_cross_tenant_001',
          payload,
        }),
      });
      assert.equal(crossCommit.status, 403);
      assert.equal((await crossCommit.json()).code, 'TRANSFER_TENANT_MISMATCH');

      // Workspace B catalog remains untouched; Workspace A recorded rejected audit event
      const catB = await (await fetch(`${srv.baseUrl}/api/catalog`, { headers: userB.headers })).json();
      assert.equal(catB.catalog.products.length, 0);

      const auditA = await (
        await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/audit-log`, { headers: userA.headers })
      ).json();
      assert.ok(auditA.entries.some((e: any) => e.outcome === 'rejected'));
    } finally {
      await srv.close();
    }
  });

  test('4. Expired authorization fails with 410 TRANSFER_AUTHORIZATION_EXPIRED and logs audit entry', async () => {
    const repo = new MemoryRepository(false);
    const reg = await repo.registerUser({
      user: { id: 'u_exp', email: 'exp@example.com', passwordHash: 'h', fullName: 'Exp Owner' },
      workspace: { id: 'ws_exp', name: 'Exp', slug: 'exp' },
      session: {
        id: 's_exp',
        sessionTokenHash: 'th_exp',
        userId: 'u_exp',
        activeWorkspaceId: 'ws_exp',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const payload = makeGuestPayload();

    const auth = await authorizeGuestTransfer(repo, {
      userId: reg.user.id,
      workspaceId: reg.workspace.id,
      idempotencyKey: 'gt_expired_test_001',
      payload,
      ttlMs: 1000,
    });

    const stored = await repo.getGuestTransferAuthorizationByIdempotencyKey(
      reg.workspace.id,
      reg.user.id,
      'gt_expired_test_001'
    );
    assert.ok(stored);
    stored.expiresAt = new Date(Date.now() - 5000).toISOString();

    await assert.rejects(
      () =>
        commitGuestTransfer(repo, {
          userId: reg.user.id,
          workspaceId: reg.workspace.id,
          transferToken: auth.transferToken,
          idempotencyKey: 'gt_expired_test_001',
          payload,
        }),
      (err: any) => err.statusCode === 410 && err.code === 'TRANSFER_AUTHORIZATION_EXPIRED'
    );

    const catalog = await repo.loadWorkspaceCatalog(reg.workspace.id);
    assert.equal(catalog?.products.length || 0, 0);
    const audits = await repo.getGuestTransferAuditLog(reg.workspace.id);
    assert.equal(audits[0].outcome, 'expired');
  });

  test('5. Idempotent replay succeeds cleanly without duplicate records, while token reuse with different payload fails 409', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startTestServer(repo);
    try {
      const owner = await registerUser(srv.baseUrl, 'ws5_idem@example.com', 'Idem Owner');
      const payload = makeGuestPayload();

      const authRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          idempotencyKey: 'gt_idem_replay_001',
          payload,
        }),
      });
      assert.equal(authRes.status, 200);
      const authBody = await authRes.json();
      const token = authBody.transferToken;

      const firstCommitRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ transferToken: token, idempotencyKey: 'gt_idem_replay_001', payload }),
      });
      assert.equal(firstCommitRes.status, 200);
      const firstCommit = await firstCommitRes.json();
      assert.equal(firstCommit.idempotentReplay, false);

      // Same token + same payload -> idempotent replay 200, no duplicates
      const replayRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ transferToken: token, idempotencyKey: 'gt_idem_replay_001', payload }),
      });
      assert.equal(replayRes.status, 200);
      const replayBody = await replayRes.json();
      assert.equal(replayBody.idempotentReplay, true);
      assert.equal(replayBody.transferId, firstCommit.transferId);

      // Same idempotencyKey via /authorize returns alreadyCommitted receipt
      const reAuthRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ idempotencyKey: 'gt_idem_replay_001', payload }),
      });
      assert.equal(reAuthRes.status, 200);
      const reAuthBody = await reAuthRes.json();
      assert.equal(reAuthBody.alreadyCommitted, true);
      assert.equal(reAuthBody.receipt.transferId, firstCommit.transferId);

      // Reusing single-use token with modified payload fails 409 TRANSFER_TOKEN_ALREADY_USED
      const modifiedPayload = makeGuestPayload({
        products: [makeGuestProduct({ id: 'guest_prod_2', title: 'Tampered Product' })],
      });
      const reuseRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ transferToken: token, idempotencyKey: 'gt_idem_replay_001', payload: modifiedPayload }),
      });
      assert.equal(reuseRes.status, 409);
      assert.equal((await reuseRes.json()).code, 'TRANSFER_TOKEN_ALREADY_USED');

      // Status endpoint confirms committed receipt
      const statusRes = await fetch(
        `${srv.baseUrl}/api/catalog/guest-transfer/status?idempotencyKey=gt_idem_replay_001`,
        { headers: owner.headers }
      );
      assert.equal(statusRes.status, 200);
      const statusBody = await statusRes.json();
      assert.equal(statusBody.found, true);
      assert.equal(statusBody.status, 'committed');

      const catBody = await (await fetch(`${srv.baseUrl}/api/catalog`, { headers: owner.headers })).json();
      assert.equal(catBody.catalog.products.length, 1);
      assert.equal(catBody.workspaceId, owner.workspaceId);
    } finally {
      await srv.close();
    }
  });

  test('6. Conflict detection and explicit strategies: abort_on_conflict, skip_existing, rename_import', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startTestServer(repo);
    try {
      const owner = await registerUser(srv.baseUrl, 'ws5_conflict@example.com', 'Conflict Owner');

      const cloudProd = makeGuestProduct({
        id: 'cloud_existing_1',
        title: 'Existing Cloud Kettle',
        sourceClassification: 'manual_import',
      });
      cloudProd.variants[0].sku = 'SKU-EXISTING-1';
      await repo.saveWorkspaceCatalog(owner.workspaceId, {
        products: [cloudProd],
        variants: cloudProd.variants,
        offers: cloudProd.offers,
        findings: [],
        actions: [],
        evidence: cloudProd.evidenceDocuments,
        storeProfile: {
          ...initialStoreProfile,
          name: 'Existing Cloud Store',
          domain: 'cloud.example.com',
          sourceClassification: 'manual_import',
          shopifyConnected: false,
        },
      });
      const seededCat = await repo.loadWorkspaceCatalog(owner.workspaceId);
      assert.ok((seededCat?.catalogVersion ?? 0) >= 1);

      const conflictingGuest = makeGuestProduct({
        id: 'cloud_existing_1',
        title: 'Guest Overwrite Kettle',
        sourceClassification: 'public_feed',
      });
      const nonConflictingGuest = makeGuestProduct({
        id: 'guest_new_1',
        title: 'Guest Brand New Mug',
        sourceClassification: 'public_feed',
      });
      const guestPayload = makeGuestPayload({
        products: [conflictingGuest, nonConflictingGuest],
        variants: [...conflictingGuest.variants, ...nonConflictingGuest.variants],
        offers: [...conflictingGuest.offers, ...nonConflictingGuest.offers],
        evidence: [...conflictingGuest.evidenceDocuments, ...nonConflictingGuest.evidenceDocuments],
      });

      // 6a. abort_on_conflict returns 409 and preserves existing cloud store untouched
      const authAbort = await (
        await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
          method: 'POST',
          headers: owner.headers,
          body: JSON.stringify({
            idempotencyKey: 'gt_conflict_abort',
            conflictStrategy: 'abort_on_conflict',
            payload: guestPayload,
          }),
        })
      ).json();
      assert.equal(authAbort.preflight.conflictsCount, 1);

      const commitAbortRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          transferToken: authAbort.transferToken,
          idempotencyKey: 'gt_conflict_abort',
          conflictStrategy: 'abort_on_conflict',
          payload: guestPayload,
        }),
      });
      assert.equal(commitAbortRes.status, 409);
      const commitAbortBody = await commitAbortRes.json();
      assert.equal(commitAbortBody.code, 'GUEST_TRANSFER_CONFLICT');
      assert.equal(commitAbortBody.conflicts.length, 1);

      let cloudCat = await repo.loadWorkspaceCatalog(owner.workspaceId);
      assert.equal(cloudCat?.products.length, 1);
      assert.equal(cloudCat?.products[0].title, 'Existing Cloud Kettle');

      // 6b. skip_existing preserves existing cloud item and imports non-conflicting item
      const authSkip = await (
        await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
          method: 'POST',
          headers: owner.headers,
          body: JSON.stringify({
            idempotencyKey: 'gt_conflict_skip',
            conflictStrategy: 'skip_existing',
            payload: guestPayload,
          }),
        })
      ).json();
      const commitSkipRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          transferToken: authSkip.transferToken,
          idempotencyKey: 'gt_conflict_skip',
          conflictStrategy: 'skip_existing',
          payload: guestPayload,
        }),
      });
      assert.equal(commitSkipRes.status, 200);
      const commitSkip = await commitSkipRes.json();
      assert.equal(commitSkip.importedCount, 1);
      assert.equal(commitSkip.skippedCount, 1);

      cloudCat = await repo.loadWorkspaceCatalog(owner.workspaceId);
      assert.equal(cloudCat?.products.length, 2);
      assert.equal(cloudCat?.products.find(p => p.id === 'cloud_existing_1')?.title, 'Existing Cloud Kettle');

      // 6c. rename_import imports colliding item under new suffixed ID + SKU + valid evidence integrityHash
      const renamePayload = makeGuestPayload({
        products: [
          makeGuestProduct({
            id: 'cloud_existing_1',
            title: 'Guest Rename Kettle',
            sourceClassification: 'public_feed',
          }),
        ],
      });
      const authRename = await (
        await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
          method: 'POST',
          headers: owner.headers,
          body: JSON.stringify({
            idempotencyKey: 'gt_conflict_rename',
            conflictStrategy: 'rename_import',
            payload: renamePayload,
          }),
        })
      ).json();
      const commitRenameRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          transferToken: authRename.transferToken,
          idempotencyKey: 'gt_conflict_rename',
          conflictStrategy: 'rename_import',
          payload: renamePayload,
        }),
      });
      assert.equal(commitRenameRes.status, 200);
      const commitRename = await commitRenameRes.json();
      assert.equal(commitRename.importedCount, 1);
      assert.equal(commitRename.renamedCount, 1);

      cloudCat = await repo.loadWorkspaceCatalog(owner.workspaceId);
      assert.equal(cloudCat?.products.length, 3);
      const renamedProd = cloudCat?.products.find(p => p.title === 'Guest Rename Kettle');
      assert.ok(renamedProd);
      assert.notEqual(renamedProd.id, 'cloud_existing_1');
      assert.ok(renamedProd.evidenceDocuments[0].integrityHash);

      const evLookup = await repo.getEvidenceDocumentById(owner.workspaceId, renamedProd.evidenceDocuments[0].id);
      assert.ok(evLookup);
      const reviewRes = await repo.reviewEvidenceDocument({
        workspaceId: owner.workspaceId,
        evidenceId: renamedProd.evidenceDocuments[0].id,
        decision: 'approved',
        reviewerId: 'platform_rev_1',
        reviewerRole: 'platform_reviewer',
        principalType: 'service_principal',
        authMethod: 'signed_header',
      });
      assert.equal(reviewRes.evidence.status, 'verified');
    } finally {
      await srv.close();
    }
  });

  test('7. Source classification protection & anti-spoofing: blocks forged Shopify OAuth, GTIN exemptions, and self-verified claims; never downgrades Shopify cloud store', async () => {
    const repo = new MemoryRepository(false);
    const srv = await startTestServer(repo);
    try {
      const owner = await registerUser(srv.baseUrl, 'ws5_trust@example.com', 'Trust Owner');

      // Attempt 7a: forged shopify_oauth product classification
      const spoofShopify = makeGuestPayload({
        products: [
          makeGuestProduct({
            id: 'spoof_sh',
            title: 'Fake Shopify',
            sourceClassification: 'shopify_oauth',
            acquisitionMethod: 'shopify_admin_graphql',
          }),
        ],
      });
      const res7a = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ payload: spoofShopify }),
      });
      assert.equal(res7a.status, 403);
      assert.equal((await res7a.json()).code, 'PROTECTED_VERIFICATION_FIELD');

      // Attempt 7b: forged gtinExemptionVerified attribute
      const spoofGtin = makeGuestPayload({
        products: [
          makeGuestProduct({
            id: 'spoof_gtin',
            title: 'Fake GTIN',
            attributes: { gtinExemptionVerified: 'true' },
          }),
        ],
      });
      const res7b = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ payload: spoofGtin }),
      });
      assert.equal(res7b.status, 403);

      // Attempt 7c: forged external_registry_verified or pre-approved non-seed evidence
      const spoofEv = makeGuestPayload();
      spoofEv.products[0].evidenceDocuments[0].status = 'verified';
      spoofEv.products[0].evidenceDocuments[0].externalVerificationStatus = 'external_registry_verified';
      const res7c = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ payload: spoofEv }),
      });
      assert.equal(res7c.status, 403);

      // Attempt 7d: importing guest items into an already Shopify-OAuth connected cloud store preserves store's shopify_oauth & shopifyConnected=true
      await repo.saveWorkspaceCatalog(owner.workspaceId, {
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: {
          ...initialStoreProfile,
          name: 'Genuine Shopify Store',
          domain: 'genuine-merchant.myshopify.com',
          sourceClassification: 'shopify_oauth',
          shopifyConnected: true,
          shopifyShopDomain: 'genuine-merchant.myshopify.com',
        },
      });
      const validGuest = makeGuestPayload();
      const authValidRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/authorize`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ idempotencyKey: 'gt_preserve_shopify_store', payload: validGuest }),
      });
      assert.equal(authValidRes.status, 200);
      const authValid = await authValidRes.json();

      const commitValidRes = await fetch(`${srv.baseUrl}/api/catalog/guest-transfer/commit`, {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({
          transferToken: authValid.transferToken,
          idempotencyKey: 'gt_preserve_shopify_store',
          payload: validGuest,
        }),
      });
      assert.equal(commitValidRes.status, 200);

      const finalCat = await repo.loadWorkspaceCatalog(owner.workspaceId);
      assert.equal(finalCat?.storeProfile.shopifyConnected, true);
      assert.equal(finalCat?.storeProfile.sourceClassification, 'shopify_oauth');
      assert.equal(finalCat?.products[0].sourceClassification, 'public_feed');
    } finally {
      await srv.close();
    }
  });

  test('8. Atomic rollback on persistence failure in MemoryRepository AND mock PostgresRepository transaction', async () => {
    const memRepo = new MemoryRepository(false);
    const reg = await memRepo.registerUser({
      user: { id: 'u_rb', email: 'rb@example.com', passwordHash: 'h', fullName: 'RB Owner' },
      workspace: { id: 'ws_rb', name: 'RB', slug: 'rb' },
      session: {
        id: 's_rb',
        sessionTokenHash: 'th_rb',
        userId: 'u_rb',
        activeWorkspaceId: 'ws_rb',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const payload = makeGuestPayload();
    const auth = await authorizeGuestTransfer(memRepo, {
      userId: reg.user.id,
      workspaceId: reg.workspace.id,
      idempotencyKey: 'gt_rollback_mem_001',
      payload,
    });

    await assert.rejects(() =>
      memRepo.commitGuestTransferAtomic({
        authorizationId: auth.transferId,
        workspaceId: reg.workspace.id,
        userId: reg.user.id,
        payloadSha256: auth.payloadSha256,
        conflictStrategy: 'abort_on_conflict',
        guestPayload: payload,
        buildMergedCatalog: () => {
          throw new Error('Injected partial persistence crash');
        },
      })
    );

    const catAfterFail = await memRepo.loadWorkspaceCatalog(reg.workspace.id);
    assert.equal(catAfterFail?.products.length || 0, 0);
    const authAfterFail = await memRepo.getGuestTransferAuthorizationByIdempotencyKey(
      reg.workspace.id,
      reg.user.id,
      'gt_rollback_mem_001'
    );
    assert.equal(authAfterFail?.status, 'pending');

    // Retry succeeds cleanly after transient failure
    const retryCommit = await commitGuestTransfer(memRepo, {
      userId: reg.user.id,
      workspaceId: reg.workspace.id,
      transferToken: auth.transferToken,
      idempotencyKey: 'gt_rollback_mem_001',
      payload,
    });
    assert.equal(retryCommit.success, true);
    assert.equal((await memRepo.loadWorkspaceCatalog(reg.workspace.id))?.products.length, 1);

    // 8b. PostgresRepository transaction rollback (BEGIN -> fail on audit insert -> ROLLBACK)
    const executedSql: string[] = [];
    const expiresAtFuture = new Date(Date.now() + 60_000).toISOString();
    const mockClient = {
      query: async (sql: string) => {
        executedSql.push(sql.trim());
        if (sql.includes('FROM guest_transfer_authorizations WHERE id =')) {
          return {
            rows: [
              {
                id: 'gtr_pg_1',
                workspace_id: 'ws_pg_1',
                user_id: 'u_pg_1',
                token_hash: 'hash_1',
                idempotency_key: 'idem_pg_1',
                payload_sha256: 'sha_pg_1',
                conflict_strategy: 'abort_on_conflict',
                status: 'pending',
                expires_at: expiresAtFuture,
                committed_at: null,
                result_summary_json: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes('FROM stores WHERE workspace_id =')) {
          return {
            rows: [
              {
                id: 'store_ws_pg_1',
                tier: 'Free Audit',
                sku_limit: null,
                name: 'PG Store',
                domain: '',
                website_url: '',
                platform: null,
                source_classification: 'unconfigured',
                source_metadata_json: '{}',
                shopify_connected: false,
                shopify_shop_domain: null,
                currency: 'USD',
                sku_count: 0,
                catalog_completeness_avg: 0,
                truth_boundary_strictness: 'standard',
                connectors_json: '[]',
                catalog_version: 1,
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO guest_transfer_audit_log')) {
          throw new Error('Injected Postgres failure on audit insert');
        }
        return { rows: [{ catalog_version: 2 }], rowCount: 1 };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
      query: async (sql: string) => mockClient.query(sql),
    } as unknown as Pool;

    const pgRepo = new PostgresRepository(mockPool);
    await assert.rejects(
      () =>
        pgRepo.commitGuestTransferAtomic({
          authorizationId: 'gtr_pg_1',
          workspaceId: 'ws_pg_1',
          userId: 'u_pg_1',
          payloadSha256: 'sha_pg_1',
          conflictStrategy: 'abort_on_conflict',
          guestPayload: payload,
          buildMergedCatalog: ({ authoritativeStore }) => ({
            mergedPayload: {
              ...payload,
              storeProfile: authoritativeStore,
            },
            summary: {
              success: true,
              transferId: 'gtr_pg_1',
              workspaceId: 'ws_pg_1',
              idempotentReplay: false,
              status: 'committed',
              conflictStrategy: 'abort_on_conflict',
              importedCount: 1,
              skippedCount: 0,
              renamedCount: 0,
              conflicts: [],
              totalWorkspaceProducts: 1,
              totalWorkspaceSkus: 1,
              preservedSourceClassifications: ['public_feed'],
              committedAt: new Date().toISOString(),
            },
            importedCount: 1,
            skippedCount: 0,
            conflictsCount: 0,
          }),
        }),
      /Injected Postgres failure on audit insert/
    );

    assert.ok(executedSql.includes('BEGIN'));
    assert.ok(executedSql.includes('ROLLBACK'), 'Postgres transaction must issue ROLLBACK on partial failure');
    assert.ok(!executedSql.includes('COMMIT'), 'Must NOT COMMIT rolled-back transaction');
  });
});
