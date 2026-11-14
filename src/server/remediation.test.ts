import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import {
  evaluateFeedReadiness,
  exportToCsv,
  mapProductToGmcRow,
  mapProductToMetaRow,
  mapProductToSchemaOrgJsonLd,
  mapProductVariantsToGmcRows,
  mapProductVariantsToMetaRows,
  resolveVariantMpn,
} from '../domain/feed/feedValidationEngine';
import {
  evaluateDiscoveryReadiness,
  normalizeVerifiedDomainHostname,
  validateCanonicalProductUrl,
} from '../domain/aiDiscovery/discoveryEngine';
import { parseCsvRfc4180, computeCsvContentHash } from './routes/visibilityRoutes';
import { BillingService, validateBillingLeaseConfig } from './services/billingService';
import { SandboxBillingProvider } from './billing/providerAdapter';
import { Product } from '../types';

function makeOffer(overrides: Partial<Product['offers'][0]> = {}): Product['offers'][0] {
  return {
    id: 'off_remed_1',
    channel: 'Direct Storefront',
    price: 38.5,
    currency: 'USD',
    availability: 'in_stock',
    condition: 'new',
    url: 'https://trusted-shop.com/products/ceramic-pour-over-dripper',
    merchantId: 'merch_1',
    lastSync: new Date().toISOString(),
    ...overrides,
  };
}

function makeVariant(overrides: Partial<Product['variants'][0]> = {}): Product['variants'][0] {
  return {
    id: 'var_remed_1',
    sku: 'SKU-DRIP-01',
    barcode: '4006381333931',
    title: 'Standard 02',
    price: 38.5,
    inventoryCount: 18,
    attributes: {},
    ...overrides,
  };
}

function makeValidProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod_remed_1',
    title: 'Ceramic Pour-Over Dripper V2',
    brand: 'AromaCraft',
    category: 'Kitchen & Dining',
    description: 'Hand-glazed stoneware pour-over coffee dripper designed for thermal stability and clean extraction.',
    image: 'https://cdn.trusted-shop.com/images/dripper.jpg',
    status: 'active',
    completenessScore: 95,
    evidenceCoverageScore: 90,
    externalDiscoveryStatus: 'observed_in_sample',
    attributes: {
      material: 'Stoneware',
      color: 'Matte Black',
      canonicalProductUrl: 'https://trusted-shop.com/products/ceramic-pour-over-dripper',
      urlProvenance: 'verified_storefront_domain',
    },
    variants: [makeVariant()],
    offers: [makeOffer()],
    evidenceDocuments: [],
    findingsCount: 0,
    lastAudited: new Date().toISOString(),
    ...overrides,
  };
}

describe('AIXSHOP v1.0 — Remediation Verification Suite (C1-C3, E1-E2, M010-S, M010-C, V-DATA, AD-URL, CSV-STRICT)', () => {
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

  async function registerTenant(prefix: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.com`,
        password: 'Password123!',
        fullName: 'Tenant Admin',
        workspaceName: `${prefix} Workspace`,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    return { token: body.token as string, workspace: body.workspace };
  }

  // =========================================================================
  // SECTION 1: C1–C3 — Feed Validation & Export Integrity
  // =========================================================================
  describe('C1-C3: Feed Validation, Identifier Semantics & Export Integrity', () => {
    test('1. SKU present, MPN absent -> SKU exported, MPN omitted (never fabricated from SKU)', () => {
      const p = makeValidProduct({
        variants: [makeVariant({ id: 'v1', sku: 'MERCH-SKU-999', barcode: '4006381333931', title: 'Default', price: 25, inventoryCount: 5 })],
      });
      assert.equal(resolveVariantMpn(p, p.variants[0]), '');

      const gmc = mapProductToGmcRow(p, 'USD');
      assert.equal(gmc.sku, 'MERCH-SKU-999');
      assert.equal(gmc.mpn, undefined);
      assert.equal(gmc.gtin, '4006381333931');
      assert.equal(gmc.identifier_exists, 'yes');

      const meta = mapProductToMetaRow(p, 'USD');
      assert.equal(meta.sku, 'MERCH-SKU-999');
      assert.equal(meta.mpn, undefined);

      const ld = mapProductToSchemaOrgJsonLd(p, 'USD');
      assert.equal(ld.sku, 'MERCH-SKU-999');
      assert.equal(ld.mpn, undefined);
    });

    test('2. MPN present, SKU absent -> explicit MPN preserved, validation reports missing SKU without inventing SKU', () => {
      const p = makeValidProduct({
        variants: [
          {
            id: 'v1',
            sku: '',
            barcode: '',
            title: 'Default',
            price: 49,
            inventoryCount: 3,
            attributes: { mpn: 'MFG-DRIP-778' },
          },
        ],
      });
      const gmc = mapProductToGmcRow(p, 'USD');
      assert.equal(gmc.sku, undefined);
      assert.equal(gmc.mpn, 'MFG-DRIP-778');
      assert.equal(gmc.gtin, undefined);
      assert.equal(gmc.identifier_exists, 'yes');

      const ld = mapProductToSchemaOrgJsonLd(p, 'USD');
      assert.equal(ld.sku, undefined);
      assert.equal(ld.mpn, 'MFG-DRIP-778');

      const report = evaluateFeedReadiness([p], 'google_merchant_center', 'USD');
      assert.equal(report.evaluations[0].isValid, false);
      assert.ok(report.evaluations[0].errors.some(e => e.field === 'sku'));
    });

    test('3. Both SKU and MPN present -> strictly distinct fields in GMC, Meta, Schema.org', () => {
      const p = makeValidProduct({
        variants: [
          {
            id: 'v1',
            sku: 'STORE-SKU-10',
            barcode: '4006381333931',
            title: 'Default',
            price: 60,
            inventoryCount: 4,
            attributes: { manufacturerPartNumber: 'OEM-MPN-4200' },
          },
        ],
      });
      const gmc = mapProductToGmcRow(p, 'USD');
      assert.equal(gmc.sku, 'STORE-SKU-10');
      assert.equal(gmc.mpn, 'OEM-MPN-4200');
      assert.notEqual(gmc.sku, gmc.mpn);
    });

    test('4. GTIN valid vs invalid -> valid GTIN accepted, bad checksum rejected and omitted', () => {
      const badGtinProduct = makeValidProduct({
        variants: [
          makeVariant({
            id: 'v1',
            sku: 'SKU-BAD-GTIN',
            barcode: '4006381333939', // wrong check digit
            title: 'Default',
            price: 20,
            inventoryCount: 2,
          }),
        ],
      });
      const gmc = mapProductToGmcRow(badGtinProduct, 'USD');
      assert.equal(gmc.gtin, undefined);
      assert.equal(gmc.identifier_exists, 'no');

      const report = evaluateFeedReadiness([badGtinProduct], 'google_merchant_center', 'USD');
      assert.equal(report.evaluations[0].isValid, false);
      assert.ok(report.evaluations[0].errors.some(e => e.field === 'gtin' && e.variantId === 'v1'));
    });

    test('5. Brand present with no GTIN/MPN (only merchant SKU) -> identifier_exists is "no"', () => {
      const p = makeValidProduct({
        variants: [makeVariant({ id: 'v1', sku: 'INTERNAL-SKU-ONLY', barcode: '', title: 'Default', price: 29, inventoryCount: 9 })],
      });
      const gmc = mapProductToGmcRow(p, 'USD');
      assert.equal(gmc.brand, 'AromaCraft');
      assert.equal(gmc.sku, 'INTERNAL-SKU-ONLY');
      assert.equal(gmc.gtin, undefined);
      assert.equal(gmc.mpn, undefined);
      assert.equal(gmc.identifier_exists, 'no');
    });

    test('6. Multi-variant product exports distinct variant rows with distinct IDs, SKUs, MPNs, GTINs, prices & catches broken 2nd variant', () => {
      const multi = makeValidProduct({
        id: 'prod_multi_v',
        title: 'Heritage Kettle',
        variants: [
          {
            id: 'var_blk',
            sku: 'KET-BLK',
            barcode: '4006381333931',
            title: 'Matte Black',
            price: 89.0,
            inventoryCount: 7,
            attributes: { mpn: 'HK-BLK-100' },
          },
          {
            id: 'var_wht',
            sku: 'KET-WHT',
            barcode: '4006381333939', // Invalid GTIN on variant 2!
            title: 'Chalk White',
            price: 94.5,
            inventoryCount: 0,
            attributes: { mpn: 'HK-WHT-200' },
          },
        ],
      });

      const report = evaluateFeedReadiness([multi], 'google_merchant_center', 'USD');
      assert.equal(report.evaluations[0].isValid, false);
      assert.ok(report.evaluations[0].errors.some(e => e.variantId === 'var_wht' && e.field === 'gtin'));

      const gmcRows = mapProductVariantsToGmcRows(multi, 'USD');
      assert.equal(gmcRows.length, 2);
      assert.equal(gmcRows[0].id, 'var_blk');
      assert.equal(gmcRows[0].item_group_id, 'prod_multi_v');
      assert.equal(gmcRows[0].sku, 'KET-BLK');
      assert.equal(gmcRows[0].mpn, 'HK-BLK-100');
      assert.equal(gmcRows[0].gtin, '4006381333931');
      assert.equal(gmcRows[0].price, '89.00 USD');
      assert.equal(gmcRows[0].availability, 'in_stock');

      assert.equal(gmcRows[1].id, 'var_wht');
      assert.equal(gmcRows[1].sku, 'KET-WHT');
      assert.equal(gmcRows[1].mpn, 'HK-WHT-200');
      assert.equal(gmcRows[1].gtin, undefined);
      assert.equal(gmcRows[1].price, '94.50 USD');
      assert.equal(gmcRows[1].availability, 'out_of_stock');

      const metaRows = mapProductVariantsToMetaRows(multi, 'USD');
      assert.equal(metaRows.length, 2);
      assert.equal(metaRows[1].id, 'var_wht');
      assert.equal(metaRows[1].availability, 'out of stock');
    });

    test('7. Missing/zero price, missing/invalid ISO currency, and missing required attributes are rejected across all platforms', () => {
      const noPrice = makeValidProduct({
        id: 'p_noprice',
        variants: [makeVariant({ id: 'v1', sku: 'S1', barcode: '4006381333931', title: 'D', price: 0, inventoryCount: 2 })],
        offers: [makeOffer({ id: 'o1', price: 0, currency: 'USD', availability: 'in_stock', url: 'https://trusted-shop.com/p/1' })],
      });
      const badCurrency = makeValidProduct({
        id: 'p_badcurr',
        offers: [makeOffer({ id: 'o1', price: 19.99, currency: 'ZZZ', availability: 'in_stock', url: 'https://trusted-shop.com/p/2' })],
      });
      const missingCurrency = makeValidProduct({
        id: 'p_miss_curr',
        offers: [makeOffer({ id: 'o1', price: 19.99, currency: '', availability: 'in_stock', url: 'https://trusted-shop.com/p/3' })],
      });
      const missingAttrs = makeValidProduct({
        id: 'p_missing_req',
        title: '',
        description: '',
        image: 'ftp://invalid-image',
        brand: 'Unspecified',
        variants: [],
        offers: [],
        attributes: {},
      });

      const gmcRep = evaluateFeedReadiness([noPrice, badCurrency, missingCurrency, missingAttrs], 'google_merchant_center', 'USD');
      assert.equal(gmcRep.invalidProductsCount, 4);
      assert.ok(gmcRep.evaluations[0].errors.some(e => e.field === 'price'));
      assert.ok(gmcRep.evaluations[1].errors.some(e => e.field === 'currency'));
      assert.ok(gmcRep.evaluations[2].errors.some(e => e.field === 'currency'));
      assert.ok(gmcRep.evaluations[3].errors.some(e => e.field === 'title'));
      assert.ok(gmcRep.evaluations[3].errors.some(e => e.field === 'image_link'));
      assert.ok(gmcRep.evaluations[3].errors.some(e => e.field === 'link'));
      assert.ok(gmcRep.evaluations[3].errors.some(e => e.field === 'availability'));

      const metaRep = evaluateFeedReadiness([missingAttrs], 'meta_commerce', 'USD');
      assert.equal(metaRep.evaluations[0].isValid, false);
      const schemaRep = evaluateFeedReadiness([badCurrency, missingAttrs], 'schema_org', 'USD');
      assert.equal(schemaRep.invalidProductsCount, 2);
    });

    test('8. exportToCsv deterministically preserves union headers when MPN/GTIN only appear on later rows & repeated export is byte-identical', () => {
      const p1 = makeValidProduct({
        id: 'p_first',
        variants: [makeVariant({ id: 'v1', sku: 'S-ONLY-1', barcode: '', title: 'A', price: 15, inventoryCount: 2 })],
      });
      const p2 = makeValidProduct({
        id: 'p_second',
        variants: [
          {
            id: 'v2',
            sku: 'S-AND-MPN-2',
            barcode: '4006381333931',
            title: 'B',
            price: 30,
            inventoryCount: 2,
            attributes: { mpn: 'REAL-MPN-2' },
          },
        ],
      });
      const rows1 = [p1, p2].flatMap(p => mapProductVariantsToGmcRows(p, 'USD'));
      const rows2 = [p1, p2].flatMap(p => mapProductVariantsToGmcRows(p, 'USD'));
      const csvA = exportToCsv(rows1);
      const csvB = exportToCsv(rows2);
      assert.equal(csvA, csvB);
      const headerLine = csvA.split('\n')[0];
      assert.match(headerLine, /"mpn"/);
      assert.match(headerLine, /"gtin"/);
      assert.match(csvA, /REAL-MPN-2/);
    });

    test('9. HTTP /api/feed/export?filter=valid_only excludes invalid products, reports X-AIXSHOP-Skipped-Products / Skipped-Reasons, and never leaks MPN from SKU', async () => {
      const tenant = await registerTenant('feed_exp');
      const validP = makeValidProduct({ id: 'p_good_http' });
      const brokenP = makeValidProduct({
        id: 'p_bad_http',
        variants: [makeVariant({ id: 'v_bad', sku: 'BROKEN-SKU', barcode: '1234567890123', title: 'Bad', price: 0, inventoryCount: 1 })],
        offers: [makeOffer({ id: 'o_bad', price: 0, currency: 'USD', availability: 'in_stock', url: 'https://trusted-shop.com/products/bad' })],
      });

      const current = await repo.loadWorkspaceCatalog(tenant.workspace.id);
      assert.ok(current);
      await repo.saveWorkspaceCatalog(tenant.workspace.id, {
        findings: current.findings || [],
        actions: current.actions || [],
        evidence: current.evidence || [],
        storeProfile: current.storeProfile,
        products: [validP, brokenP],
        variants: [...validP.variants, ...brokenP.variants],
        offers: [...validP.offers, ...brokenP.offers],
      });

      const res = await fetch(`${baseUrl}/api/feed/export?platform=google_merchant_center&filter=valid_only`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-aixshop-exported-products'), '1');
      assert.equal(res.headers.get('x-aixshop-skipped-products'), '1');
      const skippedReasons = JSON.parse(res.headers.get('x-aixshop-skipped-reasons') || '[]');
      assert.equal(skippedReasons.length, 1);
      assert.equal(skippedReasons[0].productId, 'p_bad_http');

      const csvText = await res.text();
      assert.match(csvText, /p_good_http/);
      assert.doesNotMatch(csvText, /p_bad_http/);
      assert.doesNotMatch(csvText, /BROKEN-SKU/);
    });
  });

  // =========================================================================
  // SECTION 2: E1–E2 — Billing Lease Heartbeat & Mutation-Time Expiration
  // =========================================================================
  describe('E1-E2: Billing Automatic Heartbeat, Expiry Enforcement & Concurrency', () => {
    function signSandbox(payload: any, secret: string): string {
      const bodyStr = JSON.stringify(payload);
      return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
    }

    test('1. validateBillingLeaseConfig validates bounds strictly (rejects <50ms, NaN, heartbeat >= lease)', () => {
      assert.throws(() => validateBillingLeaseConfig({ leaseDurationMs: 20, heartbeatIntervalMs: 10 }));
      assert.throws(() => validateBillingLeaseConfig({ leaseDurationMs: NaN, heartbeatIntervalMs: 10 }));
      assert.throws(() => validateBillingLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 100 }));
      assert.throws(() => validateBillingLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 150 }));
      const ok = validateBillingLeaseConfig({ leaseDurationMs: 120, heartbeatIntervalMs: 30 });
      assert.deepEqual(ok, { leaseDurationMs: 120, heartbeatIntervalMs: 30 });
    });

    test('2. Long processing exceeding original leaseDurationMs succeeds SOLELY via automatic internal heartbeat inside handleWebhook()', async () => {
      const tenant = await registerTenant('bill_hb_ok');
      const secret = 'test_hb_secret_123';
      const provider = new SandboxBillingProvider(secret);

      let renewalCalls = 0;
      const proxyRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'renewBillingEventLease') {
            return async (eventId: string, leaseOwner: string, extendMs: number) => {
              renewalCalls++;
              return target.renewBillingEventLease(eventId, leaseOwner, extendMs);
            };
          }
          if (prop === 'getWorkspaceById') {
            return async (wsId: string) => {
              // Exceeds 120ms leaseDurationMs, relying purely on ~35ms automatic heartbeat
              await new Promise(r => setTimeout(r, 210));
              return target.getWorkspaceById(wsId);
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });

      const svc = new BillingService(proxyRepo, provider, { leaseDurationMs: 120, heartbeatIntervalMs: 35 });
      const payload = {
        id: `evt_hb_long_${Date.now()}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: tenant.workspace.id,
            customer: 'cust_hb_1',
            subscription: 'sub_hb_1',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };
      const raw = JSON.stringify(payload);
      const res = await svc.handleWebhook(raw, signSandbox(payload, secret));
      assert.equal(res.success, true);
      assert.equal(res.action, 'processed');
      assert.ok(renewalCalls >= 2, `Expected automatic heartbeat renewals (>=2), got ${renewalCalls}`);

      const sub = await repo.getSubscriptionByWorkspace(tenant.workspace.id);
      assert.equal(sub?.tier, 'Growth');
      const store = await repo.getStoreByWorkspace(tenant.workspace.id);
      assert.equal(store?.tier, 'Growth');
    });

    test('3. Heartbeat renewal failure aborts BEFORE entitlement mutation, leaves event recoverable, and logs safe fields only', async () => {
      const tenant = await registerTenant('bill_hb_fail');
      const secret = 'super_secret_stripe_webhook_key_do_not_log';
      const provider = new SandboxBillingProvider(secret);

      const capturedLogs: any[] = [];
      const origWarn = console.warn;
      const origErr = console.error;
      console.warn = (...args: any[]) => capturedLogs.push(args);
      console.error = (...args: any[]) => capturedLogs.push(args);

      try {
        const proxyRepo = new Proxy(repo, {
          get(target, prop, receiver) {
            if (prop === 'renewBillingEventLease') {
              return async () => false; // Simulate lost lease (e.g. reclaimed or expired)
            }
            if (prop === 'getWorkspaceById') {
              return async (wsId: string) => {
                await new Promise(r => setTimeout(r, 120));
                return target.getWorkspaceById(wsId);
              };
            }
            const orig = Reflect.get(target, prop, receiver);
            return typeof orig === 'function' ? orig.bind(target) : orig;
          },
        });

        const svc = new BillingService(proxyRepo, provider, { leaseDurationMs: 90, heartbeatIntervalMs: 25 });
        const eventId = `evt_hb_fail_${Date.now()}`;
        const payload = {
          id: eventId,
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: tenant.workspace.id,
              customer: 'cust_fail_1',
              subscription: 'sub_fail_1',
              metadata: { tier: 'Enterprise' },
              payment_status: 'paid',
            },
          },
        };
        const raw = JSON.stringify(payload);
        const sig = signSandbox(payload, secret);

        await assert.rejects(() => svc.handleWebhook(raw, sig), /Billing lease ownership lost/i);

        // Entitlement MUST NOT change
        const store = await repo.getStoreByWorkspace(tenant.workspace.id);
        assert.equal(store?.tier, 'Free Audit');
        const sub = await repo.getSubscriptionByWorkspace(tenant.workspace.id);
        assert.equal(sub, null);

        // Event remains recoverable ('processing', NOT permanently marked 'processed' or 'failed')
        const evt = await repo.getBillingEventById(eventId);
        assert.equal(evt?.status, 'processing');

        // Verify safe logging (has eventId, leaseOwner, classification; zero secrets/signatures)
        const serializedLogs = JSON.stringify(capturedLogs);
        assert.match(serializedLogs, new RegExp(eventId));
        assert.match(serializedLogs, /lease_renewal_rejected/);
        assert.doesNotMatch(serializedLogs, /super_secret_stripe_webhook_key/);
        assert.doesNotMatch(serializedLogs, new RegExp(sig));
      } finally {
        console.warn = origWarn;
        console.error = origErr;
      }
    });

    test('4. Critical Guardrail #1: Expired lease CANNOT mutate entitlement or event status EVEN BEFORE Worker 2 reclaims', async () => {
      const tenant = await registerTenant('bill_exp_noreclaim');
      const eventId = `evt_exp_noreclaim_${Date.now()}`;

      const claim = await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: 'checkout.session.completed',
          idempotencyKey: eventId,
          payload: {},
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_old_expired', leaseDurationMs: 60 }
      );
      assert.equal(claim.claimed, true);

      // Let lease expire naturally without ANY second worker reclaiming
      await new Promise(r => setTimeout(r, 90));

      await assert.rejects(
        () =>
          repo.applyBillingTransition({
            eventId,
            leaseOwner: 'worker_old_expired',
            subscription: {
              id: `subrec_${tenant.workspace.id}`,
              workspaceId: tenant.workspace.id,
              provider: 'sandbox',
              customerId: 'cus_expired',
              subscriptionId: 'sub_expired',
              tier: 'Growth',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: Math.floor(Date.now() / 1000),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            storeProfileUpdate: { tier: 'Growth', skuLimit: 5000 },
          }),
        /lost or expired/i
      );

      await assert.rejects(
        () => repo.updateBillingEventStatus(eventId, 'ignored', undefined, 'worker_old_expired'),
        /lost or expired/i
      );

      assert.equal((await repo.getStoreByWorkspace(tenant.workspace.id))?.tier, 'Free Audit');
      assert.equal(await repo.getSubscriptionByWorkspace(tenant.workspace.id), null);
    });

    test('5. Worker 2 reclaims expired event, stale Worker 1 rejected, and retry succeeds cleanly without duplicate grant', async () => {
      const tenant = await registerTenant('bill_reclaim');
      const eventId = `evt_reclaim_${Date.now()}`;

      const claim1 = await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: 'checkout.session.completed',
          idempotencyKey: eventId,
          payload: {},
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_1', leaseDurationMs: 60 }
      );
      assert.equal(claim1.claimed, true);

      await new Promise(r => setTimeout(r, 90));

      const claim2 = await repo.claimBillingEvent(
        {
          id: `bevt_${eventId}`,
          provider: 'sandbox',
          eventId,
          eventType: 'checkout.session.completed',
          idempotencyKey: eventId,
          payload: {},
          status: 'processing',
          processedAt: new Date().toISOString(),
        },
        { leaseOwner: 'worker_2', leaseDurationMs: 5000 }
      );
      assert.equal(claim2.claimed, true);
      assert.equal(claim2.leaseOwner, 'worker_2');
      assert.equal(await repo.renewBillingEventLease(eventId, 'worker_1', 5000), false);

      // Worker 1 cannot mutate
      await assert.rejects(
        () =>
          repo.applyBillingTransition({
            eventId,
            leaseOwner: 'worker_1',
            subscription: {
              id: `subrec_${tenant.workspace.id}`,
              workspaceId: tenant.workspace.id,
              provider: 'sandbox',
              customerId: 'cus_w1',
              subscriptionId: 'sub_w1',
              tier: 'Enterprise',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: Math.floor(Date.now() / 1000),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            storeProfileUpdate: { tier: 'Enterprise', skuLimit: 50000 },
          }),
        /lost or expired/i
      );

      // Worker 2 succeeds
      await repo.applyBillingTransition({
        eventId,
        leaseOwner: 'worker_2',
        subscription: {
          id: `subrec_${tenant.workspace.id}`,
          workspaceId: tenant.workspace.id,
          provider: 'sandbox',
          customerId: 'cus_w2',
          subscriptionId: 'sub_w2',
          tier: 'Starter',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: Math.floor(Date.now() / 1000),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        storeProfileUpdate: { tier: 'Starter', skuLimit: 500 },
      });

      assert.equal((await repo.getStoreByWorkspace(tenant.workspace.id))?.tier, 'Starter');
      assert.equal((await repo.getBillingEventById(eventId))?.status, 'processed');
    });

    test('6. Concurrent handleWebhook() workers & duplicate delivery + failed attempt retry recovery', async () => {
      const tenant = await registerTenant('bill_conc_retry');
      const secret = 'conc_secret_456';
      const provider = new SandboxBillingProvider(secret);
      const svc = new BillingService(repo, provider, { leaseDurationMs: 500, heartbeatIntervalMs: 100 });

      const payload = {
        id: `evt_conc_${Date.now()}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: tenant.workspace.id,
            customer: 'cus_conc',
            subscription: 'sub_conc',
            metadata: { tier: 'Growth' },
            payment_status: 'paid',
          },
        },
      };
      const raw = JSON.stringify(payload);
      const sig = signSandbox(payload, secret);

      const [r1, r2] = await Promise.all([svc.handleWebhook(raw, sig), svc.handleWebhook(raw, sig)]);
      const actions = [r1.action, r2.action].sort();
      assert.deepEqual(actions, ['duplicate', 'processed']);

      // Subsequent duplicate delivery returns duplicate no-op
      const r3 = await svc.handleWebhook(raw, sig);
      assert.equal(r3.action, 'duplicate');

      // Retry after failed attempt (simulated via transient error during first processing)
      const failEventId = `evt_retry_${Date.now()}`;
      let failOnce = true;
      const flakyRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'getWorkspaceById') {
            return async (wsId: string) => {
              if (failOnce) {
                failOnce = false;
                throw new Error('Transient repository timeout');
              }
              return target.getWorkspaceById(wsId);
            };
          }
          const orig = Reflect.get(target, prop, receiver);
          return typeof orig === 'function' ? orig.bind(target) : orig;
        },
      });
      const flakySvc = new BillingService(flakyRepo, provider, { leaseDurationMs: 500, heartbeatIntervalMs: 100 });
      const retryPayload = { ...payload, id: failEventId };
      const retryRaw = JSON.stringify(retryPayload);
      const retrySig = signSandbox(retryPayload, secret);

      await assert.rejects(() => flakySvc.handleWebhook(retryRaw, retrySig), /Transient repository timeout/);
      assert.equal((await repo.getBillingEventById(failEventId))?.status, 'failed');

      const retried = await flakySvc.handleWebhook(retryRaw, retrySig);
      assert.equal(retried.action, 'processed');
      assert.equal((await repo.getBillingEventById(failEventId))?.status, 'processed');
    });

    test('7. PostgresRepository SQL transaction & DB-clock NOW() expiry proof (mock client verifying BEGIN, FOR UPDATE, NOW(), ROLLBACK & release)', async () => {
      const queries: string[] = [];
      let released = false;
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ status: 'processing', lease_owner: 'worker_a', is_expired: true }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          release: () => {
            released = true;
          },
        }),
        query: async () => ({ rows: [], rowCount: 0 }),
      };

      const pgRepo = new PostgresRepository(mockPool as any);
      await assert.rejects(
        () =>
          pgRepo.applyBillingTransition({
            eventId: 'evt_pg_exp_1',
            leaseOwner: 'worker_a',
            subscription: {
              id: 'subrec_1',
              workspaceId: 'ws_1',
              provider: 'stripe',
              customerId: 'cus_1',
              subscriptionId: 'sub_1',
              tier: 'Growth',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
              cancelAtPeriodEnd: false,
              lastEventCreated: 100,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            storeProfileUpdate: { tier: 'Growth', skuLimit: 5000 },
          }),
        /lost or expired/i
      );

      assert.equal(released, true, 'PG client must always be released');
      assert.equal(queries[0], 'BEGIN');
      assert.match(queries[1], /lease_expires_at < NOW\(\)/);
      assert.match(queries[1], /FOR UPDATE/);
      assert.equal(queries.includes('ROLLBACK'), true);
      assert.equal(queries.some(q => q.includes('UPDATE stores')), false, 'Must NEVER touch stores table after expired lease');
      assert.equal(queries.some(q => q.includes('INSERT INTO subscriptions')), false, 'Must NEVER write subscription after expired lease');
    });
  });

  // =========================================================================
  // SECTION 3: M010-S & M010-C — Migration Schema Qualification & Constraint Defs
  // =========================================================================
  describe('M010-S & M010-C: Migration 010/011 Schema Qualification & Constraint Validation', () => {
    const mig010Path = path.join(process.cwd(), 'src/server/db/migrations/010_remediation_integrity_and_leases.sql');
    const mig011Path = path.join(process.cwd(), 'src/server/db/migrations/011_corrective_integrity_and_visibility_provenance.sql');

    test('1. Migration 010 & 011 qualify every information_schema & pg_constraint lookup with current_schema() and reject destructive visibility delete', () => {
      const sql010 = fs.readFileSync(mig010Path, 'utf8');
      const sql011 = fs.readFileSync(mig011Path, 'utf8');

      const unqualifiedMatches010 = sql010.match(/information_schema\.columns[\s\S]{0,160}AND\s+column_name/g) || [];
      assert.ok(unqualifiedMatches010.length >= 9);
      for (const snippet of unqualifiedMatches010) {
        assert.match(snippet, /table_schema\s*=\s*current_schema\(\)/i);
      }
      const unqualifiedMatches011 = sql011.match(/information_schema\.columns[\s\S]{0,160}AND\s+column_name/g) || [];
      assert.ok(unqualifiedMatches011.length >= 10);
      for (const snippet of unqualifiedMatches011) {
        assert.match(snippet, /table_schema\s*=\s*current_schema\(\)/i);
      }

      // Check full pg_constraint validation & no ::regclass shortcut
      assert.doesNotMatch(sql010, /::regclass/);
      assert.doesNotMatch(sql011, /::regclass/);
      assert.match(sql010, /idx\.indpred IS NOT NULL/);
      assert.match(sql011, /idx\.indpred IS NOT NULL/);
      assert.match(sql010, /v_src_cols IS DISTINCT FROM ARRAY\['workspace_id', 'observation_date', 'platform', 'discovery_topic'\]/);
      assert.match(sql011, /content_hash VARCHAR\(64\)/);

      // Must NEVER auto-delete or auto-sum historical visibility duplicates
      assert.doesNotMatch(sql010, /DELETE\s+FROM\s+ai_visibility_metrics/i);
      assert.doesNotMatch(sql011, /DELETE\s+FROM\s+ai_visibility_metrics/i);
      assert.match(sql010, /Refusing destructive auto-merge\/delete/i);
      assert.match(sql011, /refusing destructive auto-merge\/delete/i);
    });

    test('2. PostgresRepository.checkSchemaReadiness rejects partial index on ai_visibility_metrics and wrong-schema/reversed constraints', async () => {
      const validTables = [
        'users', 'workspaces', 'workspace_memberships', 'sessions', 'stores', 'products',
        'variants', 'offers', 'evidence_documents', 'findings', 'action_items', 'schema_migrations',
        'subscriptions', 'billing_events', 'audit_runs', 'audit_run_manifests', 'audit_run_findings',
        'audit_run_evidence', 'audit_run_products', 'shopify_connections', 'shopify_sync_runs',
        'shopify_webhook_events', 'shopify_oauth_states', 'workspace_business_profiles',
        'ai_visibility_imports', 'ai_visibility_metrics',
      ];
      const validCols = [
        { table_name: 'variants', column_name: 'price', data_type: 'numeric', numeric_precision: 14, numeric_scale: 2, is_nullable: 'NO', character_maximum_length: null },
        { table_name: 'sessions', column_name: 'session_token_hash', data_type: 'character varying', numeric_precision: null, numeric_scale: null, is_nullable: 'NO', character_maximum_length: 128 },
        { table_name: 'products', column_name: 'workspace_id', data_type: 'character varying', numeric_precision: null, numeric_scale: null, is_nullable: 'NO', character_maximum_length: 64 },
      ];
      const validMigs = [
        '001_initial_schema.sql', '002_tenant_referential_integrity.sql', '003_store_sku_limit.sql',
        '004_backfill_store_sku_count.sql', '005_billing_subscriptions.sql', '006_audit_history_snapshots.sql',
        '007_shopify_integration.sql', '008_audit_composite_integrity_and_shopify_hardening.sql',
        '009_durable_sync_runs_and_ai_discovery.sql', '010_remediation_integrity_and_leases.sql',
        '011_corrective_integrity_and_visibility_provenance.sql',
      ];
      const baseConstraints = [
        { source_schema: 'tenant_prod', source_table: 'stores', target_schema: '', target_table: '', constraint_name: 'uq_stores_ws_id', constraint_type: 'u', source_columns: 'workspace_id,id', target_columns: '', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'audit_runs', target_schema: '', target_table: '', constraint_name: 'uq_audit_runs_ws_id', constraint_type: 'u', source_columns: 'workspace_id,id', target_columns: '', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'shopify_sync_runs', target_schema: '', target_table: '', constraint_name: 'uq_shopify_sync_runs_workspace_id', constraint_type: 'u', source_columns: 'workspace_id,id', target_columns: '', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'ai_visibility_metrics', target_schema: '', target_table: '', constraint_name: 'uq_ai_visibility_metric_key', constraint_type: 'u', source_columns: 'workspace_id,observation_date,platform,discovery_topic', target_columns: '', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'products', target_schema: 'tenant_prod', target_table: 'stores', constraint_name: 'fk_p_s', constraint_type: 'f', source_columns: 'workspace_id,store_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'findings', target_schema: 'tenant_prod', target_table: 'stores', constraint_name: 'fk_f_s', constraint_type: 'f', source_columns: 'workspace_id,store_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'findings', target_schema: 'tenant_prod', target_table: 'products', constraint_name: 'fk_f_p', constraint_type: 'f', source_columns: 'workspace_id,product_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'action_items', target_schema: 'tenant_prod', target_table: 'stores', constraint_name: 'fk_a_s', constraint_type: 'f', source_columns: 'workspace_id,store_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'action_items', target_schema: 'tenant_prod', target_table: 'findings', constraint_name: 'fk_a_f', constraint_type: 'f', source_columns: 'workspace_id,finding_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'action_items', target_schema: 'tenant_prod', target_table: 'products', constraint_name: 'fk_a_p', constraint_type: 'f', source_columns: 'workspace_id,product_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'audit_run_manifests', target_schema: 'tenant_prod', target_table: 'audit_runs', constraint_name: 'fk_arm', constraint_type: 'f', source_columns: 'workspace_id,audit_run_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'audit_run_findings', target_schema: 'tenant_prod', target_table: 'audit_runs', constraint_name: 'fk_arf', constraint_type: 'f', source_columns: 'workspace_id,audit_run_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'audit_run_evidence', target_schema: 'tenant_prod', target_table: 'audit_runs', constraint_name: 'fk_are', constraint_type: 'f', source_columns: 'workspace_id,audit_run_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'audit_run_products', target_schema: 'tenant_prod', target_table: 'audit_runs', constraint_name: 'fk_arp', constraint_type: 'f', source_columns: 'workspace_id,audit_run_id', target_columns: 'workspace_id,id', is_partial_index: false },
        { source_schema: 'tenant_prod', source_table: 'shopify_sync_runs', target_schema: 'tenant_prod', target_table: 'shopify_sync_runs', constraint_name: 'fk_shopify_sync_runs_parent_workspace', constraint_type: 'f', source_columns: 'workspace_id,parent_sync_run_id', target_columns: 'workspace_id,id', is_partial_index: false },
      ];

      const runWithConstraints = async (constraints: any[]) => {
        const mockPool = {
          connect: async () => ({
            query: async (sql: string) => {
              if (sql.includes('FROM information_schema.tables')) return { rows: validTables.map(t => ({ table_name: t })) };
              if (sql.includes('FROM information_schema.columns')) return { rows: validCols };
              if (sql.includes('SELECT current_schema()')) return { rows: [{ schema_name: 'tenant_prod' }] };
              if (sql.includes('FROM information_schema.table_constraints')) {
                return { rows: [{ source_schema: 'tenant_prod', source_table: 'products', source_column: 'workspace_id', target_schema: 'tenant_prod', target_table: 'workspaces', target_column: 'id', on_delete: 'CASCADE' }] };
              }
              if (sql.includes('FROM schema_migrations')) return { rows: validMigs.map(id => ({ id })) };
              if (sql.includes('FROM pg_constraint')) return { rows: constraints };
              return { rows: [] };
            },
            release: () => {},
          }),
        };
        return new PostgresRepository(mockPool as any).checkSchemaReadiness();
      };

      const passRes = await runWithConstraints(baseConstraints);
      assert.equal(passRes.isReady, true);

      // Partial index on ai_visibility_metrics MUST fail readiness
      const partialRes = await runWithConstraints(
        baseConstraints.map(c => c.constraint_name === 'uq_ai_visibility_metric_key' ? { ...c, is_partial_index: true } : c)
      );
      assert.equal(partialRes.isReady, false);
      assert.match(partialRes.error!, /ai_visibility_metrics table missing unique key/);

      // Reversed column order on uq_shopify_sync_runs_workspace_id MUST fail
      const wrongOrderRes = await runWithConstraints(
        baseConstraints.map(c => c.constraint_name === 'uq_shopify_sync_runs_workspace_id' ? { ...c, source_columns: 'id,workspace_id' } : c)
      );
      assert.equal(wrongOrderRes.isReady, false);
      assert.match(wrongOrderRes.error!, /shopify_sync_runs table missing unique key/);
    });
  });

  // =========================================================================
  // SECTION 4: AD-URL — Strict Canonical URL Validation
  // =========================================================================
  describe('AD-URL: AI Discovery Strict Canonical URL Validation', () => {
    const trusted = 'trusted-shop.com';

    test('Negative URLs (host-spoofing, path/query embeds, HTTP, credentials, malformed, unapproved subdomain, port, placeholders)', () => {
      const negativeCases: Array<[string, string?]> = [
        ['https://trusted-shop.com.attacker.example/products/a', trusted],
        ['https://attacker-trusted-shop.com/products/a', trusted],
        ['https://attacker.example/trusted-shop.com/products/a', trusted],
        ['https://attacker.example/?redirect=trusted-shop.com', trusted],
        ['http://trusted-shop.com/products/a', trusted],
        ['https://user:pass@trusted-shop.com/products/a', trusted],
        ['https://@trusted-shop.com/products/a', trusted],
        ['not a valid url', trusted],
        ['https://evil.trusted-shop.com/products/a', trusted],
        ['https://trusted-shop.com:8443/products/a', trusted],
        ['https://trusted-shop.com/', trusted], // root path rejected
        ['https://trusted-shop.com/products/../admin', trusted], // traversal rejected
        ['https://store.myshopify.com/products/a', 'store.myshopify.com'], // placeholder domain rejected
      ];

      for (const [url, domain] of negativeCases) {
        const res = validateCanonicalProductUrl(url, domain);
        assert.equal(res.valid, false, `Expected URL "${url}" against domain "${domain}" to be REJECTED`);
      }

      assert.equal(normalizeVerifiedDomainHostname('myshopify.com'), null);
      assert.equal(normalizeVerifiedDomainHostname('localhost'), null);
    });

    test('Positive URLs (exact match, normalized uppercase/IDN, explicitly permitted subdomain, allowSubdomains policy)', () => {
      const r1 = validateCanonicalProductUrl('https://trusted-shop.com/products/kettle', trusted);
      assert.equal(r1.valid, true);
      assert.equal(r1.normalizedHostname, 'trusted-shop.com');

      // Case + IDN punycode normalization
      const r2 = validateCanonicalProductUrl('https://MÜNCHEN-SHOP.de/products/kaffeekanne', 'münchen-shop.de');
      assert.equal(r2.valid, true);
      assert.equal(r2.normalizedHostname, 'xn--mnchen-shop-thb.de');

      // Explicitly permitted subdomain only
      const r3 = validateCanonicalProductUrl('https://shop.trusted-shop.com/products/kettle', trusted, {
        allowedSubdomains: ['shop.trusted-shop.com'],
      });
      assert.equal(r3.valid, true);
      assert.equal(
        validateCanonicalProductUrl('https://other.trusted-shop.com/products/kettle', trusted, {
          allowedSubdomains: ['shop.trusted-shop.com'],
        }).valid,
        false
      );

      // allowSubdomains flag
      const r4 = validateCanonicalProductUrl('https://eu.trusted-shop.com/products/kettle', trusted, {
        allowSubdomains: true,
      });
      assert.equal(r4.valid, true);
    });

    test('evaluateDiscoveryReadiness flags spoofed URL without substring bypass', () => {
      const spoofed = makeValidProduct({
        id: 'p_spoof',
        offers: [makeOffer({ id: 'o1', price: 20, currency: 'USD', availability: 'in_stock', url: 'https://trusted-shop.com.attacker.example/products/x' })],
        attributes: { material: 'Steel', urlProvenance: 'verified_storefront_domain' },
      });
      const res = evaluateDiscoveryReadiness([spoofed], trusted);
      const urlFinding = res.findings.find(f => f.ruleId === 'DISC_CANONICAL_URL');
      assert.ok(urlFinding, 'Spoofed host must produce DISC_CANONICAL_URL finding');
    });
  });

  // =========================================================================
  // SECTION 5: CSV-STRICT & V-DATA — Strict CSV Parser & Visibility Provenance
  // =========================================================================
  describe('CSV-STRICT & V-DATA: Strict CSV FSM & Idempotent Content-Hash Visibility Upload', () => {
    test('parseCsvRfc4180 covers all strict valid and invalid grammar cases', () => {
      // Valid cases
      assert.deepEqual(parseCsvRfc4180('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
      assert.deepEqual(parseCsvRfc4180('a,b\n"hello, world",2'), [['a', 'b'], ['hello, world', '2']]);
      assert.deepEqual(parseCsvRfc4180('a,b\n"say ""hi""",2'), [['a', 'b'], ['say "hi"', '2']]);
      assert.deepEqual(parseCsvRfc4180('a,b\n"line1\nline2",2'), [['a', 'b'], ['line1\nline2', '2']]);
      assert.deepEqual(parseCsvRfc4180('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
      assert.deepEqual(parseCsvRfc4180('a,b,c\n1,2,'), [['a', 'b', 'c'], ['1', '2', '']]);
      assert.deepEqual(parseCsvRfc4180('a,b\r\n1,2\r\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
      assert.deepEqual(parseCsvRfc4180('\uFEFFa,b\n1,2'), [['a', 'b'], ['1', '2']]);

      // Invalid syntax cases
      assert.throws(() => parseCsvRfc4180('a,b\n"unclosed,2'), /unclosed quoted field/i);
      assert.throws(() => parseCsvRfc4180('a,b\n"value"unexpected,2'), /unexpected character/i);
      assert.throws(() => parseCsvRfc4180('a,b\nva"lue,2'), /unexpected quote inside unquoted field/i);
    });

    test('HTTP POST /api/visibility/upload: header validation, column mismatch, large valid CSV, atomic failure & idempotent duplicate re-upload', async () => {
      const tenantA = await registerTenant('vis_a');
      const tenantB = await registerTenant('vis_b');

      const upload = (token: string, csvContent: string, filename = 'vis.csv') =>
        fetch(`${baseUrl}/api/visibility/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ csvContent, filename }),
        });

      // 1. Seed valid metric + intra-CSV aggregation (2 rows for same key -> summed cleanly inside single upload)
      const validCsv = [
        'date,platform,brand_mentions,product_mentions,clicks,topic',
        '2026-10-01,ChatGPT Search,10,5,2,"pour over"',
        '2026-10-01,ChatGPT Search,4,3,1,"pour over"',
      ].join('\n');

      const res1 = await upload(tenantA.token, validCsv, 'oct.csv');
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      assert.equal(body1.duplicateImport, false);
      assert.equal(body1.action, 'imported');
      assert.equal(body1.acceptedRowCount, 1);

      // 2. Re-uploading identical CSV (even with CRLF + BOM) must return duplicate no-op WITHOUT doubling totals!
      const resDup = await upload(tenantA.token, `\uFEFF${validCsv.replace(/\n/g, '\r\n')}`, 'oct_reupload.csv');
      assert.equal(resDup.status, 200);
      const bodyDup = await resDup.json();
      assert.equal(bodyDup.duplicateImport, true);
      assert.equal(bodyDup.action, 'duplicate_noop');
      assert.equal(bodyDup.acceptedRowCount, 0);

      // Verify summary totals stayed 14 brandMentions, not 28!
      const sumRes = await fetch(`${baseUrl}/api/visibility/summary`, {
        headers: { Authorization: `Bearer ${tenantA.token}` },
      });
      const sumBody = await sumRes.json();
      assert.equal(sumBody.summary.totalBrandMentions, 14);
      assert.equal(sumBody.summary.totalProductMentions, 8);

      // 2b. Independent observation (different platform/topic) imports cleanly and adds to summary
      const indepCsv = [
        'date,platform,brand_mentions,product_mentions,clicks,topic',
        '2026-10-01,Google Gemini,6,2,1,"grinder"',
      ].join('\n');
      const resIndep = await upload(tenantA.token, indepCsv, 'oct_gemini.csv');
      assert.equal(resIndep.status, 200);
      const bodyIndep = await resIndep.json();
      assert.equal(bodyIndep.duplicateImport, false);
      assert.equal(bodyIndep.acceptedRowCount, 1);
      assert.equal(bodyIndep.summary.totalBrandMentions, 20);

      // 3. Tenant B uploading identical CSV is NOT blocked by Tenant A's contentHash
      const resB = await upload(tenantB.token, validCsv, 'tenantB.csv');
      assert.equal(resB.status, 200);
      const bodyB = await resB.json();
      assert.equal(bodyB.duplicateImport, false);
      assert.equal(bodyB.acceptedRowCount, 1);

      // 4. Reject empty header, duplicate header, extra column, missing column, and "value"unexpected ATOMICALLY
      const badPayloads = [
        'date,,brand_mentions\n2026-10-02,ChatGPT Search,5', // empty header
        'date,platform,Platform,brand_mentions\n2026-10-02,ChatGPT Search,Gemini,5', // duplicate header
        'date,platform,brand_mentions\n2026-10-02,ChatGPT Search,5,EXTRA_COL', // extra col
        'date,platform,brand_mentions\n2026-10-02,ChatGPT Search', // missing col
        'date,platform,brand_mentions\n2026-10-02,"ChatGPT Search"unexpected,5', // after closing quote
        'date,platform,brand_mentions\n2026-10-02,ChatGPT Search,5\n2026-10-03,"unclosed', // unclosed quote after valid row
      ];

      for (const bad of badPayloads) {
        const failRes = await upload(tenantA.token, bad, 'bad.csv');
        assert.equal(failRes.status, 400, `Expected 400 for malformed CSV: ${bad}`);
      }

      // Ensure failed atomic uploads left Tenant A's existing summary completely undisturbed
      const sumAfter = await (
        await fetch(`${baseUrl}/api/visibility/summary`, { headers: { Authorization: `Bearer ${tenantA.token}` } })
      ).json();
      assert.equal(sumAfter.summary.totalBrandMentions, 20);

      // 5. Large valid CSV within limit (600 rows) succeeds cleanly
      const bigRows = ['date,platform,brand_mentions,product_mentions,clicks,topic'];
      for (let i = 0; i < 600; i++) {
        bigRows.push(`2026-10-05,Perplexity,1,1,0,"topic_${i}"`);
      }
      const bigRes = await upload(tenantA.token, bigRows.join('\n'), 'large_600.csv');
      assert.equal(bigRes.status, 200);
      assert.equal((await bigRes.json()).acceptedRowCount, 600);

      // Hash equivalence helper sanity check
      assert.equal(computeCsvContentHash(validCsv), computeCsvContentHash(`\uFEFF${validCsv.replace(/\n/g, '\r\n')}`));
    });
  });
});
