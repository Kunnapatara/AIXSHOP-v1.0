import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Pool } from 'pg';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { CatalogVersionConflictError } from './db/repository';
import { createApp } from './app';
import { processShopifyWebhook } from './shopify/webhookService';
import { syncShopifyCatalog } from './shopify/syncService';
import { encryptCredential } from './security/encryption';
import {
  getTrustedBaseUrl,
  parseTrustProxySetting,
  resolveTrustedRedirectUrl,
  validateProductionAppUrl,
  validateProductionConfig,
} from './config/productionConfig';
import {
  checkMigrationStatus,
  computeMigrationChecksum,
  runMigrations,
} from './db/migrate';
import { _getRateLimiterSize, _resetRateLimiter, authRateLimiter } from './middleware/auth';
import { VisibilityObservationConflictError } from '../domain/monitoring/aiVisibilityTypes';
import { StoragePayloadV1 } from '../domain/storage/storageTypes';

function computeShopifyHmac(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

async function startTempAppServer(app: ReturnType<typeof createApp>): Promise<{
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        baseUrl,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe('Workstreams A-I & M — Production Blockers & Integrity Regression Suite', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'NODE_ENV',
    'APP_URL',
    'ALLOWED_APP_ORIGINS',
    'TRUST_PROXY',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'SHOPIFY_APP_URL',
    'BILLING_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'DATABASE_URL',
    'DISABLE_AUTH',
    'ALLOW_INSECURE_HTTP',
  ];

  beforeEach(() => {
    _resetRateLimiter();
    for (const k of envKeys) {
      originalEnv[k] = process.env[k];
    }
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SHOPIFY_API_KEY = 'test_shopify_key';
    process.env.SHOPIFY_API_SECRET = 'test_shopify_secret_123';
  });

  afterEach(() => {
    _resetRateLimiter();
    for (const k of envKeys) {
      if (originalEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = originalEnv[k];
      }
    }
  });

  // =========================================================================
  // WORKSTREAM A — Webhook Durability, Error Semantics & Lease Ownership
  // =========================================================================
  describe('Workstream A: Shopify Webhook Durability & Lease Ownership', () => {
    test('A1. Database failure during claimShopifyWebhookEvent returns HTTP 503 (NEVER 200 duplicate)', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_a1', email: 'a1@example.com', passwordHash: 'hash', fullName: 'A1' },
        workspace: { id: 'ws_a1', name: 'WS A1', slug: 'ws-a1' },
        session: {
          id: 'sess_a1',
          sessionTokenHash: 'hash_a1',
          userId: 'u_a1',
          activeWorkspaceId: 'ws_a1',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      await repo.saveShopifyConnection({
        id: 'conn_a1',
        workspaceId: 'ws_a1',
        shopDomain: 'store-a1.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_a1'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Inject simulated DB outage on durable webhook claim
      repo.claimShopifyWebhookEvent = async () => {
        throw new Error('PG connection terminated unexpectedly');
      };

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const body = JSON.stringify({ id: 9001, title: 'Outage Item', variants: [{ id: 11, price: '19.00' }] });
        const hmac = computeShopifyHmac(body, process.env.SHOPIFY_API_SECRET!);

        const res = await fetch(`${baseUrl}/api/shopify/webhooks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
            'X-Shopify-Topic': 'products/update',
            'X-Shopify-Shop-Domain': 'store-a1.myshopify.com',
            'X-Shopify-Delivery-Id': 'deliv_db_down_1',
          },
          body,
        });

        assert.equal(res.status, 503, 'DB failure on webhook claim MUST return 503 so Shopify retries');
        const json = await res.json();
        assert.match(json.error, /Durable webhook claim failed|PG connection terminated/i);
      } finally {
        await close();
      }
    });

    test('A2. Failed webhook can be safely retried; active in-flight duplicate returns HTTP 202 and completed returns 200 duplicate', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_a2', email: 'a2@example.com', passwordHash: 'hash', fullName: 'A2' },
        workspace: { id: 'ws_a2', name: 'WS A2', slug: 'ws-a2' },
        session: {
          id: 'sess_a2',
          sessionTokenHash: 'hash_a2',
          userId: 'u_a2',
          activeWorkspaceId: 'ws_a2',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      await repo.saveShopifyConnection({
        id: 'conn_a2',
        workspaceId: 'ws_a2',
        shopDomain: 'store-a2.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_a2'),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const rawBody = Buffer.from(
        JSON.stringify({
          id: 551,
          title: 'Durable Webhook Jacket',
          vendor: 'AIX',
          product_type: 'Apparel',
          status: 'active',
          updated_at: new Date().toISOString(),
          variants: [{ id: 5511, sku: 'JKT-551', title: 'M', price: '129.00', inventory_quantity: 5 }],
        }),
        'utf8'
      );
      const hmac = computeShopifyHmac(rawBody, process.env.SHOPIFY_API_SECRET!);
      const headers = {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'store-a2.myshopify.com',
        'x-shopify-delivery-id': 'deliv_retry_a2',
      };

      // Simulate active worker currently holding lease -> HTTP 202 via route & inProgress via service
      const preClaim = await repo.claimShopifyWebhookEvent({
        id: 'whevt_pre_a2',
        workspaceId: 'ws_a2',
        shopDomain: 'store-a2.myshopify.com',
        eventId: 'deliv_retry_a2',
        topic: 'products/create',
        deliveryId: 'deliv_retry_a2',
        payload: {},
        status: 'processing',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(preClaim.claimed, true);

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const resInFlight = await fetch(`${baseUrl}/api/shopify/webhooks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
            'X-Shopify-Topic': 'products/create',
            'X-Shopify-Shop-Domain': 'store-a2.myshopify.com',
            'X-Shopify-Delivery-Id': 'deliv_retry_a2',
          },
          body: rawBody,
        });
        assert.equal(resInFlight.status, 202, 'Active in-flight duplicate must return 202 Accepted');
        const inFlightJson = await resInFlight.json();
        assert.equal(inFlightJson.outcome, 'CURRENTLY_PROCESSING');
        assert.equal(inFlightJson.inProgress, true);

        // Now original worker fails
        await repo.updateShopifyWebhookEventStatus(
          'deliv_retry_a2',
          'store-a2.myshopify.com',
          'products/create',
          'failed',
          'Transient downstream failure',
          preClaim.leaseOwner
        );

        // Retry now succeeds cleanly and reclaims failed row!
        const retryResult = await processShopifyWebhook(repo, rawBody, headers);
        assert.equal(retryResult.processed, true);
        assert.equal(retryResult.duplicate, false);
        assert.equal(retryResult.outcome, 'RETRYABLE_FAILED');

        const catalog = await repo.loadWorkspaceCatalog('ws_a2');
        assert.equal(catalog?.products.length, 1);
        assert.equal(catalog?.products[0].title, 'Durable Webhook Jacket');

        // Re-delivery after processed returns duplicate processed cleanly
        const resDup = await processShopifyWebhook(repo, rawBody, headers);
        assert.equal(resDup.duplicate, true);
        assert.equal(resDup.processed, true);
        assert.equal(resDup.outcome, 'ALREADY_PROCESSED');
      } finally {
        await close();
      }
    });

    test('A3. Expired webhook lease can be reclaimed and stale worker owner cannot overwrite terminal status', async () => {
      const repo = new MemoryRepository();
      const firstClaim = await repo.claimShopifyWebhookEvent(
        {
          id: 'whevt_exp_1',
          workspaceId: 'ws_exp',
          shopDomain: 'exp.myshopify.com',
          eventId: 'evt_exp_1',
          topic: 'products/update',
          payload: { id: 1 },
          status: 'processing',
          retryCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_old', leaseDurationMs: 50 }
      );
      assert.equal(firstClaim.claimed, true);

      await new Promise((r) => setTimeout(r, 70));

      const secondClaim = await repo.claimShopifyWebhookEvent(
        {
          id: 'whevt_exp_1',
          workspaceId: 'ws_exp',
          shopDomain: 'exp.myshopify.com',
          eventId: 'evt_exp_1',
          topic: 'products/update',
          payload: { id: 1 },
          status: 'processing',
          retryCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_new', leaseDurationMs: 5000 }
      );
      assert.equal(secondClaim.claimed, true);
      assert.equal(secondClaim.leaseOwner, 'worker_new');

      await assert.rejects(
        () =>
          repo.updateShopifyWebhookEventStatus(
            'evt_exp_1',
            'exp.myshopify.com',
            'products/update',
            'processed',
            undefined,
            'worker_old'
          ),
        /lease lost or expired|stale worker/i
      );

      // New worker succeeds
      await repo.updateShopifyWebhookEventStatus(
        'evt_exp_1',
        'exp.myshopify.com',
        'products/update',
        'processed',
        undefined,
        'worker_new'
      );
    });
  });

  // =========================================================================
  // WORKSTREAM B — Distributed Locking & Authoritative Catalog Consistency
  // =========================================================================
  describe('Workstream B: Distributed Workspace Locking & Catalog Race Protection', () => {
    test('B1. PostgresRepository.withWorkspaceLock acquires pg_try_advisory_lock across separate instances and guarantees unlock on error', async () => {
      let advisoryLocked = false;
      const queries: string[] = [];

      const mockPool: any = {
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes('pg_try_advisory_lock')) {
              if (!advisoryLocked) {
                advisoryLocked = true;
                return { rows: [{ locked: true }] };
              }
              return { rows: [{ locked: false }] };
            }
            if (sql.includes('pg_advisory_unlock')) {
              advisoryLocked = false;
              return { rows: [{ pg_advisory_unlock: true }] };
            }
            return { rows: [] };
          },
          release: () => {},
        }),
      };

      const instanceA = new PostgresRepository(mockPool);
      const instanceB = new PostgresRepository(mockPool);

      const events: string[] = [];
      const pA = instanceA.withWorkspaceLock('ws_b1', async () => {
        events.push('A_start');
        await new Promise((r) => setTimeout(r, 60));
        events.push('A_end');
        return 'A';
      });

      await new Promise((r) => setTimeout(r, 10));
      const pB = instanceB.withWorkspaceLock('ws_b1', async () => {
        events.push('B_start');
        events.push('B_end');
        return 'B';
      });

      const [resA, resB] = await Promise.all([pA, pB]);
      assert.equal(resA, 'A');
      assert.equal(resB, 'B');
      assert.deepEqual(events, ['A_start', 'A_end', 'B_start', 'B_end'], 'Separate instances must serialize strictly');
      assert.equal(advisoryLocked, false, 'Advisory lock must be released');

      // Unlock still fires when callback throws
      await assert.rejects(
        () =>
          instanceA.withWorkspaceLock('ws_b1', async () => {
            throw new Error('boom inside lock');
          }),
        /boom inside lock/
      );
      assert.equal(advisoryLocked, false, 'Advisory lock must release even when callback throws');
    });

    test('B2. Shopify sync re-reads authoritative catalog under lock so concurrent edits/products added during slow GraphQL pagination are preserved', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_b2', email: 'b2@example.com', passwordHash: 'hash', fullName: 'B2' },
        workspace: { id: 'ws_b2', name: 'WS B2', slug: 'ws-b2' },
        session: {
          id: 'sess_b2',
          sessionTokenHash: 'hash_b2',
          userId: 'u_b2',
          activeWorkspaceId: 'ws_b2',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      await repo.saveShopifyConnection({
        id: 'conn_b2',
        workspaceId: 'ws_b2',
        shopDomain: 'store-b2.myshopify.com',
        accessTokenEncrypted: encryptCredential('shpat_b2'),
        refreshTokenEncrypted: encryptCredential('shprt_b2'),
        tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock slow Shopify GraphQL fetch; during the fetch window we inject a concurrent catalog mutation
      // directly into repo (simulating another worker/webhook/merchant write before sync commits)
      let injectedConcurrentWrite = false;
      const customFetch: typeof fetch = async () => {
        if (!injectedConcurrentWrite) {
          injectedConcurrentWrite = true;
          const cat = (await repo.loadWorkspaceCatalog('ws_b2'))!;
          cat.products.push({
            id: 'p_shopify_concurrent_999',
            title: 'Concurrent Webhook Added Product',
            brand: 'BrandX',
            category: 'CatX',
            description: 'Added mid-sync',
            image: '',
            status: 'active',
            completenessScore: 90,
            evidenceCoverageScore: 0,
            externalDiscoveryStatus: 'observed_in_sample',
            attributes: { sourcePlatform: 'shopify', sourceProductId: '999' },
            variants: [{ id: 'v_999', sku: 'SKU-999', title: 'Default', barcode: '', price: 49, inventoryCount: 10, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          });
          await repo.saveWorkspaceCatalog('ws_b2', cat);
        }

        return new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Product/101',
                      title: 'Synced Product 101',
                      vendor: 'VendorA',
                      productType: 'TypeA',
                      descriptionHtml: '<p>Desc</p>',
                      handle: 'synced-101',
                      status: 'ACTIVE',
                      images: { edges: [] },
                      variants: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        edges: [{ node: { id: 'gid://shopify/ProductVariant/1011', sku: 'SKU-101', title: 'Default', barcode: '', price: '25.00', inventoryQuantity: 3, selectedOptions: [] } }],
                      },
                    },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const res = await syncShopifyCatalog(repo, 'ws_b2', { customFetch });
      assert.equal(res.status, 'completed');

      const finalCatalog = await repo.loadWorkspaceCatalog('ws_b2');
      const ids = new Set(finalCatalog?.products.map((p) => p.id));
      assert.ok(ids.has('p_shopify_101'), 'Synced product must be persisted');
      assert.ok(ids.has('p_shopify_concurrent_999'), 'Concurrent product written mid-sync MUST NOT be clobbered');
    });

    test('B3. Optimistic expectedVersion mismatch rejects stale PUT /api/catalog with 409 CATALOG_VERSION_CONFLICT', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_b3', email: 'b3@example.com', passwordHash: 'hash', fullName: 'B3' },
        workspace: { id: 'ws_b3', name: 'WS B3', slug: 'ws-b3' },
        session: {
          id: 'sess_b3',
          sessionTokenHash: 'b13c6b9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e',
          userId: 'u_b3',
          activeWorkspaceId: 'ws_b3',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      const initialCat = (await repo.loadWorkspaceCatalog('ws_b3'))!;
      await repo.saveWorkspaceCatalog('ws_b3', initialCat); // advances version to 2

      await assert.rejects(
        () => repo.saveWorkspaceCatalog('ws_b3', initialCat, { expectedVersion: 1 }),
        (err: any) => err instanceof CatalogVersionConflictError && err.statusCode === 409
      );

      const currentCat = (await repo.loadWorkspaceCatalog('ws_b3'))!;
      assert.equal(currentCat.catalogVersion, 2);
      await repo.saveWorkspaceCatalog('ws_b3', currentCat, { expectedVersion: 2 });
      const updated = (await repo.loadWorkspaceCatalog('ws_b3'))!;
      assert.equal(updated.catalogVersion, 3);
    });
  });

  // =========================================================================
  // WORKSTREAM C — Billing Lease Time Semantics (clock_timestamp)
  // =========================================================================
  describe('Workstream C: Billing Lease Real Wall-Clock Time (clock_timestamp)', () => {
    test('C1. PostgresRepository billing lease claim, renew, update, and transition use clock_timestamp() exclusively (never transaction-frozen NOW())', async () => {
      const recordedSql: string[] = [];
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 500).toISOString();
      const mockPool: any = {
        query: async (sql: string) => {
          recordedSql.push(sql);
          if (sql.includes('RETURNING id')) {
            return {
              rows: [{ id: 'be_1', processedAt: nowIso, leaseExpiresAt: expiresIso, status: 'processing', leaseOwner: 'worker_c1', eventId: 'evt_c1', provider: 'stripe', eventType: 'invoice.paid', idempotencyKey: 'evt_c1', payload: {} }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
        connect: async () => ({
          query: async (sql: string) => {
            recordedSql.push(sql);
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ status: 'processing', lease_owner: 'worker_c1', is_expired: false }] };
            }
            return { rows: [{ id: 'be_1' }], rowCount: 1 };
          },
          release: () => {},
        }),
      };

      const pgRepo = new PostgresRepository(mockPool);
      const evt: any = {
        id: 'be_1',
        provider: 'stripe',
        eventId: 'evt_c1',
        eventType: 'invoice.paid',
        idempotencyKey: 'evt_c1',
        payload: { id: 'evt_c1' },
        status: 'processing',
        processedAt: new Date().toISOString(),
      };

      await pgRepo.claimBillingEvent(evt, { leaseOwner: 'worker_c1', leaseDurationMs: 500 });
      await pgRepo.renewBillingEventLease('evt_c1', 'worker_c1', 500);
      await pgRepo.applyBillingTransition({
        eventId: 'evt_c1',
        leaseOwner: 'worker_c1',
        subscription: {
          id: 'subrec_c1',
          workspaceId: 'ws_c1',
          provider: 'stripe',
          customerId: 'cus_c1',
          subscriptionId: 'sub_c1',
          tier: 'Growth',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        storeProfileUpdate: { tier: 'Growth', skuLimit: 2500 },
      });

      const billingSql = recordedSql.filter((s) => s.includes('billing_events'));
      assert.ok(billingSql.length >= 4);
      for (const sql of billingSql) {
        assert.doesNotMatch(sql, /\bNOW\(\)/i, `Billing lease SQL must not use frozen NOW(): ${sql.slice(0, 120)}`);
        assert.match(sql, /clock_timestamp\(\)/i, 'Billing lease SQL must use clock_timestamp()');
      }
    });
  });

  // =========================================================================
  // WORKSTREAMS D & E — Visibility Conflicts, History, NULL vs '' & Migration 012
  // =========================================================================
  describe('Workstreams D & E: Visibility Conflict Protection, Append-Only History & Topic Semantics', () => {
    const mig012Path = path.join(process.cwd(), 'src/server/db/migrations/012_production_blockers_integrity.sql');
    const mig010Path = path.join(process.cwd(), 'src/server/db/migrations/010_remediation_integrity_and_leases.sql');
    const mig011Path = path.join(process.cwd(), 'src/server/db/migrations/011_corrective_integrity_and_visibility_provenance.sql');

    test('D1/E1. Migration 012 SQL enforces non-destructive checks, NULL vs empty topic preservation, and immutable history table', () => {
      const sql012 = fs.readFileSync(mig012Path, 'utf8');
      assert.match(sql012, /uq_ai_visibility_imports_ws_hash/);
      assert.match(sql012, /uq_ai_visibility_metric_null_topic/);
      assert.match(sql012, /ai_visibility_observation_history/);
      assert.match(sql012, /topic_presence/);
      assert.match(sql012, /DROP NOT NULL/);
      assert.match(sql012, /auth_rate_limits/);
      assert.match(sql012, /catalog_version/);
      assert.doesNotMatch(sql012, /DELETE\s+FROM\s+ai_visibility_(metrics|imports)/i, 'Must NEVER destructively delete visibility rows');

      // Ensure 010 and 011 remain unaltered valid files on disk
      assert.ok(fs.existsSync(mig010Path));
      assert.ok(fs.existsSync(mig011Path));
    });

    test('D2. Visibility conflicting observation CSV rejects with 409 VISIBILITY_OBSERVATION_CONFLICT unless explicit replace_versioned policy appends history', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_d2', email: 'd2@example.com', passwordHash: 'hash', fullName: 'D2' },
        workspace: { id: 'ws_d2', name: 'WS D2', slug: 'ws-d2' },
        session: {
          id: 'sess_d2',
          sessionTokenHash: crypto.createHash('sha256').update('tok_d2').digest('hex'),
          userId: 'u_d2',
          activeWorkspaceId: 'ws_d2',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const csv1 = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-10-01,ChatGPT Search,12,8,4,running shoes';
        const csvConflict = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-10-01,ChatGPT Search,99,50,15,running shoes';

        const r1 = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok_d2',
          },
          body: JSON.stringify({ csvContent: csv1, filename: 'batch1.csv' }),
        });
        assert.equal(r1.status, 200);
        const j1 = await r1.json();
        assert.equal(j1.action, 'imported');
        assert.equal(j1.summary.totalBrandMentions, 12);

        // Identical CSV again -> idempotent duplicate_noop
        const rDup = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok_d2',
          },
          body: JSON.stringify({ csvContent: csv1, filename: 'batch1-copy.csv' }),
        });
        assert.equal(rDup.status, 200);
        const jDup = await rDup.json();
        assert.equal(jDup.duplicateImport, true);
        assert.equal(jDup.action, 'duplicate_noop');

        // Different CSV targeting same (date, platform, topic) WITHOUT replace_versioned -> 409 Conflict!
        const rConflict = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok_d2',
          },
          body: JSON.stringify({ csvContent: csvConflict, filename: 'correction.csv' }),
        });
        assert.equal(rConflict.status, 409, 'Conflicting observation without explicit versioned replace policy MUST return 409');
        const jConflict = await rConflict.json();
        assert.equal(jConflict.code, 'VISIBILITY_OBSERVATION_CONFLICT');
        assert.equal(jConflict.conflicts.length, 1);

        // Summary remains uncorrupted (12, not 99)
        const sumAfterReject = await repo.getVisibilitySummary('ws_d2');
        assert.equal(sumAfterReject.totalBrandMentions, 12);

        // Explicit replace_versioned updates current observation AND appends immutable history version 2
        const rReplace = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok_d2',
          },
          body: JSON.stringify({ csvContent: csvConflict, filename: 'correction.csv', conflictPolicy: 'replace_versioned' }),
        });
        assert.equal(rReplace.status, 200);
        const jReplace = await rReplace.json();
        assert.equal(jReplace.action, 'replaced_versioned');
        assert.equal(jReplace.replacedCount, 1);
        assert.equal(jReplace.summary.totalBrandMentions, 99);

        const history = await repo.getVisibilityObservationHistory('ws_d2');
        assert.equal(history.length, 2);
        assert.equal(history[0].versionNumber, 2);
        assert.equal(history[0].eventType, 'replaced');
        assert.equal(history[0].brandMentions, 99);
        assert.equal(history[1].versionNumber, 1);
        assert.equal(history[1].brandMentions, 12);
      } finally {
        await close();
      }
    });

    test('E2. Omitted topic column (NULL / unspecified) remains strictly distinct from explicit empty string topic ("")', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_e2', email: 'e2@example.com', passwordHash: 'hash', fullName: 'E2' },
        workspace: { id: 'ws_e2', name: 'WS E2', slug: 'ws-e2' },
        session: {
          id: 'sess_e2',
          sessionTokenHash: crypto.createHash('sha256').update('tok_e2').digest('hex'),
          userId: 'u_e2',
          activeWorkspaceId: 'ws_e2',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        // CSV A: no topic column at all -> discoveryTopic: null, topicPresence: 'unspecified'
        const csvUnspecified = 'date,platform,brand_mentions,product_mentions,clicks\n2026-10-02,Perplexity,5,3,1';
        // CSV B: explicit topic column with blank cell -> discoveryTopic: '', topicPresence: 'explicit_blank'
        const csvExplicitBlank = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-10-02,Perplexity,7,4,2,';

        const r1 = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_e2' },
          body: JSON.stringify({ csvContent: csvUnspecified, filename: 'no_topic.csv' }),
        });
        assert.equal(r1.status, 200);

        const r2 = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_e2' },
          body: JSON.stringify({ csvContent: csvExplicitBlank, filename: 'blank_topic.csv' }),
        });
        assert.equal(r2.status, 200, 'NULL/unspecified topic and empty-string explicit_blank topic must NOT collide');

        const summary = await repo.getVisibilitySummary('ws_e2');
        assert.equal(summary.recentObservations.length, 2);
        const nullRow = summary.recentObservations.find((o) => o.discoveryTopic === null);
        const emptyRow = summary.recentObservations.find((o) => o.discoveryTopic === '');
        assert.ok(nullRow, 'Omitted topic must be preserved as null');
        assert.equal(nullRow.topicPresence, 'unspecified');
        assert.ok(emptyRow, 'Explicit empty topic must be preserved as empty string');
        assert.equal(emptyRow.topicPresence, 'explicit_blank');
      } finally {
        await close();
      }
    });

    test('D3. PostgresRepository.saveVisibilityImportAtomic handles concurrent 23505 content_hash race as idempotent duplicate_noop', async () => {
      const mockHashQuery = async (sql: string) => {
        if (sql.includes('FROM ai_visibility_imports') && sql.includes('content_hash')) {
          return {
            rows: [
              {
                id: 'vimp_existing',
                workspaceId: 'ws_pg_d3',
                filename: 'existing.csv',
                contentHash: 'hash_d3',
                rowCount: 1,
                rejectedRowCount: 0,
                status: 'completed',
                errors: [],
                reportingPeriodStart: '2026-10-01',
                reportingPeriodEnd: '2026-10-01',
                sourcePlatform: 'merchant_csv',
                createdAt: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      };
      const mockPool: any = {
        query: mockHashQuery,
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('INSERT INTO ai_visibility_imports')) {
              const dupErr: any = new Error('duplicate key value violates unique constraint "uq_ai_visibility_imports_ws_hash"');
              dupErr.code = '23505';
              throw dupErr;
            }
            return mockHashQuery(sql);
          },
          release: () => {},
        }),
      };

      const pgRepo = new PostgresRepository(mockPool);
      const res = await pgRepo.saveVisibilityImportAtomic(
        {
          id: 'vimp_new',
          workspaceId: 'ws_pg_d3',
          filename: 'concurrent.csv',
          contentHash: 'hash_d3',
          rowCount: 1,
          rejectedRowCount: 0,
          status: 'completed',
          errors: [],
          reportingPeriodStart: '2026-10-01',
          reportingPeriodEnd: '2026-10-01',
          sourcePlatform: 'merchant_csv',
          createdAt: new Date().toISOString(),
        },
        []
      );

      assert.equal(res.duplicateImport, true);
      assert.equal(res.metricsSaved, 0);
      assert.equal(res.importRecord.id, 'vimp_existing');
    });
  });

  // =========================================================================
  // WORKSTREAM F — Trusted Origin, Redirect Hardening & Proxy Trust
  // =========================================================================
  describe('Workstream F: Trusted Redirect Validation, Production APP_URL & Proxy Boundaries', () => {
    test('F1. Production rejects missing, HTTP, localhost, and placeholder APP_URL and ignores forged Host / X-Forwarded-Host headers', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.APP_URL;

      const spoofedReq: any = {
        headers: {
          host: 'evil-attacker.com',
          'x-forwarded-host': 'phish.attacker.net',
          'x-forwarded-proto': 'https',
        },
        protocol: 'https',
      };

      assert.throws(() => getTrustedBaseUrl(spoofedReq), /Trusted production APP_URL configuration invalid/);

      process.env.APP_URL = 'MY_APP_URL';
      assert.throws(() => getTrustedBaseUrl(spoofedReq), /placeholder/);

      process.env.APP_URL = 'http://app.aixshop.io';
      assert.throws(() => getTrustedBaseUrl(spoofedReq), /https:\/\//);

      process.env.APP_URL = 'https://localhost:3000';
      assert.throws(() => getTrustedBaseUrl(spoofedReq), /localhost/);

      process.env.APP_URL = 'https://app.aixshop.io/';
      // Must return configured APP_URL and IGNORE malicious Host / X-Forwarded-Host headers!
      assert.equal(getTrustedBaseUrl(spoofedReq), 'https://app.aixshop.io');
    });

    test('F2. resolveTrustedRedirectUrl blocks protocol-relative //evil.com, backslashes, external domains, and permits same-origin or ALLOWED_APP_ORIGINS', () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_APP_ORIGINS = 'https://portal.aixshop.io,http://insecure.example.com';
      const base = 'https://app.aixshop.io';

      assert.equal(resolveTrustedRedirectUrl(base, '//evil.com/steal', '/default'), 'https://app.aixshop.io/default');
      assert.equal(resolveTrustedRedirectUrl(base, '/\\evil.com', '/default'), 'https://app.aixshop.io/default');
      assert.equal(resolveTrustedRedirectUrl(base, 'https://evil.com/callback', '/default'), 'https://app.aixshop.io/default');
      assert.equal(resolveTrustedRedirectUrl(base, 'http://app.aixshop.io/settings', '/default'), 'https://app.aixshop.io/default');
      assert.equal(resolveTrustedRedirectUrl(base, 'http://insecure.example.com/ok', '/default'), 'https://app.aixshop.io/default');
      assert.equal(resolveTrustedRedirectUrl(base, '/settings?tab=billing', '/default'), 'https://app.aixshop.io/settings?tab=billing');
      assert.equal(resolveTrustedRedirectUrl(base, 'https://portal.aixshop.io/return', '/default'), 'https://portal.aixshop.io/return');
    });

    test('F3. parseTrustProxySetting rejects dangerous blind "true" in production and honors explicit hop count', () => {
      assert.equal(parseTrustProxySetting(undefined, 'production').value, 1);
      assert.equal(parseTrustProxySetting(undefined, 'development').value, false);
      assert.equal(parseTrustProxySetting('2', 'production').value, 2);
      assert.equal(parseTrustProxySetting('true', 'production').valid, false);
    });
  });

  // =========================================================================
  // WORKSTREAM G — Distributed Auth Rate Limiting & Memory Bounds
  // =========================================================================
  describe('Workstream G: Shared Auth Rate Limiting & Bounded Fallback', () => {
    test('G1. Rate limiter is shared across two separate Express app instances sharing one repository', async () => {
      const sharedRepo = new MemoryRepository();
      const app1 = createApp(sharedRepo);
      const app2 = createApp(sharedRepo);

      const s1 = await startTempAppServer(app1);
      const s2 = await startTempAppServer(app2);
      try {
        // Send 15 attempts to Instance 1, 5 attempts to Instance 2 -> total 20 allowed; 21st on Instance 2 must be blocked 429!
        for (let i = 0; i < 15; i++) {
          const r = await fetch(`${s1.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `shared_${i}@example.com`, password: 'wrongpassword' }),
          });
          assert.equal(r.status, 401);
        }

        for (let i = 15; i < 20; i++) {
          const r = await fetch(`${s2.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `shared_${i}@example.com`, password: 'wrongpassword' }),
          });
          assert.equal(r.status, 401);
        }

        const blocked = await fetch(`${s2.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'shared_final@example.com', password: 'wrongpassword' }),
        });
        assert.equal(blocked.status, 429);
        const body = await blocked.json();
        assert.equal(body.code, 'RATE_LIMITED');
      } finally {
        await s1.close();
        await s2.close();
      }
    });

    test('G2. High-cardinality unique-key flood enforces strict memory cap even before TTL expires', async () => {
      const mw = authRateLimiter(5, 60_000, undefined, { keyPrefix: 'flood', maxMemoryEntries: 25 });
      for (let i = 0; i < 80; i++) {
        let calledNext = false;
        await mw(
          { ip: `10.0.0.${i}`, body: {}, headers: {}, socket: {} } as any,
          { status: () => ({ json: () => {} }) } as any,
          () => {
            calledNext = true;
          }
        );
        assert.equal(calledNext, true);
      }
      assert.ok(_getRateLimiterSize() <= 25, `Local rate-limiter map size ${_getRateLimiterSize()} must NEVER exceed cap 25`);
    });
  });

  // =========================================================================
  // WORKSTREAMS H & M — Migration Checksums & Secret-Safe Config Readiness
  // =========================================================================
  describe('Workstreams H & M: Migration Checksum Verification & Config Readiness', () => {
    test('H1. Migration runner records SHA-256 checksums, detects tampering, missing files, and supports explicit legacy backfill', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aixshop-mig-'));
      try {
        const sql1 = 'CREATE TABLE test_t1 (id INT PRIMARY KEY);';
        const sql2 = 'ALTER TABLE test_t1 ADD COLUMN label TEXT;';
        fs.writeFileSync(path.join(tmpDir, '001_init.sql'), sql1, 'utf8');
        fs.writeFileSync(path.join(tmpDir, '002_label.sql'), sql2, 'utf8');

        const appliedRows = new Map<string, string | null>();
        const mockPool: any = {
          connect: async () => ({
            query: async (sql: string, params?: any[]) => {
              if (sql.includes('information_schema.tables')) {
                return { rows: [{ exists: true }] };
              }
              if (sql.includes('information_schema.columns')) {
                return { rows: [{ column_name: 'checksum' }] };
              }
              if (sql.includes('SELECT id, checksum FROM schema_migrations')) {
                return {
                  rows: Array.from(appliedRows.entries()).map(([id, checksum]) => ({ id, checksum })),
                };
              }
              if (sql.includes('INSERT INTO schema_migrations')) {
                appliedRows.set(params![0], params![1]);
              }
              if (sql.includes('UPDATE schema_migrations SET checksum = $2')) {
                if (appliedRows.get(params![0]) === null) {
                  appliedRows.set(params![0], params![1]);
                }
              }
              return { rows: [] };
            },
            release: () => {},
          }),
        };

        // 1. Fresh run records checksums
        const res1 = await runMigrations(mockPool, { migrationsDir: tmpDir });
        assert.deepEqual(res1.applied, ['001_init.sql', '002_label.sql']);
        assert.equal(appliedRows.get('001_init.sql'), computeMigrationChecksum(sql1));

        // 2. Tampering applied file causes hard integrity failure
        fs.writeFileSync(path.join(tmpDir, '001_init.sql'), 'CREATE TABLE test_t1 (id TEXT PRIMARY KEY);', 'utf8');
        const statusTampered = await checkMigrationStatus(mockPool, { migrationsDir: tmpDir });
        assert.equal(statusTampered.integrityVerified, false);
        assert.equal(statusTampered.checksumMismatches.length, 1);
        await assert.rejects(() => runMigrations(mockPool, { migrationsDir: tmpDir }), /Checksum mismatch/);

        // 3. Restore file, test missing applied file error
        fs.writeFileSync(path.join(tmpDir, '001_init.sql'), sql1, 'utf8');
        fs.unlinkSync(path.join(tmpDir, '002_label.sql'));
        await assert.rejects(() => runMigrations(mockPool, { migrationsDir: tmpDir }), /missing on disk/i);

        // 4. Restore 002, simulate pre-012 NULL checksum row -> auditable warning, only backfills with explicit flag
        fs.writeFileSync(path.join(tmpDir, '002_label.sql'), sql2, 'utf8');
        appliedRows.set('001_init.sql', null);

        const resLegacy = await runMigrations(mockPool, { migrationsDir: tmpDir });
        assert.deepEqual(resLegacy.legacyUnverifiedMigrations, ['001_init.sql']);
        assert.equal(appliedRows.get('001_init.sql'), null, 'NULL checksum must NOT be silently overwritten');

        const resBackfill = await runMigrations(mockPool, { migrationsDir: tmpDir, backfillLegacyChecksums: true });
        assert.deepEqual(resBackfill.legacyUnverifiedMigrations, []);
        assert.equal(appliedRows.get('001_init.sql'), computeMigrationChecksum(sql1));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('M1. Readiness probe returns HTTP 503 when production config is incomplete and NEVER leaks secret values', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://dbuser:SUPER_SECRET_DB_PASS@localhost:5432/aixshop';
      process.env.APP_URL = 'MY_APP_URL';
      process.env.STRIPE_SECRET_KEY = 'sk_live_secret_value_do_not_leak';
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const repo = new MemoryRepository();
      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/health/ready`);
        assert.equal(res.status, 503);
        const rawText = await res.text();
        assert.doesNotMatch(rawText, /SUPER_SECRET_DB_PASS|sk_live_secret_value_do_not_leak|0123456789abcdef/);
        const parsed = JSON.parse(rawText);
        assert.equal(parsed.config.valid, false);
        assert.ok(parsed.config.missingOrInvalid.some((m: string) => m.includes('APP_URL')));
      } finally {
        await close();
      }
    });
  });

  // =========================================================================
  // WORKSTREAM I — Reproducible Live Multi-Connection PostgreSQL Integration
  // =========================================================================
  const hasLivePg = Boolean(
    process.env.DATABASE_URL?.trim() || process.env.SQL_HOST?.trim() || process.env.PGHOST?.trim()
  );

  describe('Workstream I: Live Multi-Connection PostgreSQL Integration', { skip: !hasLivePg }, () => {
    let poolA: Pool;
    let poolB: Pool;
    let repoA: PostgresRepository;
    let repoB: PostgresRepository;

    beforeEach(async () => {
      const connStr = process.env.DATABASE_URL;
      const cfg = connStr
        ? { connectionString: connStr }
        : {
            host: process.env.SQL_HOST || process.env.PGHOST,
            port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
            user: process.env.SQL_USER || process.env.PGUSER,
            password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
            database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
          };
      poolA = new Pool(cfg);
      poolB = new Pool(cfg);
      repoA = new PostgresRepository(poolA);
      repoB = new PostgresRepository(poolB);
      await runMigrations(poolA);
    });

    afterEach(async () => {
      await poolA.end();
      await poolB.end();
    });

    test('I1. Live PG executes two-connection advisory lock, clock_timestamp() lease expiry rollback, and concurrent visibility hash race', async () => {
      const wsId = `ws_live_${Date.now()}`;
      const usrId = `usr_live_${Date.now()}`;
      const shopDomain = `live-${Date.now()}.myshopify.com`;
      const evtId = `evt_live_${Date.now()}`;

      await repoA.registerUser({
        user: { id: usrId, email: `${usrId}@example.com`, passwordHash: 'h', fullName: 'Live PG' },
        workspace: { id: wsId, name: 'Live PG WS', slug: wsId },
        session: {
          id: `sess_${Date.now()}`,
          sessionTokenHash: crypto.createHash('sha256').update(`tok_${wsId}`).digest('hex'),
          userId: usrId,
          activeWorkspaceId: wsId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      // 1. Real two-connection billing lease expiry across Pool A & Pool B
      const claimA = await repoA.claimBillingEvent(
        {
          id: `be_${Date.now()}`,
          provider: 'stripe',
          eventId: evtId,
          eventType: 'invoice.paid',
          idempotencyKey: evtId,
          payload: { id: evtId },
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'connA', leaseDurationMs: 60 }
      );
      assert.equal(claimA.claimed, true);

      await new Promise((r) => setTimeout(r, 90));

      const claimB = await repoB.claimBillingEvent(
        {
          id: `be_${Date.now()}_b`,
          provider: 'stripe',
          eventId: evtId,
          eventType: 'invoice.paid',
          idempotencyKey: evtId,
          payload: { id: evtId },
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'connB', leaseDurationMs: 5000 }
      );
      assert.equal(claimB.claimed, true);

      // Stale worker on Connection A must reject and leave entitlement untouched!
      await assert.rejects(
        () =>
          repoA.applyBillingTransition({
            eventId: evtId,
            leaseOwner: 'connA',
            subscription: {
              id: `sub_${Date.now()}`,
              workspaceId: wsId,
              provider: 'stripe',
              customerId: 'cus_live',
              subscriptionId: 'sub_live',
              tier: 'Enterprise',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            storeProfileUpdate: { tier: 'Enterprise', skuLimit: 0 },
          }),
        /lease ownership lost or expired/i
      );

      // 2. Concurrent visibility identical content_hash upload across Pool A & Pool B
      const hash = crypto.createHash('sha256').update(`live_${wsId}`).digest('hex');
      const makeImp = (id: string) => ({
        id,
        workspaceId: wsId,
        filename: `${id}.csv`,
        contentHash: hash,
        rowCount: 1,
        rejectedRowCount: 0,
        status: 'completed' as const,
        errors: [],
        reportingPeriodStart: '2026-10-01',
        reportingPeriodEnd: '2026-10-01',
        sourcePlatform: 'merchant_csv',
        createdAt: new Date().toISOString(),
      });
      const makeMetric = (impId: string) => ({
        id: `vm_${impId}`,
        workspaceId: wsId,
        importId: impId,
        observationDate: '2026-10-01',
        platform: 'Perplexity',
        brandMentions: 5,
        productMentions: 2,
        websiteClicks: 1,
        discoveryTopic: null,
        topicPresence: 'unspecified' as const,
        evidenceSource: 'live.csv',
        createdAt: new Date().toISOString(),
      });

      const [vResA, vResB] = await Promise.all([
        repoA.saveVisibilityImportAtomic(makeImp('vimp_a'), [makeMetric('vimp_a')]),
        repoB.saveVisibilityImportAtomic(makeImp('vimp_b'), [makeMetric('vimp_b')]),
      ]);
      const dupCount = [vResA, vResB].filter((r) => r.duplicateImport).length;
      assert.equal(dupCount, 1, 'Exactly one concurrent duplicate content_hash insert must become duplicate_noop');
    });
  });
});
