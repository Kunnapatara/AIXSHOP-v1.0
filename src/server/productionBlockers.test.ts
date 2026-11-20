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
import {
  CatalogVersionConflictError,
  CatalogVersionValidationError,
  WorkspaceLockOrderError,
} from './db/repository';
import { createApp } from './app';
import { processShopifyWebhook } from './shopify/webhookService';
import { syncShopifyCatalog } from './shopify/syncService';
import { encryptCredential } from './security/encryption';
import {
  getTrustedBaseUrl,
  parseTrustProxySetting,
  resolveAuthRateLimitFailurePolicy,
  resolveTrustedRedirectUrl,
  validateProductionAppUrl,
  validateProductionConfig,
} from './config/productionConfig';
import {
  checkMigrationStatus,
  computeMigrationChecksum,
  runMigrations,
} from './db/migrate';
import {
  _getRateLimiterSize,
  _resetRateLimiter,
  authRateLimiter,
  getAuthRateLimiterDiagnostics,
} from './middleware/auth';
import { VisibilityObservationConflictError } from '../domain/monitoring/aiVisibilityTypes';
import { StoragePayloadV1 } from '../domain/storage/storageTypes';
import { BillingService } from './services/billingService';
import { SandboxBillingProvider, setBillingProvider } from './billing/providerAdapter';
import { runBillingWebhookRecoveryCli } from './billing/recoverWebhooks';
import { setDatabaseRepository } from './db/index';

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
    'AUTH_RATE_LIMIT_FAILURE_MODE',
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
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const wsId = `ws_live_${runId}`;
      const usrId = `usr_live_${runId}`;
      const evtId = `evt_live_${runId}`;

      try {
        await repoA.registerUser({
          user: { id: usrId, email: `${usrId}@example.com`, passwordHash: 'h', fullName: 'Live PG' },
          workspace: { id: wsId, name: 'Live PG WS', slug: wsId },
          session: {
            id: `sess_${runId}`,
            sessionTokenHash: crypto.createHash('sha256').update(`tok_${wsId}`).digest('hex'),
            userId: usrId,
            activeWorkspaceId: wsId,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        });

        // 1. Real two-connection billing lease expiry across Pool A & Pool B
        const claimA = await repoA.claimBillingEvent(
          {
            id: `be_${runId}_a`,
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
            id: `be_${runId}_b`,
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
                id: `sub_${runId}`,
                workspaceId: wsId,
                provider: 'stripe',
                customerId: `cus_${runId}`,
                subscriptionId: `sub_ext_${runId}`,
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
          repoA.saveVisibilityImportAtomic(makeImp(`${runId}_vimp_a`), [makeMetric(`${runId}_vimp_a`)]),
          repoB.saveVisibilityImportAtomic(makeImp(`${runId}_vimp_b`), [makeMetric(`${runId}_vimp_b`)]),
        ]);
        const dupCount = [vResA, vResB].filter((r) => r.duplicateImport).length;
        assert.equal(dupCount, 1, 'Exactly one concurrent duplicate content_hash insert must become duplicate_noop');

        // 3. Remediation A Live PG: Concurrent differing CSV imports on a nonexistent key must serialize cleanly
        const makeImpDiff = (id: string, hashSeed: string) => ({
          id,
          workspaceId: wsId,
          filename: `${id}.csv`,
          contentHash: crypto.createHash('sha256').update(`${hashSeed}_${wsId}`).digest('hex'),
          rowCount: 1,
          rejectedRowCount: 0,
          status: 'completed' as const,
          errors: [],
          reportingPeriodStart: '2026-10-05',
          reportingPeriodEnd: '2026-10-05',
          sourcePlatform: 'merchant_csv',
          createdAt: new Date().toISOString(),
        });
        const makeMetricDiff = (impId: string, mentions: number, topic: string | null) => ({
          id: `vm_${impId}`,
          workspaceId: wsId,
          importId: impId,
          observationDate: '2026-10-05',
          platform: 'ChatGPT Search',
          brandMentions: mentions,
          productMentions: 4,
          websiteClicks: 2,
          discoveryTopic: topic,
          topicPresence: topic === null ? ('unspecified' as const) : ('explicit_blank' as const),
          evidenceSource: 'live-conflict.csv',
          createdAt: new Date().toISOString(),
        });

        const settledConflict = await Promise.allSettled([
          repoA.saveVisibilityImportAtomic(makeImpDiff(`${runId}_vimp_c1`, 'diff1'), [makeMetricDiff(`${runId}_vimp_c1`, 10, null)]),
          repoB.saveVisibilityImportAtomic(makeImpDiff(`${runId}_vimp_c2`, 'diff2'), [makeMetricDiff(`${runId}_vimp_c2`, 20, null)]),
        ]);
        const fulfilledConflict = settledConflict.filter((r) => r.status === 'fulfilled');
        const rejectedConflict = settledConflict.filter((r) => r.status === 'rejected');
        assert.equal(fulfilledConflict.length, 1);
        assert.equal(rejectedConflict.length, 1);
        assert.ok(rejectedConflict[0].status === 'rejected' && rejectedConflict[0].reason instanceof VisibilityObservationConflictError);

        // NULL vs explicit '' remains distinct even concurrently on live PG
        const blankRes = await repoB.saveVisibilityImportAtomic(
          makeImpDiff(`${runId}_vimp_blank`, 'blank'),
          [makeMetricDiff(`${runId}_vimp_blank`, 33, '')]
        );
        assert.equal(blankRes.metricsSaved, 1);

        // 4. Remediation C + B Live PG: pool.max = 1 nested withWorkspaceLock + mandatory catalogVersion guard
        const singleConnPool = new Pool({
          ...(process.env.DATABASE_URL
            ? { connectionString: process.env.DATABASE_URL }
            : {
                host: process.env.SQL_HOST || process.env.PGHOST,
                port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
                user: process.env.SQL_USER || process.env.PGUSER,
                password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
                database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
              }),
          max: 1,
          connectionTimeoutMillis: 2000,
        });
        try {
          const singleRepo = new PostgresRepository(singleConnPool);
          await singleRepo.withWorkspaceLock(wsId, async () => {
            const cat1 = (await singleRepo.loadWorkspaceCatalog(wsId))!;
            await singleRepo.withWorkspaceLock(wsId, async () => {
              await singleRepo.saveWorkspaceCatalog(wsId, cat1);
            });
            await singleRepo.mutateWorkspaceCatalog(wsId, async (cat) => ({
              nextCatalog: cat,
              result: true,
            }));
          });
          const postSingleCat = (await singleRepo.loadWorkspaceCatalog(wsId))!;
          assert.ok((postSingleCat.catalogVersion || 1) >= 2);
          await assert.rejects(
            () => singleRepo.saveWorkspaceCatalog(wsId, { ...postSingleCat, catalogVersion: undefined }),
            (err: any) => err instanceof CatalogVersionConflictError && err.statusCode === 409
          );
        } finally {
          await singleConnPool.end();
        }
      } finally {
        await poolA.query('DELETE FROM billing_events WHERE event_id = $1', [evtId]).catch(() => {});
        await poolA.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await poolA.query('DELETE FROM users WHERE id = $1', [usrId]).catch(() => {});
      }
    });

    test('I2. [Live PG - Workstream 2] Two-connection concurrent replace_versioned, opposite key ordering, lineage, duplicate retry, reject_on_conflict & TX rollback', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const wsId = `ws_vis_${runId}`;
      const usrId = `usr_vis_${runId}`;
      try {
        await repoA.registerUser({
          user: { id: usrId, email: `${usrId}@example.com`, passwordHash: 'h', fullName: 'Vis Live' },
          workspace: { id: wsId, name: 'Vis Live WS', slug: wsId },
          session: {
            id: `sess_vis_${runId}`,
            sessionTokenHash: crypto.createHash('sha256').update(`tok_${wsId}`).digest('hex'),
            userId: usrId,
            activeWorkspaceId: wsId,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        });

        const makeImp = (id: string, seed: string) => ({
          id,
          workspaceId: wsId,
          filename: `${id}.csv`,
          contentHash: crypto.createHash('sha256').update(`${seed}_${wsId}`).digest('hex'),
          rowCount: 2,
          rejectedRowCount: 0,
          status: 'completed' as const,
          errors: [],
          reportingPeriodStart: '2026-10-10',
          reportingPeriodEnd: '2026-10-12',
          sourcePlatform: 'merchant_csv',
          createdAt: new Date().toISOString(),
        });
        const makeMetric = (impId: string, date: string, topic: string | null, mentions: number) => ({
          id: `vm_${impId}_${date}`,
          workspaceId: wsId,
          importId: impId,
          observationDate: date,
          platform: 'ChatGPT Search',
          brandMentions: mentions,
          productMentions: mentions + 1,
          websiteClicks: mentions + 2,
          discoveryTopic: topic,
          topicPresence: (topic === null ? 'unspecified' : 'specified') as 'unspecified' | 'specified',
          evidenceSource: `${impId}.csv`,
          createdAt: new Date().toISOString(),
        });

        // 1. Seed initial v1 on keys K1 ('2026-10-10', null) & K2 ('2026-10-11', 'running')
        const impV1Id = `${runId}_vimp_v1`;
        const impV2aId = `${runId}_vimp_v2a`;
        const impV2bId = `${runId}_vimp_v2b`;
        const impRetryId = `${runId}_vimp_v2b_r`;
        const impRejectId = `${runId}_vimp_rej`;
        const impAbortId = `${runId}_vimp_abt`;

        const imp1 = makeImp(impV1Id, 'seed_v1');
        await repoA.saveVisibilityImportAtomic(imp1, [
          makeMetric(impV1Id, '2026-10-10', null, 10),
          makeMetric(impV1Id, '2026-10-11', 'running', 20),
        ]);

        // 2. Concurrent replace_versioned across Pool A ([K1, K2]) and Pool B ([K2, K1] opposite order)
        const [repA, repB] = await Promise.all([
          repoA.saveVisibilityImportAtomic(
            makeImp(impV2aId, 'rep_a'),
            [
              makeMetric(impV2aId, '2026-10-10', null, 100),
              makeMetric(impV2aId, '2026-10-11', 'running', 200),
            ],
            { conflictPolicy: 'replace_versioned' }
          ),
          repoB.saveVisibilityImportAtomic(
            makeImp(impV2bId, 'rep_b'),
            [
              makeMetric(impV2bId, '2026-10-11', 'running', 400),
              makeMetric(impV2bId, '2026-10-10', null, 300),
            ],
            { conflictPolicy: 'replace_versioned' }
          ),
        ]);
        assert.equal(repA.replacedCount, 2);
        assert.equal(repB.replacedCount, 2);

        // 3. Verify lineage v1 -> v2 -> v3 intact and supersedes_history_id chain valid
        const hist = await repoA.getVisibilityObservationHistory(wsId, 50);
        const k1Hist = hist.filter((h) => h.observationDate === '2026-10-10').sort((a, b) => a.versionNumber - b.versionNumber);
        const k2Hist = hist.filter((h) => h.observationDate === '2026-10-11').sort((a, b) => a.versionNumber - b.versionNumber);
        assert.deepEqual(k1Hist.map((h) => h.versionNumber), [1, 2, 3]);
        assert.deepEqual(k2Hist.map((h) => h.versionNumber), [1, 2, 3]);
        assert.equal(k1Hist[0].eventType, 'recorded');
        assert.equal(k1Hist[1].eventType, 'replaced');
        assert.equal(k1Hist[1].supersedesHistoryId, k1Hist[0].id);
        assert.equal(k1Hist[2].supersedesHistoryId, k1Hist[1].id);
        assert.equal(k2Hist[2].supersedesHistoryId, k2Hist[1].id);

        // Active metric matches v3 exactly
        const summary = await repoB.getVisibilitySummary(wsId);
        const k1Active = summary.recentObservations.find((m) => m.observationDate === '2026-10-10')!;
        const k2Active = summary.recentObservations.find((m) => m.observationDate === '2026-10-11')!;
        assert.equal(k1Active.brandMentions, k1Hist[2].brandMentions);
        assert.equal(k2Active.brandMentions, k2Hist[2].brandMentions);

        // 4. Retry same content_hash returns duplicate_noop without creating duplicate history rows
        const retryDup = await repoA.saveVisibilityImportAtomic(
          makeImp(impRetryId, 'rep_b'),
          [
            makeMetric(impRetryId, '2026-10-10', null, 300),
            makeMetric(impRetryId, '2026-10-11', 'running', 400),
          ],
          { conflictPolicy: 'replace_versioned' }
        );
        assert.equal(retryDup.duplicateImport, true);
        const histAfterRetry = await repoA.getVisibilityObservationHistory(wsId, 50);
        assert.equal(histAfterRetry.length, 6, 'Duplicate retry must not emit additional history rows');

        // 5. reject_on_conflict leaves zero partial import rows
        await assert.rejects(
          () =>
            repoB.saveVisibilityImportAtomic(
              makeImp(impRejectId, 'reject_seed'),
              [makeMetric(impRejectId, '2026-10-10', null, 999)],
              { conflictPolicy: 'reject_on_conflict' }
            ),
          (err: any) => err instanceof VisibilityObservationConflictError && err.statusCode === 409
        );
        const impCheck = await poolA.query(`SELECT id FROM ai_visibility_imports WHERE workspace_id = $1 AND id = $2`, [wsId, impRejectId]);
        assert.equal(impCheck.rows.length, 0, 'Rejected conflict import must roll back completely');

        // 6. Mid-TX replacement failure (forced SQL error on 2nd metric inside replace_versioned) rolls back import, history, and v3 active metric
        await assert.rejects(
          () =>
            repoA.saveVisibilityImportAtomic(
              makeImp(impAbortId, 'abort_seed'),
              [
                makeMetric(impAbortId, '2026-10-10', null, 777),
                {
                  ...makeMetric(impAbortId, '2026-10-11', 'running', 888),
                  platform: null as any, // triggers NOT NULL violation inside same TX after 1st metric wrote
                },
              ],
              { conflictPolicy: 'replace_versioned' }
            ),
          (err: any) => Boolean(err)
        );
        const abortImpRes = await poolA.query(`SELECT id FROM ai_visibility_imports WHERE workspace_id = $1 AND id = $2`, [wsId, impAbortId]);
        assert.equal(abortImpRes.rows.length, 0, 'Aborted TX import header must be rolled back');
        const histAfterAbort = await repoA.getVisibilityObservationHistory(wsId, 50);
        assert.equal(histAfterAbort.length, 6, 'Aborted replacement must leave zero partial history rows');
        const summaryAfterAbort = await repoA.getVisibilitySummary(wsId);
        const k1AfterAbort = summaryAfterAbort.recentObservations.find((m) => m.observationDate === '2026-10-10')!;
        assert.notEqual(k1AfterAbort.brandMentions, 777, 'First metric write inside aborted TX must be rolled back');
      } finally {
        await poolA.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await poolA.query('DELETE FROM users WHERE id = $1', [usrId]).catch(() => {});
      }
    });

    test('I3. [Live PG - Workstream 3] Two-connection catalogVersion concurrency, single initialization winner, unversioned overwrite rejection, and TX non-mutation', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const wsId = `ws_ver_${runId}`;
      const usrId = `usr_ver_${runId}`;
      try {
        await repoA.registerUser({
          user: { id: usrId, email: `${usrId}@example.com`, passwordHash: 'h', fullName: 'Ver Live' },
          workspace: { id: wsId, name: 'Ver Live WS', slug: wsId },
          session: {
            id: `sess_ver_${runId}`,
            sessionTokenHash: crypto.createHash('sha256').update(`tok_${wsId}`).digest('hex'),
            userId: usrId,
            activeWorkspaceId: wsId,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        });

        const makeCat = (id: string, sku: string, ver?: number): StoragePayloadV1 => ({
          products: [
            {
              id,
              title: `Product ${id}`,
              brand: 'LiveBrand',
              category: 'Home',
              description: 'Live PG product',
              image: '',
              status: 'active',
              completenessScore: 90,
              evidenceCoverageScore: 0,
              externalDiscoveryStatus: 'observed_in_sample',
              attributes: {},
              variants: [{ id: `v_${id}`, sku, title: 'Default', barcode: '', price: 42, inventoryCount: 3, attributes: {} }],
              offers: [],
              evidenceDocuments: [],
              findingsCount: 0,
              lastAudited: new Date().toISOString(),
            },
          ],
          variants: [{ id: `v_${id}`, sku, title: 'Default', barcode: '', price: 42, inventoryCount: 3, attributes: {} }],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: {
            name: 'Ver Store',
            domain: `${wsId}.myshopify.com`,
            currency: 'USD',
            skuCount: 1,
            catalogCompletenessAvg: 90,
            truthBoundaryStrictness: 'standard',
            tier: 'Free Audit',
            connectors: [],
          },
          ...(ver !== undefined ? { catalogVersion: ver } : {}),
        });

        // 1. Concurrent unversioned init on empty catalog across Pool A & Pool B -> single winner
        const initSettled = await Promise.allSettled([
          repoA.saveWorkspaceCatalog(wsId, makeCat(`${runId}_p_initA`, `SKU-IA-${runId}`)),
          repoB.saveWorkspaceCatalog(wsId, makeCat(`${runId}_p_initB`, `SKU-IB-${runId}`)),
        ]);
        assert.equal(initSettled.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(initSettled.filter((r) => r.status === 'rejected').length, 1);

        const catA = (await repoA.loadWorkspaceCatalog(wsId))!;
        const catB = (await repoB.loadWorkspaceCatalog(wsId))!;
        assert.equal(catA.catalogVersion, 2);
        assert.equal(catB.catalogVersion, 2);

        // 2. Client A updates with expectedVersion=2 -> succeeds (version 3); Client B updates with stale expectedVersion=2 -> 409
        await repoA.saveWorkspaceCatalog(wsId, makeCat(`${runId}_p_winA`, `SKU-WINA-${runId}`, 2), { expectedVersion: 2 });
        await assert.rejects(
          () => repoB.saveWorkspaceCatalog(wsId, makeCat(`${runId}_p_staleB`, `SKU-STALEB-${runId}`, 2), { expectedVersion: 2 }),
          (err: any) => err instanceof CatalogVersionConflictError && err.statusCode === 409 && err.currentVersion === 3
        );

        // 3. Unversioned update cannot overwrite initialized catalog
        await assert.rejects(
          () => repoB.saveWorkspaceCatalog(wsId, makeCat(`${runId}_p_unver`, `SKU-UNVER-${runId}`)),
          (err: any) => err instanceof CatalogVersionConflictError && err.statusCode === 409 && err.currentVersion === 3
        );

        // 4. Failed quota update does not mutate catalog or advance version
        // Explicitly configure a tight workspace quota (50 SKUs) so 120 SKUs deterministically exceeds entitlement.
        const preQuotaStore = await repoB.getStoreByWorkspace(wsId);
        assert.ok(preQuotaStore, 'Workspace store profile must exist before quota update');
        await repoA.saveStoreProfile(wsId, {
          ...preQuotaStore!,
          skuLimit: 50,
        });
        const configuredStore = await repoB.getStoreByWorkspace(wsId);
        assert.equal(configuredStore?.skuLimit, 50, 'Workspace must have explicit SKU quota of 50');

        const preQuotaAuditCount = await poolA.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_runs WHERE workspace_id = $1`,
          [wsId]
        );
        assert.equal(preQuotaAuditCount.rows[0].cnt, 0);

        const overQuotaProducts = Array.from({ length: 120 }, (_, i) => ({
          ...makeCat(`${runId}_p_oq_${i}`, `SKU-OQ-${runId}-${i}`).products[0],
        }));
        await assert.rejects(
          () =>
            repoA.saveWorkspaceCatalog(
              wsId,
              { ...makeCat(`${runId}_p_oq`, `SKU-OQ-${runId}`, 3), products: overQuotaProducts },
              { expectedVersion: 3 }
            ),
          (err: any) => {
            assert.equal(err.code, 'PLAN_QUOTA_EXCEEDED');
            assert.equal(err.limit, 50);
            assert.equal(err.projectedUsage, 120);
            return true;
          }
        );

        const verifiedCat = (await repoB.loadWorkspaceCatalog(wsId))!;
        assert.equal(verifiedCat.catalogVersion, 3, 'Failed quota update must not advance catalogVersion');
        assert.equal(verifiedCat.products.length, 1, 'Failed quota update must not write partial products');
        assert.equal(verifiedCat.products[0].id, `${runId}_p_winA`, 'Existing catalog product must remain intact');

        const pgQuotaVerification = await poolB.query<{
          product_count: number;
          catalog_version: number;
          audit_count: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM products WHERE workspace_id = $1) AS product_count,
             (SELECT catalog_version::int FROM stores WHERE workspace_id = $1) AS catalog_version,
             (SELECT count(*)::int FROM audit_runs WHERE workspace_id = $1) AS audit_count`,
          [wsId]
        );
        assert.equal(pgQuotaVerification.rows[0].product_count, 1, 'No partial product rows may be persisted');
        assert.equal(pgQuotaVerification.rows[0].catalog_version, 3, 'PostgreSQL catalog_version must remain 3');
        assert.equal(pgQuotaVerification.rows[0].audit_count, 0, 'No unexpected audit history mutation may occur');

        // 5. executeWorkspaceAudit increments catalogVersion, persists bounded Findings/Actions + FK relationships, and supports realistic 16-digit Shopify IDs
        const auditOut = await repoA.executeWorkspaceAudit(wsId);
        assert.equal(auditOut.catalog.catalogVersion, 4);
        assert.equal(auditOut.auditRun.status, 'COMPLETED');
        assert.ok(auditOut.catalog.findings.length > 0, 'executeWorkspaceAudit must persist real audit findings');
        assert.equal(auditOut.catalog.findings.length, auditOut.catalog.actions.length, 'Each finding must have a paired action item');

        for (const f of auditOut.catalog.findings) {
          assert.ok(f.id.length <= 64, `Finding ID "${f.id}" (${f.id.length}) exceeds VARCHAR(64)`);
          assert.ok(f.actionItemId && f.actionItemId.length <= 64, `Action ID "${f.actionItemId}" exceeds VARCHAR(64)`);
          const pairedAction = auditOut.catalog.actions.find((a) => a.id === f.actionItemId);
          assert.ok(pairedAction, `Action "${f.actionItemId}" missing for finding "${f.id}"`);
          assert.equal(pairedAction?.findingId, f.id);
        }

        // Verify PostgreSQL persisted rows, lengths, FK consistency, and audit_run_findings snapshot via independent Pool B
        const pgAuditRows = await poolB.query<{
          findings_count: number;
          actions_count: number;
          snapshot_findings_count: number;
          max_finding_id_len: number;
          max_action_id_len: number;
          max_snap_id_len: number;
          unpaired_count: number;
          run_status: string;
        }>(
          `SELECT
             (SELECT count(*)::int FROM findings WHERE workspace_id = $1) AS findings_count,
             (SELECT count(*)::int FROM action_items WHERE workspace_id = $1) AS actions_count,
             (SELECT count(*)::int FROM audit_run_findings WHERE workspace_id = $1 AND audit_run_id = $2) AS snapshot_findings_count,
             (SELECT COALESCE(MAX(char_length(id)), 0)::int FROM findings WHERE workspace_id = $1) AS max_finding_id_len,
             (SELECT COALESCE(MAX(char_length(id)), 0)::int FROM action_items WHERE workspace_id = $1) AS max_action_id_len,
             (SELECT COALESCE(MAX(char_length(id)), 0)::int FROM audit_run_findings WHERE workspace_id = $1 AND audit_run_id = $2) AS max_snap_id_len,
             (
               SELECT count(*)::int
               FROM findings f
               FULL OUTER JOIN action_items a
                 ON a.workspace_id = f.workspace_id AND a.id = f.action_item_id AND a.finding_id = f.id
               WHERE COALESCE(f.workspace_id, a.workspace_id) = $1
                 AND (f.id IS NULL OR a.id IS NULL)
             ) AS unpaired_count,
             (SELECT status FROM audit_runs WHERE workspace_id = $1 AND id = $2) AS run_status`,
          [wsId, auditOut.auditRun.id]
        );
        const auditStats = pgAuditRows.rows[0];
        assert.equal(auditStats.run_status, 'COMPLETED');
        assert.equal(auditStats.findings_count, auditOut.catalog.findings.length);
        assert.equal(auditStats.actions_count, auditOut.catalog.actions.length);
        assert.equal(auditStats.snapshot_findings_count, auditOut.catalog.findings.length);
        assert.ok(auditStats.max_finding_id_len <= 64);
        assert.ok(auditStats.max_action_id_len <= 64);
        assert.ok(auditStats.max_snap_id_len <= 128);
        assert.equal(auditStats.unpaired_count, 0, 'Every persisted finding & action must maintain 1:1 FK pairing');

        // Verify retrieval via repository read paths on Pool B
        const loadedAfterAudit = await repoB.loadWorkspaceCatalog(wsId);
        assert.equal(loadedAfterAudit?.catalogVersion, 4);
        assert.equal(loadedAfterAudit?.findings.length, auditOut.catalog.findings.length);
        const latestRun = await repoB.getLatestAuditRunByWorkspace(wsId);
        assert.equal(latestRun?.id, auditOut.auditRun.id);
        const histSnapshot = await repoB.getHistoricalAuditSnapshot(wsId, auditOut.auditRun.id);
        assert.equal(histSnapshot?.snapshotAvailable, true);
        assert.equal(histSnapshot?.findings.length, auditOut.catalog.findings.length);

        // 6. Persist realistic 16-digit Shopify product & variant IDs (within skuLimit=50) and execute workspace audit on Pool B
        const shopify16Cat: StoragePayloadV1 = {
          products: [
            {
              id: 'p_shopify_8901234567890123',
              title: 'Shopify 16-Digit Merino Sneaker',
              brand: 'Shopify Brand',
              category: 'Footwear',
              description: 'Sustainable eucalyptus and merino sneaker imported from Shopify.',
              image: 'https://cdn.shopify.com/sneaker-16.jpg',
              status: 'active',
              completenessScore: 80,
              evidenceCoverageScore: 0,
              externalDiscoveryStatus: 'observed_in_sample',
              attributes: {},
              variants: [
                {
                  id: 'v_shopify_4567890123456789',
                  sku: `SKU-SH16-${runId}`,
                  title: 'Size 10',
                  barcode: '',
                  price: 29.99,
                  inventoryCount: 8,
                  attributes: {},
                },
              ],
              offers: [],
              evidenceDocuments: [],
              findingsCount: 0,
              lastAudited: new Date().toISOString(),
            },
          ],
          variants: [
            {
              id: 'v_shopify_4567890123456789',
              sku: `SKU-SH16-${runId}`,
              title: 'Size 10',
              barcode: '',
              price: 29.99,
              inventoryCount: 8,
              attributes: {},
            },
          ],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: {
            ...auditOut.catalog.storeProfile,
            skuLimit: 50,
          },
        };
        await repoA.saveWorkspaceCatalog(wsId, shopify16Cat, { expectedVersion: 4 });
        const shopifyAuditOut = await repoB.executeWorkspaceAudit(wsId);
        assert.equal(shopifyAuditOut.catalog.catalogVersion, 6);
        const gtinFinding = shopifyAuditOut.catalog.findings.find(
          (f) => f.productId === 'p_shopify_8901234567890123' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'
        );
        assert.ok(gtinFinding, '16-digit Shopify product missing barcode must generate bounded GTIN finding');
        assert.ok(gtinFinding!.id.length <= 64);
        assert.ok(gtinFinding!.actionItemId && gtinFinding!.actionItemId.length <= 64);
        const gtinAction = shopifyAuditOut.catalog.actions.find((a) => a.id === gtinFinding!.actionItemId);
        assert.equal(gtinAction?.findingId, gtinFinding!.id);

        const shopifyPgCheck = await poolA.query<{ id: string; action_item_id: string }>(
          `SELECT id, action_item_id FROM findings WHERE workspace_id = $1 AND product_id = $2`,
          [wsId, 'p_shopify_8901234567890123']
        );
        assert.ok(shopifyPgCheck.rows.some((r) => r.id === gtinFinding!.id && r.action_item_id === gtinAction!.id));
      } finally {
        await poolA.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await poolA.query('DELETE FROM users WHERE id = $1', [usrId]).catch(() => {});
      }
    });

    test('I4. [Live PG - Workstream 4] Nested unlock failure destroys pooled backend PID (0 pg_locks leaks) & cross-workspace lock ordering enforces deterministic order', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const wsBase = `ws_lock_${runId}`;
      const wsA = `${wsBase}_a`;
      const wsB = `${wsBase}_b`;

      // 1. Same-workspace nested acquisition + deterministic ascending cross-workspace (wsA -> wsB) succeed with 0 leaked advisory locks
      await repoA.withWorkspaceLock(wsA, async () => {
        await repoA.withWorkspaceLock(wsA, async () => {
          await repoA.withWorkspaceLock(wsB, async () => true);
        });
      });
      const leakCheck1 = await poolA.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM pg_locks WHERE locktype = 'advisory'`
      );
      assert.equal(leakCheck1.rows[0].cnt, 0, 'Zero advisory locks may remain after normal nested & ordered locks');

      // 2. Reverse-order cross-workspace acquisition (wsB -> wsA) rejects deterministically with WorkspaceLockOrderError & releases wsB cleanly
      await assert.rejects(
        () =>
          repoA.withWorkspaceLock(wsB, async () => {
            await repoA.withWorkspaceLock(wsA, async () => 'unreachable');
          }),
        (err: any) => err instanceof WorkspaceLockOrderError && err.code === 'WORKSPACE_LOCK_ORDER_VIOLATION'
      );
      // Confirm wsB lock is released so Pool B can immediately acquire wsB
      const bAcquiredAfterReject = await repoB.withWorkspaceLock(wsB, async () => 'acquired', { lockTimeoutMs: 500 });
      assert.equal(bAcquiredAfterReject, 'acquired');

      // 3. Nested unlock failure on max=1 live PG pool marks connection poisoned -> outer exit calls release(true) destroying backend PID!
      const singleCfg = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 }
        : {
            host: process.env.SQL_HOST || process.env.PGHOST,
            port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
            user: process.env.SQL_USER || process.env.PGUSER,
            password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
            database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
            max: 1,
            connectionTimeoutMillis: 2000,
          };
      const trackedPool = new Pool(singleCfg);
      try {
        const origConnect = trackedPool.connect.bind(trackedPool);
        let firstPid = 0;
        let injectedNestedUnlockFailure = false;
        (trackedPool as any).connect = async () => {
          const client = await origConnect();
          if (!injectedNestedUnlockFailure) {
            const pidRes = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            firstPid = pidRes.rows[0].pid;
            const origQuery = client.query.bind(client);
            (client as any).query = async (sql: any, params?: any[]) => {
              if (
                typeof sql === 'string' &&
                sql.includes('pg_advisory_unlock') &&
                Array.isArray(params) &&
                params[0] === wsB &&
                !injectedNestedUnlockFailure
              ) {
                injectedNestedUnlockFailure = true;
                return { rows: [{ pg_advisory_unlock: false }] };
              }
              return origQuery(sql, params);
            };
          }
          return client;
        };

        const trackedRepo = new PostgresRepository(trackedPool);
        await assert.rejects(
          () =>
            trackedRepo.withWorkspaceLock(wsA, async () => {
              return trackedRepo.withWorkspaceLock(wsB, async () => {
                throw new Error('primary_nested_op_error');
              });
            }),
          /primary_nested_op_error/
        );

        // Next checkout on pool.max=1 must receive a fresh PostgreSQL backend PID and wsB/wsA locks must both be free
        const nextClient = await trackedPool.connect();
        try {
          const pid2Res = await nextClient.query<{ pid: number; adv: number }>(
            `SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS adv`
          );
          assert.notEqual(pid2Res.rows[0].pid, firstPid, 'Poisoned PG backend session MUST be destroyed rather than reused');
          assert.equal(pid2Res.rows[0].adv, 0, 'Session destruction must release any stuck advisory lock');
        } finally {
          nextClient.release();
        }
      } finally {
        await trackedPool.end();
      }
    });

    test('I5. [Live PG - Workstream 6] Two independent Express instances share live PostgreSQL auth_rate_limits table, fail closed 503 on outage, and recover cleanly', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedFailureMode = process.env.AUTH_RATE_LIMIT_FAILURE_MODE;
      const savedSessionSecret = process.env.SESSION_SECRET;
      const savedAppUrl = process.env.APP_URL;

      process.env.NODE_ENV = 'production';
      delete process.env.AUTH_RATE_LIMIT_FAILURE_MODE;
      process.env.SESSION_SECRET = 'live_pg_test_session_secret_value_32_bytes_minimum';
      process.env.APP_URL = 'https://app.aixshop.example.com';
      _resetRateLimiter();

      const randByteA = (crypto.randomBytes(1)[0] % 200) + 10;
      const randByteB = (crypto.randomBytes(1)[0] % 200) + 10;
      const randByteOut = (crypto.randomBytes(1)[0] % 200) + 10;
      const testIp = `203.0.113.${randByteA}.${randByteB}`;
      const outageIp = `198.51.100.${randByteOut}`;
      const srvA = await startTempAppServer(createApp(repoA));
      const srvB = await startTempAppServer(createApp(repoB));
      try {
        // Send 20 alternating failed login requests across Instance A (Pool A) & Instance B (Pool B)
        for (let i = 0; i < 20; i++) {
          const targetBase = i % 2 === 0 ? srvA.baseUrl : srvB.baseUrl;
          const r = await fetch(`${targetBase}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': testIp,
            },
            body: JSON.stringify({ email: `no_such_user_${i}@example.com`, password: 'wrong' }),
          });
          assert.equal(r.status, 401, `Attempt ${i + 1} across alternating instances must count normally`);
        }

        // 21st request hits Instance B -> must be rejected 429 because Instance A & Instance B share PostgreSQL auth_rate_limits!
        const blockedOnB = await fetch(`${srvB.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': testIp,
          },
          body: JSON.stringify({ email: 'blocked@example.com', password: 'wrong' }),
        });
        assert.equal(blockedOnB.status, 429);
        const blockedJson = await blockedOnB.json();
        assert.equal(blockedJson.code, 'RATE_LIMITED');

        // Storage outage on Pool A fails closed 503 (does NOT silently degrade to local fallback)
        const origConsume = repoA.consumeRateLimit.bind(repoA);
        let simulateOutage = true;
        repoA.consumeRateLimit = async (key, max, windowMs) => {
          if (simulateOutage) throw new Error('Simulated live PG outage postgres://secret:pass@db/prod');
          return origConsume(key, max, windowMs);
        };
        const outageRes = await fetch(`${srvA.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': outageIp },
          body: JSON.stringify({ email: 'outage@example.com', password: 'wrong' }),
        });
        assert.equal(outageRes.status, 503);
        const outageJson = await outageRes.json();
        assert.equal(outageJson.code, 'RATE_LIMITER_UNAVAILABLE');

        // Recover & confirm cleanup
        simulateOutage = false;
        const recoveredRes = await fetch(`${srvA.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': outageIp },
          body: JSON.stringify({ email: 'recovered@example.com', password: 'wrong' }),
        });
        assert.equal(recoveredRes.status, 401);
        assert.equal(getAuthRateLimiterDiagnostics().storageDegraded, false);
      } finally {
        await srvA.close();
        await srvB.close();
        await poolA.query(`DELETE FROM auth_rate_limits WHERE rate_key LIKE $1`, [`%${testIp}%`]).catch(() => {});
        await poolA.query(`DELETE FROM auth_rate_limits WHERE rate_key LIKE $1`, [`%${outageIp}%`]).catch(() => {});
        _resetRateLimiter();
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedFailureMode === undefined) delete process.env.AUTH_RATE_LIMIT_FAILURE_MODE;
        else process.env.AUTH_RATE_LIMIT_FAILURE_MODE = savedFailureMode;
        if (savedSessionSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = savedSessionSecret;
        if (savedAppUrl === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = savedAppUrl;
      }
    });

    test('I8. [Live PG - Workstreams B & C] Two-connection concurrency and deterministic FOR UPDATE SKIP LOCKED tests for finalizeExpiredExhaustedBillingEvents()', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const testProvider = `pg_conc_${runId}`;
      const originalCreatedAt = '2026-11-10T01:02:03.000Z';

      const seedPgEvent = async (opts: {
        suffix: string;
        status: 'processing' | 'processed' | 'ignored' | 'failed';
        attemptCount: number;
        leaseOffsetSeconds: number | null;
        lastError?: string | null;
      }) => {
        const eventId = `evt_conc_${runId}_${opts.suffix}`;
        const rowId = `be_conc_${runId}_${opts.suffix}`;
        const payload = { id: eventId, type: 'checkout.session.completed', marker: opts.suffix };
        await poolA.query(
          `INSERT INTO billing_events (
             id, provider, event_id, event_type, idempotency_key, payload_json, status,
             lease_owner, lease_expires_at, attempt_count, last_error, last_attempt_at, next_retry_at,
             processed_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $3, $5::jsonb, $6,
             $7, clock_timestamp() + ($11::double precision * INTERVAL '1 second'),
             $8, $9, clock_timestamp(), NULL,
             clock_timestamp(), $10::timestamptz, clock_timestamp()
           )`,
          [
            rowId,
            testProvider,
            eventId,
            'checkout.session.completed',
            JSON.stringify(payload),
            opts.status,
            opts.status === 'processing' ? `worker_${opts.suffix}` : null,
            opts.attemptCount,
            opts.lastError ?? null,
            originalCreatedAt,
            opts.leaseOffsetSeconds,
          ]
        );
        return { eventId, payload };
      };

      try {
        // 1. Concurrent finalization of 1 expired exhausted event across Pool A & Pool B -> exactly 1 winner
        const single = await seedPgEvent({
          suffix: 'single',
          status: 'processing',
          attemptCount: 3,
          leaseOffsetSeconds: -30,
          lastError: 'Prior transient PG timeout',
        });

        // Unexpired exhausted, non-exhausted expired, and completed exhausted must ALL be ignored
        const unexpired = await seedPgEvent({
          suffix: 'unexp',
          status: 'processing',
          attemptCount: 3,
          leaseOffsetSeconds: 60,
        });
        const nonExhausted = await seedPgEvent({
          suffix: 'nonex',
          status: 'processing',
          attemptCount: 2,
          leaseOffsetSeconds: -30,
        });
        const doneProcessed = await seedPgEvent({
          suffix: 'done_p',
          status: 'processed',
          attemptCount: 5,
          leaseOffsetSeconds: null,
        });
        const doneIgnored = await seedPgEvent({
          suffix: 'done_i',
          status: 'ignored',
          attemptCount: 5,
          leaseOffsetSeconds: null,
        });

        const [finA, finB] = await Promise.all([
          repoA.finalizeExpiredExhaustedBillingEvents({ provider: testProvider, maxAttempts: 3, limit: 10 }),
          repoB.finalizeExpiredExhaustedBillingEvents({ provider: testProvider, maxAttempts: 3, limit: 10 }),
        ]);
        const combinedSingle = [...finA, ...finB];
        assert.equal(combinedSingle.length, 1, 'Exactly one PG worker connection must finalize the single eligible event');
        assert.equal(combinedSingle[0].eventId, single.eventId);

        // Verify persisted PostgreSQL state via Pool B
        const dbSingle = await repoB.getBillingEventById(single.eventId);
        assert.equal(dbSingle?.status, 'permanently_failed');
        assert.equal(dbSingle?.leaseExpiresAt, null);
        assert.equal(dbSingle?.nextRetryAt, null);
        assert.equal(dbSingle?.attemptCount, 3);
        assert.deepEqual(dbSingle?.payload, single.payload);
        assert.equal(new Date(dbSingle!.createdAt!).toISOString(), originalCreatedAt);
        assert.match(dbSingle?.lastError || '', /^Prior transient PG timeout \| Worker lease expired/);

        // Untouched rows remain in their original states
        assert.equal((await repoB.getBillingEventById(unexpired.eventId))?.status, 'processing');
        assert.equal((await repoA.getBillingEventById(nonExhausted.eventId))?.status, 'processing');
        assert.equal((await repoB.getBillingEventById(doneProcessed.eventId))?.status, 'processed');
        assert.equal((await repoA.getBillingEventById(doneIgnored.eventId))?.status, 'ignored');

        // Replay & idempotency protections on permanently_failed event in PostgreSQL
        const reClaimWebhook = await repoA.claimBillingEvent(
          {
            id: `re_${runId}`,
            provider: testProvider,
            eventId: single.eventId,
            eventType: 'checkout.session.completed',
            idempotencyKey: single.eventId,
            payload: single.payload,
            status: 'processing',
            processedAt: new Date().toISOString(),
          },
          { leaseOwner: 'dup_worker', leaseDurationMs: 5000 }
        );
        assert.equal(reClaimWebhook.claimed, false);
        assert.equal(reClaimWebhook.event?.status, 'permanently_failed');

        const recoveryNoReplay = await repoB.claimBillingEventForRecovery(single.eventId, {
          provider: testProvider,
          allowReplayFailed: false,
          maxAttempts: 5,
        });
        assert.equal(recoveryNoReplay.claimed, false);

        const recoveryExplicitReplay = await repoA.claimBillingEventForRecovery(single.eventId, {
          provider: testProvider,
          allowReplayFailed: true,
          maxAttempts: 5,
          leaseOwner: 'manual_replay_pg',
          leaseDurationMs: 60000,
        });
        assert.equal(recoveryExplicitReplay.claimed, true);
        assert.equal(recoveryExplicitReplay.event?.status, 'processing');
        assert.equal(recoveryExplicitReplay.event?.attemptCount, 4);
        await repoA.updateBillingEventStatus(single.eventId, 'processed', undefined, 'manual_replay_pg');

        // 2. Concurrent finalization of 6 eligible expired exhausted events across Pool A & Pool B -> disjoint union === 6
        const batchEvents: string[] = [];
        for (let i = 0; i < 6; i++) {
          const seeded = await seedPgEvent({
            suffix: `batch_${i}`,
            status: 'processing',
            attemptCount: 3 + (i % 2),
            leaseOffsetSeconds: -(20 + i),
          });
          batchEvents.push(seeded.eventId);
        }

        const [batchA, batchB] = await Promise.all([
          repoA.finalizeExpiredExhaustedBillingEvents({ provider: testProvider, maxAttempts: 3, limit: 10 }),
          repoB.finalizeExpiredExhaustedBillingEvents({ provider: testProvider, maxAttempts: 3, limit: 10 }),
        ]);

        const idsA = batchA.map((e) => e.eventId);
        const idsB = batchB.map((e) => e.eventId);
        const overlap = idsA.filter((id) => idsB.includes(id));
        assert.equal(overlap.length, 0, 'SKIP LOCKED must guarantee zero overlapping rows across connections');
        assert.equal(idsA.length + idsB.length, 6, 'All 6 eligible events must be finalized exactly once total');
        assert.deepEqual([...idsA, ...idsB].sort(), [...batchEvents].sort());
        assert.equal((await repoB.getBillingEventById(nonExhausted.eventId))?.status, 'processing');

        // 3. Deterministic FOR UPDATE SKIP LOCKED proof:
        // Connection A holds an explicit transaction + FOR UPDATE row lock on one eligible expired exhausted event
        // while Connection B executes finalizeExpiredExhaustedBillingEvents() concurrently.
        const lockHeld = await seedPgEvent({
          suffix: 'lock_held',
          status: 'processing',
          attemptCount: 3,
          leaseOffsetSeconds: -45,
          lastError: 'Prior lock-test error',
        });
        const unlocked1 = await seedPgEvent({
          suffix: 'unlocked_1',
          status: 'processing',
          attemptCount: 3,
          leaseOffsetSeconds: -40,
        });
        const unlocked2 = await seedPgEvent({
          suffix: 'unlocked_2',
          status: 'processing',
          attemptCount: 4,
          leaseOffsetSeconds: -35,
        });

        const lockClient = await poolA.connect();
        let lockTxOpen = false;
        try {
          await lockClient.query('BEGIN');
          lockTxOpen = true;
          const lockedRowRes = await lockClient.query(
            `SELECT id, event_id, status FROM billing_events WHERE event_id = $1 FOR UPDATE`,
            [lockHeld.eventId]
          );
          assert.equal(lockedRowRes.rows.length, 1);
          assert.equal(lockedRowRes.rows[0].status, 'processing');

          // Connection B must NOT block on lockHeld; SKIP LOCKED skips lockHeld and finalizes unlocked1 + unlocked2
          const startMs = Date.now();
          const skippedPass = await repoB.finalizeExpiredExhaustedBillingEvents({
            provider: testProvider,
            maxAttempts: 3,
            limit: 10,
          });
          const elapsedMs = Date.now() - startMs;
          assert.ok(elapsedMs < 4000, `SKIP LOCKED must not wait on Connection A lock (elapsed=${elapsedMs}ms)`);
          assert.deepEqual(
            skippedPass.map((e) => e.eventId).sort(),
            [unlocked1.eventId, unlocked2.eventId].sort(),
            'Connection B must skip locked row and finalize only remaining unlocked eligible rows'
          );

          // Confirm from Connection B while Transaction A still holds lock that lockHeld remained untouched
          assert.equal((await repoB.getBillingEventById(lockHeld.eventId))?.status, 'processing');
          assert.equal((await repoB.getBillingEventById(unlocked1.eventId))?.status, 'permanently_failed');
          assert.equal((await repoB.getBillingEventById(unlocked2.eventId))?.status, 'permanently_failed');
          assert.equal((await repoB.getBillingEventById(unexpired.eventId))?.status, 'processing');
          assert.equal((await repoB.getBillingEventById(nonExhausted.eventId))?.status, 'processing');

          await lockClient.query('COMMIT');
          lockTxOpen = false;
        } finally {
          if (lockTxOpen) {
            await lockClient.query('ROLLBACK').catch(() => {});
          }
          lockClient.release();
        }

        // After Connection A releases lock, Connection B finalizes the previously locked event cleanly
        const postUnlockPass = await repoB.finalizeExpiredExhaustedBillingEvents({
          provider: testProvider,
          maxAttempts: 3,
          limit: 10,
        });
        assert.equal(postUnlockPass.length, 1);
        assert.equal(postUnlockPass[0].eventId, lockHeld.eventId);

        for (const repo of [repoA, repoB]) {
          const finalHeld = await repo.getBillingEventById(lockHeld.eventId);
          assert.equal(finalHeld?.status, 'permanently_failed');
          assert.equal(finalHeld?.leaseExpiresAt, null);
          assert.equal(finalHeld?.nextRetryAt, null);
          assert.equal(finalHeld?.attemptCount, 3);
          assert.deepEqual(finalHeld?.payload, lockHeld.payload);
          assert.equal(new Date(finalHeld!.createdAt!).toISOString(), originalCreatedAt);
          assert.match(finalHeld?.lastError || '', /^Prior lock-test error \| Worker lease expired/);
        }
      } finally {
        await poolA.query(`DELETE FROM billing_events WHERE provider = $1`, [testProvider]).catch(() => {});
      }
    });

    test('I9. [Live PG - Workstream D] Real SQL trigger fault injection blocks failure persistence without secret leakage or false permanently_failed, then recovers via second connection', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const safeRun = runId.replace(/[^a-zA-Z0-9_]/g, '_');
      const wsId = `ws_pg_fault_${runId}`;
      const usrId = `usr_pg_fault_${runId}`;
      const wsId2 = `ws_pg_fault2_${runId}`;
      const usrId2 = `usr_pg_fault2_${runId}`;
      const evtId = `evt_pg_fault_${runId}`;
      const evtExhaustedId = `evt_pg_fault_ex_${runId}`;

      const subFn = `fn_test_sub_fail_${safeRun}`;
      const subTrg = `trg_test_sub_fail_${safeRun}`;
      const beFn = `fn_test_be_fail_${safeRun}`;
      const beTrg = `trg_test_be_fail_${safeRun}`;

      const sandboxProvider = new SandboxBillingProvider('pg_fault_webhook_secret_123');
      const capturedErrors: any[][] = [];
      const origConsoleError = console.error;

      try {
        for (const [u, w] of [[usrId, wsId], [usrId2, wsId2]]) {
          await repoA.registerUser({
            user: { id: u, email: `${u}@example.com`, passwordHash: 'h', fullName: 'PG Fault User' },
            workspace: { id: w, name: `PG Fault ${w}`, slug: w },
            session: {
              id: `sess_${w}`,
              sessionTokenHash: crypto.createHash('sha256').update(`tok_${w}`).digest('hex'),
              userId: u,
              activeWorkspaceId: w,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          });
        }

        // Install scoped PG triggers causing BOTH subscriptions INSERT failure and billing_events failure-status UPDATE failure
        await poolA.query(`
          CREATE OR REPLACE FUNCTION ${subFn}() RETURNS TRIGGER AS $$
          BEGIN
            IF NEW.workspace_id IN ('${wsId}', '${wsId2}') THEN
              RAISE EXCEPTION 'Simulated PG subscriptions write outage postgresql://dbadmin:UltraSecretPgPass123@pg.internal:5432/prod';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;

          CREATE TRIGGER ${subTrg}
          BEFORE INSERT ON subscriptions
          FOR EACH ROW EXECUTE FUNCTION ${subFn}();

          CREATE OR REPLACE FUNCTION ${beFn}() RETURNS TRIGGER AS $$
          BEGIN
            IF NEW.event_id IN ('${evtId}', '${evtExhaustedId}') AND NEW.status IN ('failed', 'permanently_failed') THEN
              RAISE EXCEPTION 'Simulated PG billing_events error persistence outage password=TopSecretTriggerPass';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;

          CREATE TRIGGER ${beTrg}
          BEFORE UPDATE ON billing_events
          FOR EACH ROW EXECUTE FUNCTION ${beFn}();
        `);

        console.error = (...args: any[]) => {
          capturedErrors.push(args);
        };

        const makePayload = (id: string, targetWs: string) => ({
          id,
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: targetWs,
              customer: `cus_fault_${runId}`,
              subscription: `sub_fault_${runId}`,
              metadata: { tier: 'Growth' },
              payment_status: 'paid',
            },
          },
        });

        // 1. Trigger outage on retryable path (maxAttempts: 3): failure persistence blocked cleanly
        const svcFault = new BillingService(
          repoA,
          sandboxProvider,
          { leaseDurationMs: 120, heartbeatIntervalMs: 30 },
          { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 }
        );
        const signed1 = sandboxProvider.generateSignedPayload(makePayload(evtId, wsId));
        await assert.rejects(
          () => svcFault.handleWebhook(signed1.payload, signed1.signature),
          (err: any) => {
            assert.match(err.message, /Simulated PG subscriptions write outage/i);
            assert.equal(err.failureStatePersisted, false);
            assert.equal(err.permanentlyFailed, false);
            assert.match(err.persistenceError || '', /Simulated PG billing_events error persistence outage/i);
            assert.doesNotMatch(err.persistenceError || '', /TopSecretTriggerPass|UltraSecretPgPass123/);
            return true;
          }
        );

        // 2. Even on final-attempt budget (maxAttempts: 1), blocked failure persistence NEVER falsely reports permanentlyFailed
        const svcExhausted = new BillingService(
          repoA,
          sandboxProvider,
          { leaseDurationMs: 120, heartbeatIntervalMs: 30 },
          { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 }
        );
        const signed2 = sandboxProvider.generateSignedPayload(makePayload(evtExhaustedId, wsId2));
        await assert.rejects(
          () => svcExhausted.handleWebhook(signed2.payload, signed2.signature),
          (err: any) => {
            assert.equal(err.failureStatePersisted, false);
            assert.equal(err.permanentlyFailed, false, 'Must NEVER falsely report permanentlyFailed when DB did not persist it');
            return true;
          }
        );

        // Verify structured sanitized error log was emitted with zero leaked DB passwords
        const persistLog = capturedErrors.find(
          (args) => args[0] === '[AIXSHOP Billing Error Persistence]' && args[1]?.eventId === evtId
        );
        assert.ok(persistLog, 'Must emit structured [AIXSHOP Billing Error Persistence] log');
        const logJson = JSON.stringify(persistLog);
        assert.doesNotMatch(logJson, /UltraSecretPgPass123|TopSecretTriggerPass/);

        // Verify via independent Pool B that both events remain 'processing' (not 'permanently_failed') and zero subscriptions/tier changes leaked
        const pgState1 = await repoB.getBillingEventById(evtId);
        const pgState2 = await repoB.getBillingEventById(evtExhaustedId);
        assert.equal(pgState1?.status, 'processing');
        assert.equal(pgState1?.attemptCount, 1);
        assert.equal(pgState2?.status, 'processing');
        assert.equal(await repoB.getSubscriptionByWorkspace(wsId), null);
        assert.equal((await repoB.getStoreByWorkspace(wsId))?.tier, 'Free Audit');

        // 3. Remove DB fault triggers, wait for short 120ms lease to expire, and recover via independent Connection B
        await poolA.query(`
          DROP TRIGGER IF EXISTS ${subTrg} ON subscriptions;
          DROP FUNCTION IF EXISTS ${subFn}();
          DROP TRIGGER IF EXISTS ${beTrg} ON billing_events;
          DROP FUNCTION IF EXISTS ${beFn}();
        `);

        await new Promise((r) => setTimeout(r, 180));

        // Clean evtExhaustedId out of sandbox sweep before recovering evtId on Pool B
        await poolA.query(`DELETE FROM billing_events WHERE event_id = $1`, [evtExhaustedId]);

        const svcRecoverB = new BillingService(
          repoB,
          sandboxProvider,
          { leaseDurationMs: 5000, heartbeatIntervalMs: 1000 },
          { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 }
        );
        const summary = await svcRecoverB.recoverPendingWebhookEvents({
          limit: 50,
          maxAttempts: 3,
          leaseOwnerPrefix: 'pg_recovery_connB',
        });
        const recDetail = summary.details.find((d) => d.eventId === evtId);
        assert.equal(recDetail?.outcome, 'recovered', `Expected recovered detail, got: ${JSON.stringify(summary.details)}`);

        // Verify recovered terminal state via Pool A
        const recoveredEvent = await repoA.getBillingEventById(evtId);
        assert.equal(recoveredEvent?.status, 'processed');
        assert.equal(recoveredEvent?.attemptCount, 2);
        assert.equal(recoveredEvent?.lastError, null);
        const sub = await repoA.getSubscriptionByWorkspace(wsId);
        assert.equal(sub?.tier, 'Growth');
        assert.equal(sub?.status, 'active');
        assert.equal((await repoA.getStoreByWorkspace(wsId))?.tier, 'Growth');
      } finally {
        console.error = origConsoleError;
        await poolA.query(`DROP TRIGGER IF EXISTS ${subTrg} ON subscriptions`).catch(() => {});
        await poolA.query(`DROP FUNCTION IF EXISTS ${subFn}()`).catch(() => {});
        await poolA.query(`DROP TRIGGER IF EXISTS ${beTrg} ON billing_events`).catch(() => {});
        await poolA.query(`DROP FUNCTION IF EXISTS ${beFn}()`).catch(() => {});
        await poolA.query(`DELETE FROM billing_events WHERE event_id IN ($1, $2)`, [evtId, evtExhaustedId]).catch(() => {});
        await poolA.query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [wsId, wsId2]).catch(() => {});
        await poolA.query(`DELETE FROM users WHERE id IN ($1, $2)`, [usrId, usrId2]).catch(() => {});
      }
    });

    test('I10. [Live PG - Workstream F] runBillingWebhookRecoveryCli connects via PostgresRepository and finalizes expired exhausted Stripe event in live PostgreSQL', async () => {
      const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const evtId = `evt_cli_livepg_${runId}`;
      const prevBillingProvider = process.env.BILLING_PROVIDER;
      const prevStripeKey = process.env.STRIPE_SECRET_KEY;

      setDatabaseRepository(null);
      setBillingProvider(null);
      try {
        await poolA.query(
          `INSERT INTO billing_events (
             id, provider, event_id, event_type, idempotency_key, payload_json, status,
             lease_owner, lease_expires_at, attempt_count, last_error, last_attempt_at, next_retry_at,
             processed_at, created_at, updated_at
           ) VALUES (
             $1, 'stripe', $2, 'checkout.session.completed', $2, '{}'::jsonb, 'processing',
             'crashed_cli_worker', clock_timestamp() - INTERVAL '30 seconds', 5, 'CLI pre-crash error',
             clock_timestamp() - INTERVAL '1 minute', NULL, clock_timestamp(), clock_timestamp(), clock_timestamp()
           )`,
          [`be_cli_${runId}`, evtId]
        );

        process.env.BILLING_PROVIDER = 'stripe';
        process.env.STRIPE_SECRET_KEY = 'sk_test_livepg_cli_placeholder';
        const result = await runBillingWebhookRecoveryCli(['--limit=50', '--max-attempts=5']);
        assert.ok('scanned' in result);

        const persisted = await repoB.getBillingEventById(evtId);
        assert.equal(persisted?.status, 'permanently_failed');
        assert.match(persisted?.lastError || '', /Worker lease expired on final attempt/);
      } finally {
        setDatabaseRepository(null);
        setBillingProvider(null);
        await poolA.query(`DELETE FROM billing_events WHERE event_id = $1`, [evtId]).catch(() => {});
        if (prevBillingProvider === undefined) delete process.env.BILLING_PROVIDER;
        else process.env.BILLING_PROVIDER = prevBillingProvider;
        if (prevStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = prevStripeKey;
      }
    });
  });

  // =========================================================================
  // WORKSTREAM R — Remediations A-F Focused Verification Suite
  // =========================================================================
  describe('Workstream R: Remediations A-F Regression & Concurrency Suite', () => {
    function buildEmptyCatalog(skuName = 'Default'): StoragePayloadV1 {
      return {
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: {
          name: `${skuName} Store`,
          domain: 'test-store.myshopify.com',
          currency: 'USD',
          skuCount: 0,
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard',
          tier: 'Free Audit',
          connectors: [],
        },
      };
    }

    function buildSingleProductCatalog(id: string, sku: string, title = 'Sample Product'): StoragePayloadV1 {
      return {
        products: [
          {
            id,
            title,
            brand: 'Solstice',
            category: 'Home',
            description: 'Quality test product',
            image: '',
            status: 'active',
            completenessScore: 90,
            evidenceCoverageScore: 0,
            externalDiscoveryStatus: 'observed_in_sample',
            attributes: {},
            variants: [{ id: `v_${id}`, sku, title: 'Default', barcode: '', price: 29, inventoryCount: 5, attributes: {} }],
            offers: [],
            evidenceDocuments: [],
            findingsCount: 0,
            lastAudited: new Date().toISOString(),
          },
        ],
        variants: [{ id: `v_${id}`, sku, title: 'Default', barcode: '', price: 29, inventoryCount: 5, attributes: {} }],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: {
          name: 'Test Store',
          domain: 'test-store.myshopify.com',
          currency: 'USD',
          skuCount: 1,
          catalogCompletenessAvg: 90,
          truthBoundaryStrictness: 'standard',
          tier: 'Free Audit',
          connectors: [],
        },
      };
    }

    // -----------------------------------------------------------------------
    // REMEDIATION A — Visibility Import Concurrency & Conflict Integrity
    // -----------------------------------------------------------------------
    test('RA1. Concurrent differing visibility imports on nonexistent key serialize cleanly: 1 commits, 1 rejects 409 without partial rows, replace_versioned chains history', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_ra1', email: 'ra1@example.com', passwordHash: 'h', fullName: 'RA1' },
        workspace: { id: 'ws_ra1', name: 'WS RA1', slug: 'ws-ra1' },
        session: {
          id: 'sess_ra1',
          sessionTokenHash: crypto.createHash('sha256').update('tok_ra1').digest('hex'),
          userId: 'u_ra1',
          activeWorkspaceId: 'ws_ra1',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const csvA = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-11-01,ChatGPT Search,14,7,3,running shoes\n2026-11-01,Perplexity,5,2,1,trail shoes';
      const csvB = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-11-01,Perplexity,9,4,2,trail shoes\n2026-11-01,ChatGPT Search,99,40,12,running shoes';

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        // Opposite-order overlapping key batches fired concurrently -> zero deadlock, 1 winner, 1 clean 409
        const [rA, rB] = await Promise.all([
          fetch(`${baseUrl}/api/visibility/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
            body: JSON.stringify({ csvContent: csvA, filename: 'batchA.csv' }),
          }),
          fetch(`${baseUrl}/api/visibility/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
            body: JSON.stringify({ csvContent: csvB, filename: 'batchB.csv' }),
          }),
        ]);
        const statuses = [rA.status, rB.status].sort();
        assert.deepEqual(statuses, [200, 409]);

        // Partial-conflict batch introducing a new key + one existing conflicting key must roll back ALL rows
        const csvPartialConflict =
          'date,platform,brand_mentions,product_mentions,clicks,topic\n' +
          '2026-11-02,Gemini,50,25,10,new topic only\n' +
          '2026-11-01,ChatGPT Search,777,111,22,running shoes';
        const rPartial = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
          body: JSON.stringify({ csvContent: csvPartialConflict, filename: 'partial.csv' }),
        });
        assert.equal(rPartial.status, 409);

        const summaryAfterRollback = await repo.getVisibilitySummary('ws_ra1');
        assert.equal(
          summaryAfterRollback.recentObservations.some((o) => o.discoveryTopic === 'new topic only'),
          false,
          'Rejected batch must NOT leave partial new rows committed'
        );

        // Concurrent unspecified (NULL) vs explicit blank ('') imports do NOT collide
        const csvNull = 'date,platform,brand_mentions,product_mentions,clicks\n2026-11-03,Perplexity,6,3,1';
        const csvBlank = 'date,platform,brand_mentions,product_mentions,clicks,topic\n2026-11-03,Perplexity,8,4,2,';
        const [rNull, rBlank] = await Promise.all([
          fetch(`${baseUrl}/api/visibility/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
            body: JSON.stringify({ csvContent: csvNull, filename: 'null.csv' }),
          }),
          fetch(`${baseUrl}/api/visibility/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
            body: JSON.stringify({ csvContent: csvBlank, filename: 'blank.csv' }),
          }),
        ]);
        assert.equal(rNull.status, 200);
        assert.equal(rBlank.status, 200);

        // Explicit replace_versioned updates cleanly and links supersedes_history_id
        const rReplace = await fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ra1' },
          body: JSON.stringify({ csvContent: csvPartialConflict, filename: 'replace.csv', conflictPolicy: 'replace_versioned' }),
        });
        assert.equal(rReplace.status, 200);
        const hist = await repo.getVisibilityObservationHistory('ws_ra1');
        const shoesHist = hist.filter((h) => h.discoveryTopic === 'running shoes').sort((a, b) => a.versionNumber - b.versionNumber);
        assert.equal(shoesHist.length, 2);
        assert.equal(shoesHist[0].versionNumber, 1);
        assert.equal(shoesHist[1].versionNumber, 2);
        assert.equal(shoesHist[1].supersedesHistoryId, shoesHist[0].id);
      } finally {
        await close();
      }
    });

    test('RA2. PostgresRepository.saveVisibilityImportAtomic acquires sorted pg_advisory_xact_lock BEFORE FOR UPDATE checks and rejects on conflict', async () => {
      const executedSql: Array<{ sql: string; params?: any[] }> = [];
      const makeMockPool = (existingMetricRow: any | null): any => ({
        query: async () => ({ rows: [] }),
        connect: async () => ({
          query: async (sql: string, params?: any[]) => {
            executedSql.push({ sql, params });
            if (sql.includes('FROM ai_visibility_metrics') && sql.includes('FOR UPDATE')) {
              return { rows: existingMetricRow ? [existingMetricRow] : [] };
            }
            if (sql.includes('FROM ai_visibility_observation_history') && sql.includes('FOR UPDATE')) {
              return { rows: [] };
            }
            return { rows: [], rowCount: 1 };
          },
          release: () => {},
        }),
      });

      const pgFresh = new PostgresRepository(makeMockPool(null));
      await pgFresh.saveVisibilityImportAtomic(
        {
          id: 'vimp_pg1',
          workspaceId: 'ws_pg1',
          filename: 'metrics.csv',
          contentHash: 'h_pg1',
          rowCount: 2,
          rejectedRowCount: 0,
          status: 'completed',
          errors: [],
          reportingPeriodStart: '2026-11-01',
          reportingPeriodEnd: '2026-11-01',
          sourcePlatform: 'merchant_csv',
          createdAt: new Date().toISOString(),
        },
        [
          {
            id: 'm_z',
            workspaceId: 'ws_pg1',
            importId: 'vimp_pg1',
            observationDate: '2026-11-01',
            platform: 'Perplexity',
            brandMentions: 2,
            productMentions: 1,
            websiteClicks: 0,
            discoveryTopic: 'z-topic',
            topicPresence: 'specified',
            evidenceSource: 'a.csv',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'm_null',
            workspaceId: 'ws_pg1',
            importId: 'vimp_pg1',
            observationDate: '2026-11-01',
            platform: 'Perplexity',
            brandMentions: 5,
            productMentions: 2,
            websiteClicks: 1,
            discoveryTopic: null,
            topicPresence: 'unspecified',
            evidenceSource: 'a.csv',
            createdAt: new Date().toISOString(),
          },
        ]
      );

      const lockCalls = executedSql.filter((e) => e.sql.includes("pg_advisory_xact_lock(hashtext('aixshop_vis')"));
      assert.equal(lockCalls.length, 2);
      // Sorted canonical keys ensure STR:z-topic vs __NULL__ lock deterministically in sorted order
      assert.equal(lockCalls[0].params?.[0], 'ws_pg1::2026-11-01::Perplexity::STR:z-topic');
      assert.equal(lockCalls[1].params?.[0], 'ws_pg1::2026-11-01::Perplexity::__NULL__');
      const firstSelectIdx = executedSql.findIndex((e) => e.sql.includes('FROM ai_visibility_metrics'));
      const lastLockIdx = executedSql.map((e) => e.sql).lastIndexOf(lockCalls[1].sql);
      assert.ok(lastLockIdx < firstSelectIdx, 'Advisory locks must precede metric SELECT ... FOR UPDATE checks');

      const pgConflict = new PostgresRepository(
        makeMockPool({ id: 'old_m', import_id: 'vimp_other', brand_mentions: 5, product_mentions: 2, website_clicks: 1 })
      );
      await assert.rejects(
        () =>
          pgConflict.saveVisibilityImportAtomic(
            {
              id: 'vimp_pg2',
              workspaceId: 'ws_pg1',
              filename: 'conflict.csv',
              contentHash: 'h_pg2',
              rowCount: 1,
              rejectedRowCount: 0,
              status: 'completed',
              errors: [],
              reportingPeriodStart: '2026-11-01',
              reportingPeriodEnd: '2026-11-01',
              sourcePlatform: 'merchant_csv',
              createdAt: new Date().toISOString(),
            },
            [
              {
                id: 'm_conf',
                workspaceId: 'ws_pg1',
                importId: 'vimp_pg2',
                observationDate: '2026-11-01',
                platform: 'Perplexity',
                brandMentions: 99,
                productMentions: 50,
                websiteClicks: 10,
                discoveryTopic: null,
                topicPresence: 'unspecified',
                evidenceSource: 'conflict.csv',
                createdAt: new Date().toISOString(),
              },
            ]
          ),
        (err: any) => err instanceof VisibilityObservationConflictError && err.statusCode === 409
      );
    });

    // -----------------------------------------------------------------------
    // REMEDIATION B — Mandatory Catalog Version Guard
    // -----------------------------------------------------------------------
    test('RB1. PUT /api/catalog and POST /api/catalog/migrate-demo enforce expectedVersion (400 malformed, 409 missing/stale, single initialization winner)', async () => {
      const repo = new MemoryRepository();
      await repo.registerUser({
        user: { id: 'u_rb1', email: 'rb1@example.com', passwordHash: 'h', fullName: 'RB1' },
        workspace: { id: 'ws_rb1', name: 'WS RB1', slug: 'ws-rb1' },
        session: {
          id: 'sess_rb1',
          sessionTokenHash: crypto.createHash('sha256').update('tok_rb1').digest('hex'),
          userId: 'u_rb1',
          activeWorkspaceId: 'ws_rb1',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        // 1. Concurrent unversioned initializers on empty catalog: ONLY ONE wins, other rejects 409
        const initA = fetch(`${baseUrl}/api/catalog`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ payload: buildSingleProductCatalog('p_init_a', 'SKU-A', 'Winner A') }),
        });
        const initB = fetch(`${baseUrl}/api/catalog`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ payload: buildSingleProductCatalog('p_init_b', 'SKU-B', 'Loser B') }),
        });
        const [resInitA, resInitB] = await Promise.all([initA, initB]);
        const initStatuses = [resInitA.status, resInitB.status].sort();
        assert.deepEqual(initStatuses, [200, 409], 'Concurrent unversioned initialization must allow exactly 1 winner and reject loser 409');

        const catRes = await fetch(`${baseUrl}/api/catalog`, {
          headers: { Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
        });
        const catBody = await catRes.json();
        assert.equal(catBody.catalog.catalogVersion, 2);

        // 2. Subsequent unversioned PUT rejected with 409 + authoritative currentVersion
        const missingVerRes = await fetch(`${baseUrl}/api/catalog`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ payload: buildSingleProductCatalog('p_no_ver', 'SKU-NOVER') }),
        });
        assert.equal(missingVerRes.status, 409);
        const missingVerJson = await missingVerRes.json();
        assert.equal(missingVerJson.code, 'CATALOG_VERSION_CONFLICT');
        assert.equal(missingVerJson.currentVersion, 2);

        // 3. Malformed expectedVersion values (0, -1, 1.5, 'bad', null) return 400 INVALID_CATALOG_VERSION
        for (const badVer of [0, -1, 1.5, 'bad', null]) {
          const badRes = await fetch(`${baseUrl}/api/catalog`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ expectedVersion: badVer, payload: buildEmptyCatalog() }),
          });
          assert.equal(badRes.status, 400, `Malformed expectedVersion ${String(badVer)} must return 400`);
          const badJson = await badRes.json();
          assert.equal(badJson.code, 'INVALID_CATALOG_VERSION');
          assert.equal(badJson.currentVersion, 2);
        }

        // 4. Stale expectedVersion returns 409 + currentVersion
        const staleRes = await fetch(`${baseUrl}/api/catalog`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ expectedVersion: 1, payload: buildSingleProductCatalog('p_stale', 'SKU-STALE') }),
        });
        assert.equal(staleRes.status, 409);
        const staleJson = await staleRes.json();
        assert.equal(staleJson.code, 'CATALOG_VERSION_CONFLICT');
        assert.equal(staleJson.currentVersion, 2);

        // 5. Concurrent versioned PUT with same expectedVersion=2 -> 1 winner (version 3), 1 conflict (409)
        const [conc1, conc2] = await Promise.all([
          fetch(`${baseUrl}/api/catalog`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ expectedVersion: 2, payload: buildSingleProductCatalog('p_v3_a', 'SKU-V3A') }),
          }),
          fetch(`${baseUrl}/api/catalog`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ expectedVersion: 2, payload: buildSingleProductCatalog('p_v3_b', 'SKU-V3B') }),
          }),
        ]);
        assert.deepEqual([conc1.status, conc2.status].sort(), [200, 409]);

        // 6. POST /api/catalog/migrate-demo without expectedVersion rejects overwriting initialized catalog
        const demoBlocked = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({}),
        });
        assert.equal(demoBlocked.status, 409);

        // With current expectedVersion=3 succeeds and bumps version to 4
        const demoOk = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_rb1', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ expectedVersion: 3 }),
        });
        assert.equal(demoOk.status, 200);
        const demoOkJson = await demoOk.json();
        assert.equal(demoOkJson.catalogVersion, 4);
      } finally {
        await close();
      }
    });

    test('RB2. PostgresRepository enforces CatalogVersionValidationError and rejects missing expectedVersion on initialized stores', async () => {
      const makeStorePool = (skuCount: number, version: number): any => ({
        query: async () => ({ rows: [] }),
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('FROM stores') && sql.includes('FOR UPDATE')) {
              return {
                rows: [
                  {
                    id: 'store_ws_rb2',
                    tier: 'Free Audit',
                    sku_limit: null,
                    name: 'RB2 Store',
                    domain: 'rb2.myshopify.com',
                    currency: 'USD',
                    sku_count: skuCount,
                    catalog_completeness_avg: 80,
                    truth_boundary_strictness: 'standard',
                    connectors_json: '[]',
                    catalog_version: version,
                  },
                ],
              };
            }
            if (sql.includes('has_products')) {
              return { rows: [{ has_products: skuCount > 0, has_findings: false, has_actions: false }] };
            }
            return { rows: [], rowCount: 1 };
          },
          release: () => {},
        }),
      });

      const pgInit = new PostgresRepository(makeStorePool(2, 3));
      await assert.rejects(
        () => pgInit.saveWorkspaceCatalog('ws_rb2', buildEmptyCatalog()),
        (err: any) => err instanceof CatalogVersionConflictError && err.currentVersion === 3
      );
      await assert.rejects(
        () => pgInit.saveWorkspaceCatalog('ws_rb2', buildEmptyCatalog(), { expectedVersion: 0 }),
        (err: any) => err instanceof CatalogVersionValidationError && err.statusCode === 400
      );
    });

    test('RA3. [MemoryRepository Parity — Workstream 2] Sorted replace_versioned concurrency, unsorted history lineage & atomic TX rollback', async () => {
      const mem = new MemoryRepository(true);
      await mem.registerUser({
        user: { id: 'u_ra3', email: 'ra3@example.com', passwordHash: 'h', fullName: 'RA3' },
        workspace: { id: 'ws_ra3', name: 'RA3 WS', slug: 'ws-ra3' },
        session: {
          id: 'sess_ra3',
          sessionTokenHash: crypto.createHash('sha256').update('tok_ra3').digest('hex'),
          userId: 'u_ra3',
          activeWorkspaceId: 'ws_ra3',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });

      const makeImp = (id: string, seed: string) => ({
        id,
        workspaceId: 'ws_ra3',
        filename: `${id}.csv`,
        contentHash: crypto.createHash('sha256').update(seed).digest('hex'),
        rowCount: 2,
        rejectedRowCount: 0,
        status: 'completed' as const,
        errors: [],
        reportingPeriodStart: '2026-10-01',
        reportingPeriodEnd: '2026-10-02',
        sourcePlatform: 'merchant_csv',
        createdAt: new Date().toISOString(),
      });
      const makeM = (impId: string, date: string, topic: string | null, mentions: number) => ({
        id: `vm_${impId}_${date}`,
        workspaceId: 'ws_ra3',
        importId: impId,
        observationDate: date,
        platform: 'Perplexity',
        brandMentions: mentions,
        productMentions: mentions,
        websiteClicks: mentions,
        discoveryTopic: topic,
        topicPresence: (topic === null ? 'unspecified' : 'specified') as 'unspecified' | 'specified',
        evidenceSource: `${impId}.csv`,
        createdAt: new Date().toISOString(),
      });

      await mem.saveVisibilityImportAtomic(makeImp('i1', 's1'), [
        makeM('i1', '2026-10-01', null, 1),
        makeM('i1', '2026-10-02', 'topicA', 2),
      ]);

      // Concurrent opposite-order replacements
      await Promise.all([
        mem.saveVisibilityImportAtomic(
          makeImp('i2a', 's2a'),
          [makeM('i2a', '2026-10-01', null, 10), makeM('i2a', '2026-10-02', 'topicA', 20)],
          { conflictPolicy: 'replace_versioned' }
        ),
        mem.saveVisibilityImportAtomic(
          makeImp('i2b', 's2b'),
          [makeM('i2b', '2026-10-02', 'topicA', 40), makeM('i2b', '2026-10-01', null, 30)],
          { conflictPolicy: 'replace_versioned' }
        ),
      ]);

      const hist = (await mem.getVisibilityObservationHistory('ws_ra3', 50))
        .filter((h) => h.observationDate === '2026-10-01')
        .sort((a, b) => a.versionNumber - b.versionNumber);
      assert.deepEqual(hist.map((h) => h.versionNumber), [1, 2, 3]);
      assert.equal(hist[1].supersedesHistoryId, hist[0].id);
      assert.equal(hist[2].supersedesHistoryId, hist[1].id);

      // Simulate mid-save failure in replace_versioned and verify full rollback
      const origSaveMetrics = mem.saveVisibilityMetrics.bind(mem);
      mem.saveVisibilityMetrics = async () => {
        throw new Error('simulated metric write failure');
      };
      await assert.rejects(
        () =>
          mem.saveVisibilityImportAtomic(
            makeImp('i_abort', 'abort'),
            [makeM('i_abort', '2026-10-01', null, 999)],
            { conflictPolicy: 'replace_versioned' }
          ),
        /simulated metric write failure/
      );
      mem.saveVisibilityMetrics = origSaveMetrics;
      const histAfterAbort = (await mem.getVisibilityObservationHistory('ws_ra3', 50)).filter(
        (h) => h.observationDate === '2026-10-01'
      );
      assert.equal(histAfterAbort.length, 3, 'Aborted replacement must roll back history completely');
      const dupSummary = await mem.getVisibilitySummary('ws_ra3');
      assert.equal(dupSummary.imports.some((i) => i.id === 'i_abort'), false);
    });

    test('RB3. [Workstream 3 & 5] Action mutations, import, audit run & migrate-demo propagate catalogVersion cleanly and block stale overwrites', async () => {
      const repo = new MemoryRepository(true);
      await repo.registerUser({
        user: { id: 'u_rb3', email: 'rb3@example.com', passwordHash: 'h', fullName: 'RB3' },
        workspace: { id: 'ws_rb3', name: 'RB3 WS', slug: 'ws-rb3' },
        session: {
          id: 'sess_rb3',
          sessionTokenHash: crypto.createHash('sha256').update('tok_rb3').digest('hex'),
          userId: 'u_rb3',
          activeWorkspaceId: 'ws_rb3',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      await repo.saveSubscription({
        id: 'sub_rb3',
        workspaceId: 'ws_rb3',
        provider: 'sandbox',
        customerId: 'cus_rb3',
        subscriptionId: 'sub_live_rb3',
        tier: 'Growth',
        status: 'active',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
        cancelAtPeriodEnd: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const storeRb3 = await repo.getStoreByWorkspace('ws_rb3');
      if (storeRb3) {
        await repo.saveStoreProfile('ws_rb3', { ...storeRb3, tier: 'Growth', skuLimit: 2500 });
      }

      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok_rb3',
          'X-Requested-With': 'XMLHttpRequest',
        };

        // 1. Seed initial demo catalog cleanly on empty workspace -> catalogVersion becomes 2
        const seedRes = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
        assert.equal(seedRes.status, 200);
        const seedJson = await seedRes.json();
        let currentVersion = seedJson.catalogVersion;
        assert.equal(currentVersion, 2);

        // 2. Run audit -> propagates incremented catalogVersion
        const auditRes = await fetch(`${baseUrl}/api/audit/run`, { method: 'POST', headers });
        assert.equal(auditRes.status, 200);
        const auditJson = await auditRes.json();
        assert.equal(auditJson.catalog.catalogVersion, currentVersion + 1);
        currentVersion = auditJson.catalog.catalogVersion;

        // 3. Approve, dismiss, or recheck action -> propagates updated catalogVersion so PUT succeeds without 409!
        const action = auditJson.catalog.actions.find((a: any) => a.status === 'pending') || auditJson.catalog.actions[0];
        if (action) {
          const dismissRes = await fetch(`${baseUrl}/api/catalog/actions/${action.id}/dismiss`, {
            method: 'POST',
            headers,
          });
          assert.equal(dismissRes.status, 200);
          const dismissJson = await dismissRes.json();
          assert.equal(dismissJson.catalogVersion, currentVersion + 1);
          currentVersion = dismissJson.catalogVersion;
        }

        // 4. Subsequent PUT using propagated currentVersion succeeds
        const latestCat = await (await fetch(`${baseUrl}/api/catalog`, { headers })).json();
        const putRes = await fetch(`${baseUrl}/api/catalog`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ expectedVersion: currentVersion, payload: latestCat.catalog }),
        });
        assert.equal(putRes.status, 200);
        const putJson = await putRes.json();
        assert.equal(putJson.catalogVersion, currentVersion + 1);
        const latestVer = putJson.catalogVersion;

        // 5. Stale migrate-demo with outdated expectedVersion rejects 409 without overwriting user catalog
        const staleDemoRes = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedVersion: currentVersion }),
        });
        assert.equal(staleDemoRes.status, 409);
        const staleDemoJson = await staleDemoRes.json();
        assert.equal(staleDemoJson.code, 'CATALOG_VERSION_CONFLICT');
        assert.equal(staleDemoJson.currentVersion, latestVer);

        // Verify frontend AppContext sends expectedVersion and handles 409 safely without auto-retry
        const appCtxSrc = fs.readFileSync(path.join(process.cwd(), 'src/context/AppContext.tsx'), 'utf8');
        assert.match(appCtxSrc, /apiClient\.migrateDemoData\(expectedVersion\)/);
        assert.match(appCtxSrc, /CATALOG_VERSION_CONFLICT[\s\S]*reloadWorkspaceCatalog/);
        const settingsSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/SettingsPage.tsx'), 'utf8');
        assert.match(settingsSrc, /confirmingDemoOverwrite/);
      } finally {
        await close();
      }
    });

    // -----------------------------------------------------------------------
    // REMEDIATION C — PostgreSQL Advisory Lock & Connection Pool Safety
    // -----------------------------------------------------------------------
    test('RC1. withWorkspaceLock works under pool.max=1 with nested lock/save/mutate/load, releases client before contention backoff, and destroys client if unlock fails', async () => {
      // Simulate strict bounded pool (maxClients = 3) serving 12 concurrent workspaces cleanly
      const MAX_POOL = 3;
      let inUse = 0;
      let peakInUse = 0;
      const advisoryHeld = new Set<string>();
      const clientQueries: string[] = [];

      const createBoundedPool = (options: { failUnlock?: boolean; unlockReturnsFalse?: boolean } = {}) => {
        const destroyedClients: number[] = [];
        const releasedClients: number[] = [];
        let nextClientId = 1;

        const pool: any = {
          connect: async () => {
            const deadline = Date.now() + 2000;
            while (inUse >= MAX_POOL) {
              if (Date.now() > deadline) {
                throw new Error('Pool exhausted: caller held client while sleeping or leaked client');
              }
              await new Promise((r) => setTimeout(r, 5));
            }
            inUse++;
            peakInUse = Math.max(peakInUse, inUse);
            const cid = nextClientId++;
            const heldKeysOnClient = new Set<string>();
            let released = false;

            return {
              query: async (sql: string, params?: any[]) => {
                clientQueries.push(sql);
                const key = String(params?.[0] || 'default');
                if (sql.includes('pg_try_advisory_lock')) {
                  if (advisoryHeld.has(key)) {
                    return { rows: [{ locked: false }] };
                  }
                  advisoryHeld.add(key);
                  heldKeysOnClient.add(key);
                  return { rows: [{ locked: true }] };
                }
                if (sql.includes('pg_advisory_unlock')) {
                  if (options.failUnlock) {
                    throw new Error('connection terminated during unlock');
                  }
                  if (options.unlockReturnsFalse) {
                    return { rows: [{ pg_advisory_unlock: false }] };
                  }
                  advisoryHeld.delete(key);
                  heldKeysOnClient.delete(key);
                  return { rows: [{ pg_advisory_unlock: true }] };
                }
                if (sql.includes('FROM stores') && sql.includes('FOR UPDATE')) {
                  return {
                    rows: [
                      {
                        id: `store_${key}`,
                        tier: 'Free Audit',
                        sku_limit: null,
                        name: 'Mock Store',
                        domain: 'mock.myshopify.com',
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
                if (sql.includes('FROM stores') && sql.includes('sku_count')) {
                  return {
                    rows: [
                      {
                        id: `store_${key}`,
                        name: 'Mock Store',
                        domain: 'mock.myshopify.com',
                        currency: 'USD',
                        skuCount: 0,
                        skuLimit: null,
                        catalogCompletenessAvg: 0,
                        truthBoundaryStrictness: 'standard',
                        tier: 'Free Audit',
                        connectorsJson: [],
                        catalogVersion: 1,
                      },
                    ],
                  };
                }
                return { rows: [], rowCount: 1 };
              },
              release: (destroy?: boolean) => {
                if (released) return;
                released = true;
                inUse--;
                if (destroy) {
                  for (const k of heldKeysOnClient) advisoryHeld.delete(k);
                  destroyedClients.push(cid);
                } else {
                  releasedClients.push(cid);
                }
              },
            };
          },
          destroyedClients,
          releasedClients,
        };
        return pool;
      };

      // 1. Single-connection max=1 reentrant + nested save/load inside withWorkspaceLock without pool starvation
      inUse = 0;
      const singlePool: any = {
        connect: async () => {
          if (inUse >= 1) {
            throw new Error('Pool max=1 violated: nested call attempted second checkout');
          }
          inUse++;
          let released = false;
          return {
            query: async (sql: string, params?: any[]) => {
              clientQueries.push(sql);
              if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
              if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
              if (sql.includes('FROM stores') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [
                    {
                      id: 'store_single',
                      tier: 'Free Audit',
                      sku_limit: null,
                      name: 'Single Store',
                      domain: 'single.myshopify.com',
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
              if (sql.includes('FROM stores')) {
                return {
                  rows: [
                    {
                      id: 'store_single',
                      name: 'Single Store',
                      domain: 'single.myshopify.com',
                      currency: 'USD',
                      skuCount: 0,
                      skuLimit: null,
                      catalogCompletenessAvg: 0,
                      truthBoundaryStrictness: 'standard',
                      tier: 'Free Audit',
                      connectorsJson: [],
                      catalogVersion: 1,
                    },
                  ],
                };
              }
              return { rows: [], rowCount: 1 };
            },
            release: () => {
              if (!released) {
                released = true;
                inUse--;
              }
            },
          };
        },
      };

      const singleRepo = new PostgresRepository(singlePool);
      const nestedResult = await singleRepo.withWorkspaceLock('ws_single', async () => {
        // Same-workspace reentrant call must reuse held client and unlock only once on outer exit
        const inner = await singleRepo.withWorkspaceLock('ws_single', async () => {
          await singleRepo.saveWorkspaceCatalog('ws_single', buildEmptyCatalog('Single'));
          return await singleRepo.loadWorkspaceCatalog('ws_single');
        });
        assert.ok(inner);
        return 'ok';
      });
      assert.equal(nestedResult, 'ok');
      assert.equal(inUse, 0);
      assert.equal(clientQueries.filter((q) => q.includes('pg_try_advisory_lock')).length, 1);
      assert.equal(clientQueries.filter((q) => q.includes('pg_advisory_unlock')).length, 1);

      // 2. 12 concurrent workspaces (> pool max 3) + contented tasks on same workspace release client before 25ms backoff
      inUse = 0;
      peakInUse = 0;
      advisoryHeld.clear();
      const boundedPool = createBoundedPool();
      const repoBounded = new PostgresRepository(boundedPool);

      const multiWsTasks = Array.from({ length: 12 }, (_, idx) =>
        repoBounded.withWorkspaceLock(`ws_conc_${idx % 4}`, async () => {
          await new Promise((r) => setTimeout(r, 30));
          return idx;
        })
      );
      const multiResults = await Promise.all(multiWsTasks);
      assert.equal(multiResults.length, 12);
      assert.equal(inUse, 0);
      assert.ok(peakInUse <= MAX_POOL, `Pool max ${MAX_POOL} respected; peak was ${peakInUse}`);
      assert.equal(advisoryHeld.size, 0);

      // 3. When pg_advisory_unlock fails or returns false, client.release(true) destroys session
      inUse = 0;
      advisoryHeld.clear();
      const failUnlockPool = createBoundedPool({ failUnlock: true });
      const repoFailUnlock = new PostgresRepository(failUnlockPool);
      const valOnUnlockErr = await repoFailUnlock.withWorkspaceLock('ws_destroy_1', async () => 'done');
      assert.equal(valOnUnlockErr, 'done');
      assert.equal(failUnlockPool.destroyedClients.length, 1, 'Failed unlock MUST destroy pool client via release(true)');

      inUse = 0;
      advisoryHeld.clear();
      const falseUnlockPool = createBoundedPool({ unlockReturnsFalse: true });
      const repoFalseUnlock = new PostgresRepository(falseUnlockPool);
      await assert.rejects(
        () =>
          repoFalseUnlock.withWorkspaceLock('ws_destroy_2', async () => {
            throw new Error('inner error');
          }),
        /inner error/
      );
      assert.equal(
        falseUnlockPool.destroyedClients.length,
        1,
        'Unlock returning false after callback throw MUST destroy pool client via release(true)'
      );
    });

    test('RC2. [Workstream 4] Nested unlock failure & savepoint rollback failure poison connection for release(true) and deterministic cross-workspace lock ordering prevents deadlock', async () => {
      // 1. Track pooled clients across nested unlock failure & savepoint rollback failure
      let nextId = 1;
      const destroyedIds: number[] = [];
      const releasedIds: number[] = [];
      const activePoolIds = new Set<number>();

      const makeMockPool = (opts: {
        failNestedUnlock?: boolean;
        nestedUnlockFalse?: boolean;
        failSavepointRollback?: boolean;
      }) => ({
        connect: async () => {
          const cid = nextId++;
          activePoolIds.add(cid);
          let released = false;
          const heldKeys = new Set<string>();
          return {
            cid,
            query: async (sql: string, params?: any[]) => {
              const key = String(params?.[0] || '');
              if (sql.includes('pg_try_advisory_lock')) {
                heldKeys.add(key);
                return { rows: [{ locked: true }] };
              }
              if (sql.includes('pg_advisory_unlock')) {
                if (key === 'ws_b_inner') {
                  if (opts.failNestedUnlock) throw new Error('nested unlock connection error');
                  if (opts.nestedUnlockFalse) return { rows: [{ pg_advisory_unlock: false }] };
                }
                heldKeys.delete(key);
                return { rows: [{ pg_advisory_unlock: true }] };
              }
              if (sql.startsWith('ROLLBACK TO SAVEPOINT') && opts.failSavepointRollback) {
                throw new Error('savepoint rollback lost');
              }
              return { rows: [], rowCount: 1 };
            },
            release: (destroy?: boolean) => {
              if (released) return;
              released = true;
              activePoolIds.delete(cid);
              if (destroy) destroyedIds.push(cid);
              else releasedIds.push(cid);
            },
          };
        },
      });

      // A. Nested unlock returning false marks connection poisoned -> outer exit destroys client (even though outer unlock returned true)
      const pFalse = makeMockPool({ nestedUnlockFalse: true });
      const repoFalse = new PostgresRepository(pFalse as any);
      const okNested = await repoFalse.withWorkspaceLock('ws_a_outer', async () =>
        repoFalse.withWorkspaceLock('ws_b_inner', async () => 'nested_ok')
      );
      assert.equal(okNested, 'nested_ok');
      assert.equal(destroyedIds.length, 1, 'Failed nested unlock must poison and destroy pooled client');
      assert.equal(releasedIds.length, 0);

      // B. Nested unlock throwing when inner operation fails MUST preserve original error AND destroy client
      destroyedIds.length = 0;
      releasedIds.length = 0;
      const pThrow = makeMockPool({ failNestedUnlock: true });
      const repoThrow = new PostgresRepository(pThrow as any);
      await assert.rejects(
        () =>
          repoThrow.withWorkspaceLock('ws_a_outer', async () =>
            repoThrow.withWorkspaceLock('ws_b_inner', async () => {
              throw new Error('original_operation_failure');
            })
          ),
        /original_operation_failure/
      );
      assert.equal(destroyedIds.length, 1);

      // Next operation on repoThrow still works on a healthy new client
      const recovered = await repoThrow.withWorkspaceLock('ws_a_outer', async () => 'clean_new_client');
      assert.equal(recovered, 'clean_new_client');
      assert.equal(releasedIds.length, 1);

      // C. Savepoint rollback failure inside nested transaction marks client poisoned -> destroyed on outer unlock
      destroyedIds.length = 0;
      releasedIds.length = 0;
      const pSp = makeMockPool({ failSavepointRollback: true });
      const repoSp = new PostgresRepository(pSp as any);
      await assert.rejects(
        () =>
          repoSp.withWorkspaceLock('ws_a_outer', async () =>
            (repoSp as any).withTransaction(async () =>
              (repoSp as any).withTransaction(async () => {
                throw new Error('inner_sp_failure');
              })
            )
          ),
        /inner_sp_failure/
      );
      assert.equal(destroyedIds.length, 1, 'Failed savepoint rollback must destroy pooled client');

      // D. Cross-workspace deterministic lock ordering on PostgresRepository AND MemoryRepository
      releasedIds.length = 0;
      destroyedIds.length = 0;
      const pOrder = makeMockPool({});
      const repoOrder = new PostgresRepository(pOrder as any);
      // Ascending order works
      assert.equal(
        await repoOrder.withWorkspaceLock('ws_alpha', async () =>
          repoOrder.withWorkspaceLock('ws_zeta', async () => 'ordered_ok')
        ),
        'ordered_ok'
      );
      // Reverse order rejects deterministically BEFORE attempting inner lock
      await assert.rejects(
        () =>
          repoOrder.withWorkspaceLock('ws_zeta', async () =>
            repoOrder.withWorkspaceLock('ws_alpha', async () => 'unreachable')
          ),
        (err: any) => err instanceof WorkspaceLockOrderError && err.code === 'WORKSPACE_LOCK_ORDER_VIOLATION'
      );
      assert.equal(activePoolIds.size, 0, 'Outer client must always be released cleanly after order error');

      // MemoryRepository parity: same-workspace reentrant works, ascending works, reverse rejects
      const memOrder = new MemoryRepository(true);
      await memOrder.withWorkspaceLock('ws_m_a', async () =>
        memOrder.withWorkspaceLock('ws_m_a', async () =>
          memOrder.withWorkspaceLock('ws_m_b', async () => 'ok')
        )
      );
      await assert.rejects(
        () =>
          memOrder.withWorkspaceLock('ws_m_b', async () =>
            memOrder.withWorkspaceLock('ws_m_a', async () => 'unreachable')
          ),
        (err: any) => err instanceof WorkspaceLockOrderError
      );
      assert.equal(memOrder.getActiveWorkspaceLockCount(), 0);
    });

    // -----------------------------------------------------------------------
    // REMEDIATION D — CI Dependency Installation Consistency
    // -----------------------------------------------------------------------
    test('RD1. CI postgres-integration workflow installs with bun --frozen-lockfile and passes explicit pg_isready user/db flags', () => {
      const ciPath = path.join(process.cwd(), '.github/workflows/ci.yml');
      const bunLockPath = path.join(process.cwd(), 'bun.lock');
      assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist');
      assert.ok(fs.existsSync(bunLockPath), 'bun.lock must exist');
      const ciContent = fs.readFileSync(ciPath, 'utf8');
      assert.doesNotMatch(ciContent, /\bnpm ci\b/, 'CI must not invoke npm ci when package-lock.json is absent');
      assert.match(ciContent, /oven-sh\/setup-bun/);
      assert.match(ciContent, /bun install --frozen-lockfile/);
      assert.match(ciContent, /--health-cmd "pg_isready -U aixshop -d aixshop_test"/);
      assert.doesNotMatch(ciContent, /--health-cmd pg_isready\s*$/m);
    });

    // -----------------------------------------------------------------------
    // REMEDIATION E — Production Authentication Rate-Limit Failure Policy
    // -----------------------------------------------------------------------
    test('RE1. Production authRateLimiter fails closed (503) on storage outage by default, permits explicit fallback_local override, recovers cleanly, and keeps health probes secret-free', async () => {
      // 1. Policy resolver verification
      assert.equal(resolveAuthRateLimitFailurePolicy('production', undefined).mode, 'fail_closed');
      assert.equal(resolveAuthRateLimitFailurePolicy('production', 'fallback_local').mode, 'fallback_local');
      assert.equal(resolveAuthRateLimitFailurePolicy('development', undefined).mode, 'fallback_local');
      assert.equal(resolveAuthRateLimitFailurePolicy('production', 'invalid_mode').valid, false);

      // 2. Production default: storage outage fails closed with HTTP 503 on both /api/auth/login and /api/auth/register
      process.env.NODE_ENV = 'production';
      delete process.env.AUTH_RATE_LIMIT_FAILURE_MODE;

      let storageShouldFail = true;
      const outageRepo = new MemoryRepository();
      const origConsume = outageRepo.consumeRateLimit.bind(outageRepo);
      outageRepo.consumeRateLimit = async (key: string, max: number, windowMs: number) => {
        if (storageShouldFail) {
          throw new Error('PG pool timeout postgres://user:SECRET_DB_PASS@host/db');
        }
        return origConsume(key, max, windowMs);
      };

      const appFailClosed = createApp(outageRepo);
      const srv1 = await startTempAppServer(appFailClosed);
      try {
        const loginOutage = await fetch(`${srv1.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
        });
        assert.equal(loginOutage.status, 503);
        const loginJson = await loginOutage.json();
        assert.equal(loginJson.code, 'RATE_LIMITER_UNAVAILABLE');

        const regOutage = await fetch(`${srv1.baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'new@example.com', password: 'Password123!', fullName: 'N', workspaceName: 'W' }),
        });
        assert.equal(regOutage.status, 503);
        const regJson = await regOutage.json();
        assert.equal(regJson.code, 'RATE_LIMITER_UNAVAILABLE');

        const healthOutage = await fetch(`${srv1.baseUrl}/api/health`);
        const healthRaw = await healthOutage.text();
        assert.doesNotMatch(healthRaw, /SECRET_DB_PASS|user@example\.com|127\.0\.0\.1/);
        const healthParsed = JSON.parse(healthRaw);
        assert.equal(healthParsed.authRateLimiter.policy, 'fail_closed');
        assert.equal(healthParsed.authRateLimiter.storageDegraded, true);

        // Recover shared storage -> requests work normally and diagnostics clear degraded flag
        storageShouldFail = false;
        const loginRecovered = await fetch(`${srv1.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
        });
        assert.equal(loginRecovered.status, 401);
        const diagAfterRecovery = getAuthRateLimiterDiagnostics();
        assert.equal(diagAfterRecovery.storageDegraded, false);
        assert.ok(diagAfterRecovery.lastRecoveredAt);
      } finally {
        await srv1.close();
      }

      // 3. Explicit production override fallback_local falls back cleanly & marks degraded in health probe
      _resetRateLimiter();
      storageShouldFail = true;
      process.env.AUTH_RATE_LIMIT_FAILURE_MODE = 'fallback_local';
      const appFallback = createApp(outageRepo);
      const srv2 = await startTempAppServer(appFallback);
      try {
        const resFallback = await fetch(`${srv2.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'override@example.com', password: 'pw' }),
        });
        assert.equal(resFallback.status, 401);

        const readyRes = await fetch(`${srv2.baseUrl}/api/health/ready`);
        const readyJson = await readyRes.json();
        assert.equal(readyJson.authRateLimiter.policy, 'fallback_local');
        assert.equal(readyJson.authRateLimiter.storageDegraded, true);
      } finally {
        await srv2.close();
      }
    });

    test('RE2. [Multi-Instance Shared-Store HTTP] Alternating instances share rate-limit budget cleanly and cannot bypass limits across instances', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.AUTH_RATE_LIMIT_FAILURE_MODE;
      _resetRateLimiter();

      const sharedRepoA = new MemoryRepository(true);
      const sharedRepoB = new MemoryRepository(true);
      // Share identical backing rate-limit state across independent Express app instances
      sharedRepoB.consumeRateLimit = sharedRepoA.consumeRateLimit.bind(sharedRepoA);

      const srvA = await startTempAppServer(createApp(sharedRepoA));
      const srvB = await startTempAppServer(createApp(sharedRepoB));
      try {
        for (let i = 0; i < 20; i++) {
          const base = i % 2 === 0 ? srvA.baseUrl : srvB.baseUrl;
          const r = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.42' },
            body: JSON.stringify({ email: `u${i}@example.com`, password: 'wrong' }),
          });
          assert.equal(r.status, 401);
        }
        // 21st request hits Instance B -> must be 429 globally
        const r21 = await fetch(`${srvB.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.42' },
          body: JSON.stringify({ email: 'u21@example.com', password: 'wrong' }),
        });
        assert.equal(r21.status, 429);
      } finally {
        await srvA.close();
        await srvB.close();
      }
    });

    // -----------------------------------------------------------------------
    // REMEDIATION F — Public AI Studio Artifact Exposure Blocking
    // -----------------------------------------------------------------------
    test('RF1. /assets/aistudio/* artifacts and normalized bypass paths return 404 while original files are archived outside public/', async () => {
      const publicAistudioDir = path.join(process.cwd(), 'public/assets/aistudio');
      assert.equal(fs.existsSync(publicAistudioDir), false, 'public/assets/aistudio must not remain inside public/');

      const archiveDir = path.join(process.cwd(), 'docs/archive/aistudio');
      const archivedFiles = fs.readdirSync(archiveDir);
      assert.ok(archivedFiles.includes('Paste_November_14__2026_-_8_30PM_b6c0943e'));
      assert.ok(archivedFiles.includes('Paste_November_15__2026_-_4_18PM_bccda2c6'));
      assert.ok(archivedFiles.includes('Allbirds_Shopify_products_fdd9af86.txt'));

      const repo = new MemoryRepository();
      const app = createApp(repo);
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const probePaths = [
          '/assets/aistudio/Paste_November_14__2026_-_8_30PM_b6c0943e',
          '/assets/aistudio/Allbirds_Shopify_products_fdd9af86.txt',
          '/assets/aistudio/Paste_November_13__2026_-_6_26PM_97202dde',
          '/assets/%61istudio/Paste_November_12__2026_-_6_20PM_bdc47db1',
          '/assets/foo/../aistudio/Allbirds_Shopify_products_fdd9af86.txt',
          '/assets/aistudio/Paste_November_15__2026_-_4_18PM_bccda2c6',
        ];
        for (const p of probePaths) {
          const r = await fetch(`${baseUrl}${p}`);
          assert.equal(r.status, 404, `Artifact path ${p} must return 404`);
          const j = await r.json();
          assert.equal(j.code, 'RESOURCE_NOT_FOUND');
        }
      } finally {
        await close();
      }
    });

    test('RF2. [Workstream 7] Express blocks encoded/traversal artifact variants while serving normal assets/API cleanly, and source code has zero runtime dependencies on public/assets/aistudio', async () => {
      // 1. Verify zero runtime source code imports or references to /assets/aistudio or Paste_November_ outside tests
      const srcFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx|js|jsx|html|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
            srcFiles.push(full);
          }
        }
      };
      walk(path.join(process.cwd(), 'src'));
      srcFiles.push(path.join(process.cwd(), 'index.html'));
      srcFiles.push(path.join(process.cwd(), 'server.ts'));

      for (const file of srcFiles) {
        const rel = path.relative(process.cwd(), file);
        if (rel === 'src/server/app.ts') continue; // contains blocker regex only
        const txt = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(
          txt,
          /assets\/aistudio|Paste_November_|Allbirds_Shopify_products_/,
          `Runtime file ${rel} must not depend on internal AI Studio artifacts`
        );
      }

      // 2. Verify normal Express public/health endpoints succeed while protected artifact variants return 404
      const repo = new MemoryRepository();
      const app = createApp(repo);
      const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aixshop-public-test-'));
      fs.writeFileSync(path.join(staticDir, 'health-asset.txt'), 'ok-public-asset');
      app.use((await import('express')).default.static(staticDir));
      const { baseUrl, close } = await startTempAppServer(app);
      try {
        const allowed = await fetch(`${baseUrl}/health-asset.txt`);
        assert.equal(allowed.status, 200);
        assert.equal(await allowed.text(), 'ok-public-asset');

        const blockedVariants = [
          '/assets/aistudio',
          '/assets/aistudio/',
          '/ASSETS/AISTUDIO/Paste_November_15__2026_-_4_18PM_bccda2c6',
          '//assets//aistudio/Paste_November_08__2026_-_11_00AM_d49897db',
          '/assets\\aistudio\\Paste_November_09__2026_-_5_21PM_aa5dc47b',
        ];
        for (const p of blockedVariants) {
          const r = await fetch(`${baseUrl}${p}`);
          assert.equal(r.status, 404, `Variant ${p} must be blocked by Express middleware`);
        }
      } finally {
        await close();
        fs.rmSync(staticDir, { recursive: true, force: true });
      }
    });

    test('RF3. [Workstream D] Production Vite build output contains zero AI Studio artifacts in dist/ while preserving SPA assets', async () => {
      const { build } = await import('vite');
      const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'aixshop-dist-check-'));
      try {
        await build({
          logLevel: 'silent',
          build: {
            outDir: tmpDist,
            emptyOutDir: true,
          },
        });

        const builtFiles: string[] = [];
        const walkBuilt = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkBuilt(full);
            else builtFiles.push(path.relative(tmpDist, full));
          }
        };
        walkBuilt(tmpDist);

        assert.ok(builtFiles.includes('index.html'), 'Production build must output index.html');
        assert.ok(builtFiles.some(f => f.startsWith('assets/') && f.endsWith('.js')), 'Production build must output JS bundle');
        for (const rel of builtFiles) {
          assert.doesNotMatch(
            rel,
            /aistudio|Paste_November_|Allbirds_Shopify_products_/i,
            `Built artifact "${rel}" must never appear in Vite output`
          );
        }
      } finally {
        fs.rmSync(tmpDist, { recursive: true, force: true });
      }
    });
  });
});
