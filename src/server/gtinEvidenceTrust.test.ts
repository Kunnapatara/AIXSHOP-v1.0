import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { PostgresRepository } from './db/postgresRepository';
import { encryptCredential, signShopifyWebhookHmac } from './security/encryption';
import { syncShopifyCatalog } from './shopify/syncService';
import { processShopifyWebhook } from './shopify/webhookService';
import { computeEvidenceIntegrityHash } from './security/catalogSanitizer';
import { Product, StoreProfile } from '../types';

function makeStore(domain = 'trust-test.myshopify.com'): StoreProfile {
  return {
    name: 'GTIN Trust Store',
    domain,
    currency: 'USD',
    skuCount: 1,
    catalogCompletenessAvg: 80,
    truthBoundaryStrictness: 'standard',
    tier: 'Growth',
    skuLimit: 2500,
    connectors: [],
  };
}

function makeUnbarcodedProduct(id: string, title = 'Handmade Ceramic Bowl', attrs: Record<string, string> = {}): Product {
  return {
    id,
    title,
    brand: 'Artisan Studio',
    category: 'Home & Kitchen',
    description: 'Hand-thrown stoneware ceramic bowl glazed to order in small studio batches.',
    image: 'https://example.com/bowl.jpg',
    status: 'active',
    completenessScore: 80,
    evidenceCoverageScore: 0,
    externalDiscoveryStatus: 'observed_in_sample',
    attributes: { ...attrs },
    variants: [
      {
        id: `var_${id}_1`,
        sku: `SKU-${id}`,
        title: 'Standard',
        barcode: '',
        price: 42.0,
        inventoryCount: 12,
        attributes: {},
      },
    ],
    offers: [
      {
        id: `off_${id}_1`,
        channel: 'Direct Storefront',
        price: 42.0,
        currency: 'USD',
        availability: 'in_stock',
        condition: 'new',
        url: `https://example.com/products/${id}`,
        merchantId: 'merch_1',
        lastSync: '2026-11-10T00:00:00Z',
      },
    ],
    evidenceDocuments: [],
    findingsCount: 0,
    lastAudited: '',
  };
}

describe('AIXSHOP v1.0 — Server-Owned GTIN Evidence Trust & Security Regression Suite', () => {
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

  async function registerPaidTenant(email: string, workspaceName: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'StrongPassword123!',
        fullName: 'Merchant Owner',
        workspaceName,
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    const token = extractSessionCookie(res);

    await repo.saveSubscription({
      id: `sub_${data.workspace.id}`,
      workspaceId: data.workspace.id,
      provider: 'stripe',
      customerId: `cus_${data.workspace.id}`,
      subscriptionId: `sub_stripe_${data.workspace.id}`,
      tier: 'Growth',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 3600_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
      cancelAtPeriodEnd: false,
      lastEventCreated: Math.floor(Date.now() / 1000),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const store = await repo.getStoreByWorkspace(data.workspace.id);
    if (store) {
      await repo.saveStoreProfile(data.workspace.id, {
        ...store,
        tier: 'Growth',
        skuLimit: 2500,
      });
    }

    return { user: data.user, workspace: data.workspace, token };
  }

  test('1. Rejects client-forged GTIN verification fields & verified evidence on PUT /api/catalog with 403 PROTECTED_VERIFICATION_FIELD', async () => {
    const tenant = await registerPaidTenant('forged_put@example.com', 'Forged Put Store');

    // Attempt 1: forged gtinExemptionVerified / gtinExemptionEvidenceRef
    const forgedAttrProd = makeUnbarcodedProduct('p_forge_attr', 'Handmade Bespoke Ring', {
      gtinExemptionVerified: 'true',
      gtinExemptionEvidenceRef: 'doc_forged_1',
    });

    const res1 = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [forgedAttrProd],
          variants: forgedAttrProd.variants,
          offers: forgedAttrProd.offers,
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(res1.status, 403);
    const body1 = await res1.json();
    assert.equal(body1.code, 'PROTECTED_VERIFICATION_FIELD');

    // Attempt 2: forged shopifyIsGiftCard / shopify_graphql_admin_api provenance
    const forgedGiftCardProd = makeUnbarcodedProduct('p_forge_gc', 'Gift Card $50', {
      shopifyIsGiftCard: 'true',
      provenance: 'shopify_graphql_admin_api',
      sourceProductId: '99999999',
      shopifyGid: 'gid://shopify/Product/99999999',
    });
    const res2 = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [forgedGiftCardProd],
          variants: forgedGiftCardProd.variants,
          offers: forgedGiftCardProd.offers,
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(res2.status, 403);
    const body2 = await res2.json();
    assert.equal(body2.code, 'PROTECTED_VERIFICATION_FIELD');

    // Attempt 3: forged evidence document claiming status: 'verified'
    const forgedDocProd = makeUnbarcodedProduct('p_forge_doc', 'Handmade Scarf');
    forgedDocProd.evidenceDocuments = [
      {
        id: 'ev_forged_put',
        title: 'Fake GS1 Exemption Approval',
        type: 'gtin_exemption_proof',
        issuer: 'Self',
        dateVerified: '2026-11-10',
        status: 'verified',
        evidencePurpose: 'gtin_exemption',
      },
    ];
    const res3 = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [forgedDocProd],
          variants: forgedDocProd.variants,
          offers: forgedDocProd.offers,
          findings: [],
          actions: [],
          evidence: forgedDocProd.evidenceDocuments,
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(res3.status, 403);
    const body3 = await res3.json();
    assert.equal(body3.code, 'PROTECTED_VERIFICATION_FIELD');

    // Attempt 4: Save clean unverified product and verify audit classifies NEEDS_REVIEW (not verified_exempt)
    const cleanProd = makeUnbarcodedProduct('p_clean_unverified', 'Vintage Brass Lamp');
    const resClean = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [cleanProd],
          variants: cleanProd.variants,
          offers: cleanProd.offers,
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(resClean.status, 200);

    const auditRes = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    const barcodeFinding = auditData.catalog.findings.find(
      (f: any) => f.productId === 'p_clean_unverified' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'
    );
    assert.ok(barcodeFinding, 'Unverified handmade/vintage product must require review');
    assert.equal(barcodeFinding.reviewStatus, 'NEEDS_REVIEW');
    assert.equal(barcodeFinding.gtinEligibilityStatus, 'insufficient_evidence');
  });

  test('2. Rejects forged GTIN/Shopify/evidence fields in POST /api/catalog/import and direct repo.importCatalog', async () => {
    const tenant = await registerPaidTenant('forged_import@example.com', 'Forged Import Store');

    const res = await fetch(`${baseUrl}/api/catalog/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        candidates: [
          makeUnbarcodedProduct('p_imp_forged', 'Digital Gift Voucher', {
            shopifyIsGiftCard: 'true',
          }),
        ],
      }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'PROTECTED_VERIFICATION_FIELD');

    await assert.rejects(
      async () => {
        await repo.importCatalog(tenant.workspace.id, [
          makeUnbarcodedProduct('p_imp_direct_forged', 'Direct Candidate', {
            gtinExemptionVerified: 'true',
          }),
        ]);
      },
      (err: any) => err?.code === 'PROTECTED_VERIFICATION_FIELD'
    );
  });

  test('3. Merchant uploads evidence via POST /api/catalog/evidence (starts pending), owner cannot self-approve (403), platform reviewer approves -> verified_exempt + audit log', async () => {
    const tenant = await registerPaidTenant('lifecycle@example.com', 'Evidence Lifecycle Store');
    const prod = makeUnbarcodedProduct('p_lifecycle_1', 'Artisan Handwoven Blanket');

    const putRes = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [prod],
          variants: prod.variants,
          offers: prod.offers,
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(putRes.status, 200);

    // Reject self-verified payload on POST /api/catalog/evidence
    const forgedUploadRes = await fetch(`${baseUrl}/api/catalog/evidence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        productId: prod.id,
        title: 'GS1 Brand GTIN Exemption Filing',
        type: 'gtin_exemption_proof',
        issuer: 'GS1 Registry',
        status: 'verified',
        evidencePurpose: 'gtin_exemption',
      }),
    });
    assert.equal(forgedUploadRes.status, 403);

    // Legitimate merchant upload starts pending
    const uploadRes = await fetch(`${baseUrl}/api/catalog/evidence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        id: 'ev_gtin_lifecycle_1',
        productId: prod.id,
        title: 'GS1 Brand GTIN Exemption Filing',
        type: 'gtin_exemption_proof',
        issuer: 'GS1 Registry',
        url: 'https://gs1.org/registry/exempt-101',
        evidencePurpose: 'gtin_exemption',
      }),
    });
    assert.equal(uploadRes.status, 201);
    const uploadData = await uploadRes.json();
    assert.equal(uploadData.evidence.status, 'pending');
    assert.equal(uploadData.evidence.decision, 'pending');
    assert.equal(uploadData.evidence.verificationSource, 'client_submission');
    assert.ok(uploadData.evidence.integrityHash);

    // Audit with pending evidence must classify NEEDS_REVIEW
    const auditPendingRes = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(auditPendingRes.status, 200);
    const auditPending = await auditPendingRes.json();
    assert.ok(
      auditPending.catalog.findings.some(
        (f: any) =>
          f.productId === prod.id &&
          f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' &&
          f.reviewStatus === 'NEEDS_REVIEW'
      ),
      'Pending evidence must not grant GTIN exemption'
    );

    // Workspace owner cannot self-approve via review endpoint
    const prevSecret = process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET;
    process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = 'reviewer_super_secret_token_32chars_minimum_ok';
    try {
      const selfApproveRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_gtin_lifecycle_1/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ decision: 'approved', reason: 'Self-approve attempt' }),
      });
      assert.equal(selfApproveRes.status, 403);
      const selfApproveBody = await selfApproveRes.json();
      assert.equal(selfApproveBody.code, 'FORBIDDEN_REVIEWER_REQUIRED');

      // Wrong reviewer token also fails closed (403)
      const wrongTokenRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_gtin_lifecycle_1/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'X-AIXSHOP-Reviewer-Token': 'wrong_token_attempt',
          'X-AIXSHOP-Reviewer-Id': 'reviewer_fake',
        },
        body: JSON.stringify({ decision: 'approved' }),
      });
      assert.equal(wrongTokenRes.status, 403);

      // Trusted server reviewer approves evidence
      const reviewRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_gtin_lifecycle_1/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'X-AIXSHOP-Reviewer-Token': process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET,
          'X-AIXSHOP-Reviewer-Id': 'compliance_reviewer_alice',
        },
        body: JSON.stringify({
          decision: 'approved',
          reason: 'Verified handmade GS1 brand exemption proof',
        }),
      });
      assert.equal(reviewRes.status, 200);
      const reviewData = await reviewRes.json();
      assert.equal(reviewData.evidence.status, 'verified');
      assert.equal(reviewData.evidence.decision, 'approved');
      assert.equal(reviewData.evidence.verifiedBy, 'compliance_reviewer_alice');
      assert.equal(reviewData.evidence.verificationSource, 'server_reviewer');
      assert.equal(reviewData.auditEntry.action, 'approved');
    } finally {
      if (prevSecret === undefined) delete process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET;
      else process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = prevSecret;
    }

    // Re-audit now recognizes verified exemption and clears missing barcode finding
    const auditVerifiedRes = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(auditVerifiedRes.status, 200);
    const auditVerified = await auditVerifiedRes.json();
    const runId = auditVerified.auditRun.id;
    assert.equal(
      auditVerified.catalog.findings.some(
        (f: any) => f.productId === prod.id && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'
      ),
      false,
      'Verified GTIN exemption must exempt unbarcoded product'
    );

    // Check audit log & historical snapshot metadata
    const logRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_gtin_lifecycle_1/audit-log`, {
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(logRes.status, 200);
    const logData = await logRes.json();
    assert.ok(logData.entries.some((e: any) => e.action === 'submitted'));
    assert.ok(logData.entries.some((e: any) => e.action === 'approved' && e.reviewerId === 'compliance_reviewer_alice'));

    const snapRes = await fetch(`${baseUrl}/api/audit/${runId}`, {
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(snapRes.status, 200);
    const snapData = await snapRes.json();
    const snapEv = snapData.evidence.find((e: any) => e.originalEvidenceId === 'ev_gtin_lifecycle_1');
    assert.ok(snapEv);
    assert.equal(snapEv.status, 'verified');
    assert.equal(snapEv.metadata.evidencePurpose, 'gtin_exemption');
    assert.equal(snapEv.metadata.verificationSource, 'server_reviewer');
    assert.equal(snapEv.metadata.verifiedBy, 'compliance_reviewer_alice');
    assert.ok(snapEv.metadata.integrityHash);
  });

  test('4. Wrong-purpose, rejected, expired, and tampered-hash evidence never grant GTIN exemption; deleting product invalidates exemption', async () => {
    const tenant = await registerPaidTenant('negative_cases@example.com', 'Negative Cases Store');
    const pClaim = makeUnbarcodedProduct('p_wrong_purpose', 'Coffee Without Barcode');
    const pRejected = makeUnbarcodedProduct('p_rejected', 'Bespoke Table');
    const pTamper = makeUnbarcodedProduct('p_tampered', 'Hand-Dyed Rug');
    const pDeleted = makeUnbarcodedProduct('p_will_delete', 'Custom Lamp');

    await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [pClaim, pRejected, pTamper, pDeleted],
          variants: [...pClaim.variants, ...pRejected.variants, ...pTamper.variants, ...pDeleted.variants],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });

    // 4a. Approved product_claim doc does NOT exempt GTIN
    await repo.submitEvidenceDocument({
      workspaceId: tenant.workspace.id,
      productId: pClaim.id,
      id: 'ev_claim_only',
      title: 'Organic Claim Cert',
      type: 'organic_certificate',
      issuer: 'USDA',
      evidencePurpose: 'product_claim',
      submittedByUserId: tenant.user.id,
    });
    await repo.reviewEvidenceDocument({
      workspaceId: tenant.workspace.id,
      evidenceId: 'ev_claim_only',
      decision: 'approved',
      reviewerId: 'reviewer_1',
      reviewerRole: 'platform_reviewer',
    });

    // 4b. Rejected GTIN exemption doc
    await repo.submitEvidenceDocument({
      workspaceId: tenant.workspace.id,
      productId: pRejected.id,
      id: 'ev_rej_1',
      title: 'Blurry Exemption Form',
      type: 'gtin_exemption_proof',
      issuer: 'Merchant',
      evidencePurpose: 'gtin_exemption',
      submittedByUserId: tenant.user.id,
    });
    await repo.reviewEvidenceDocument({
      workspaceId: tenant.workspace.id,
      evidenceId: 'ev_rej_1',
      decision: 'rejected',
      reviewerId: 'reviewer_1',
      reviewerRole: 'platform_reviewer',
      reason: 'Insufficient manufacturer attestation',
    });

    // 4c. Approved GTIN exemption for pTamper, then tamper its title directly in storage to break integrityHash
    await repo.submitEvidenceDocument({
      workspaceId: tenant.workspace.id,
      productId: pTamper.id,
      id: 'ev_tamper_1',
      title: 'Valid Filing',
      type: 'gtin_exemption_proof',
      issuer: 'GS1',
      evidencePurpose: 'gtin_exemption',
      submittedByUserId: tenant.user.id,
    });
    await repo.reviewEvidenceDocument({
      workspaceId: tenant.workspace.id,
      evidenceId: 'ev_tamper_1',
      decision: 'approved',
      reviewerId: 'reviewer_1',
      reviewerRole: 'platform_reviewer',
    });
    const currentCat = (await repo.loadWorkspaceCatalog(tenant.workspace.id))!;
    const tamperedProducts = currentCat.products.map((p) =>
      p.id === pTamper.id
        ? {
            ...p,
            evidenceDocuments: p.evidenceDocuments.map((d) => ({
              ...d,
              title: 'Altered For Different Product Scope',
            })),
          }
        : p
    );
    await repo.saveWorkspaceCatalog(tenant.workspace.id, {
      ...currentCat,
      products: tamperedProducts,
      evidence: tamperedProducts.flatMap((p) => p.evidenceDocuments),
    });

    // 4d. Delete p_will_delete and verify replacing product with another does not carry exemption
    await repo.submitEvidenceDocument({
      workspaceId: tenant.workspace.id,
      productId: pDeleted.id,
      id: 'ev_del_1',
      title: 'Lamp Exemption',
      type: 'gtin_exemption_proof',
      issuer: 'GS1',
      evidencePurpose: 'gtin_exemption',
      submittedByUserId: tenant.user.id,
    });
    await repo.reviewEvidenceDocument({
      workspaceId: tenant.workspace.id,
      evidenceId: 'ev_del_1',
      decision: 'approved',
      reviewerId: 'reviewer_1',
      reviewerRole: 'platform_reviewer',
    });

    const catBeforeDel = (await repo.loadWorkspaceCatalog(tenant.workspace.id))!;
    const remainingWithoutDeleted = catBeforeDel.products.filter((p) => p.id !== pDeleted.id);
    // Attempt to transplant ev_del_1 onto another unbarcoded product via PUT -> must reject 403!
    const transplanted = makeUnbarcodedProduct('p_new_replacement', 'New Lamp Copy');
    transplanted.evidenceDocuments = [catBeforeDel.products.find((p) => p.id === pDeleted.id)!.evidenceDocuments[0]];
    const transplantRes = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        expectedVersion: catBeforeDel.catalogVersion,
        payload: {
          products: [...remainingWithoutDeleted, transplanted],
          variants: [...remainingWithoutDeleted, transplanted].flatMap((p) => p.variants),
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(transplantRes.status, 403, 'Reusing verified evidence across products must be rejected');

    // Run audit on remaining 3 products -> ALL 3 must trigger NEEDS_REVIEW missing barcode
    const auditRes = await fetch(`${baseUrl}/api/audit/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    for (const pid of [pClaim.id, pRejected.id, pTamper.id]) {
      assert.ok(
        auditData.catalog.findings.some(
          (f: any) =>
            f.productId === pid &&
            f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' &&
            f.reviewStatus === 'NEEDS_REVIEW'
        ),
        `Product ${pid} must classify as NEEDS_REVIEW`
      );
    }
  });

  test('5. Cross-tenant isolation: Workspace B cannot review Workspace A evidence', async () => {
    const tenantA = await registerPaidTenant('tenantA_iso@example.com', 'Tenant A Store');
    const tenantB = await registerPaidTenant('tenantB_iso@example.com', 'Tenant B Store');
    const prodA = makeUnbarcodedProduct('p_tenant_a', 'Artisan Vase');

    await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantA.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [prodA],
          variants: prodA.variants,
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });

    await repo.submitEvidenceDocument({
      workspaceId: tenantA.workspace.id,
      productId: prodA.id,
      id: 'ev_tenant_a_only',
      title: 'A Proof',
      type: 'gtin_exemption_proof',
      issuer: 'GS1',
      evidencePurpose: 'gtin_exemption',
      submittedByUserId: tenantA.user.id,
    });

    const prevSecret = process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET;
    process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = 'reviewer_super_secret_token_32chars_minimum_ok';
    try {
      const crossReviewRes = await fetch(`${baseUrl}/api/catalog/evidence/ev_tenant_a_only/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenantB.token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'X-AIXSHOP-Reviewer-Token': process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET,
          'X-AIXSHOP-Reviewer-Id': 'reviewer_1',
        },
        body: JSON.stringify({ decision: 'approved' }),
      });
      assert.equal(crossReviewRes.status, 404);
    } finally {
      if (prevSecret === undefined) delete process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET;
      else process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET = prevSecret;
    }
  });

  test('6. Server-owned Shopify Gift Card provenance: GraphQL sync + Webhook toggle + Disconnected fail-closed + PUT survival', async () => {
    const prevEncKey = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
    const prevSecret = process.env.SHOPIFY_API_SECRET;
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SHOPIFY_API_SECRET = 'shopify_test_webhook_secret_123456';

    try {
      const tenant = await registerPaidTenant('shopify_prov@example.com', 'Shopify Provenance Store');
      const shopDomain = 'provenance-shop.myshopify.com';
      await repo.saveShopifyConnection({
        id: `conn_${tenant.workspace.id}`,
        workspaceId: tenant.workspace.id,
        shopDomain,
        accessTokenEncrypted: encryptCredential('shpat_test_token_123'),
        refreshTokenEncrypted: null,
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshTokenExpiresAt: null,
        lastRefreshedAt: null,
        webhookSubscriptions: [],
        grantedScopes: 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    cursor: 'c1',
                    node: {
                      id: 'gid://shopify/Product/70001',
                      title: 'Digital Store Gift Card',
                      description: 'E-gift card',
                      vendor: 'GiftCo',
                      productType: 'Gift Cards',
                      handle: 'digital-gift-card',
                      status: 'ACTIVE',
                      isGiftCard: true,
                      updatedAt: '2026-11-10T10:00:00Z',
                      images: { edges: [] },
                      variants: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        edges: [
                          {
                            cursor: 'v1',
                            node: {
                              id: 'gid://shopify/ProductVariant/80001',
                              title: '$50',
                              sku: 'GC-50',
                              barcode: '',
                              price: '50.00',
                              inventoryQuantity: 100,
                              selectedOptions: [],
                            },
                          },
                        ],
                      },
                    },
                  },
                  {
                    cursor: 'c2',
                    node: {
                      id: 'gid://shopify/Product/70002',
                      title: 'Handmade Mug Missing GTIN',
                      description: 'Ceramic mug',
                      vendor: 'GiftCo',
                      productType: 'Drinkware',
                      handle: 'handmade-mug',
                      status: 'ACTIVE',
                      isGiftCard: false,
                      updatedAt: '2026-11-10T10:00:00Z',
                      images: { edges: [] },
                      variants: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        edges: [
                          {
                            cursor: 'v2',
                            node: {
                              id: 'gid://shopify/ProductVariant/80002',
                              title: 'Default',
                              sku: 'MUG-01',
                              barcode: '',
                              price: '28.00',
                              inventoryQuantity: 15,
                              selectedOptions: [],
                            },
                          },
                        ],
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

      const syncRes = await syncShopifyCatalog(repo, tenant.workspace.id, { customFetch: mockFetch });
      assert.equal(syncRes.productsImported, 2);

      // Run audit: 70001 gift card is verified_exempt, 70002 mug needs review
      const audit1 = await repo.executeWorkspaceAudit(tenant.workspace.id);
      assert.equal(
        audit1.catalog.findings.some((f) => f.productId === 'p_shopify_70001' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'),
        false,
        'Synced Shopify Gift Card (isGiftCard=true) must be verified_exempt'
      );
      assert.equal(
        audit1.catalog.findings.some(
          (f) => f.productId === 'p_shopify_70002' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' && f.reviewStatus === 'NEEDS_REVIEW'
        ),
        true,
        'Non-gift-card Shopify product without barcode must trigger NEEDS_REVIEW'
      );

      // Unrelated PUT editing gift card description preserves its server gift-card exemption
      const catAfterSync = (await repo.loadWorkspaceCatalog(tenant.workspace.id))!;
      const editedProducts = catAfterSync.products.map((p) =>
        p.id === 'p_shopify_70001' ? { ...p, description: 'Updated merchant marketing copy' } : p
      );
      const putUnrelatedRes = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          expectedVersion: catAfterSync.catalogVersion,
          payload: {
            ...catAfterSync,
            products: editedProducts,
          },
        }),
      });
      assert.equal(putUnrelatedRes.status, 200);

      // Client attempting to promote 70002 (non-gift-card) to gift card via PUT must be rejected 403
      const catAfterEdit = (await repo.loadWorkspaceCatalog(tenant.workspace.id))!;
      const forgedProducts = catAfterEdit.products.map((p) =>
        p.id === 'p_shopify_70002' ? { ...p, attributes: { ...p.attributes, shopifyIsGiftCard: 'true' } } : p
      );
      const forgePromoteRes = await fetch(`${baseUrl}/api/catalog`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenant.token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          expectedVersion: catAfterEdit.catalogVersion,
          payload: {
            ...catAfterEdit,
            products: forgedProducts,
          },
        }),
      });
      assert.equal(forgePromoteRes.status, 403);

      // Signed Shopify webhook toggling 70001 gift_card: false revokes exemption
      const webhookPayload = JSON.stringify({
        id: 70001,
        title: 'Converted Physical Card Box',
        vendor: 'GiftCo',
        product_type: 'Merchandise',
        handle: 'digital-gift-card',
        status: 'active',
        gift_card: false,
        updated_at: '2026-11-11T10:00:00Z',
        variants: [{ id: 80001, sku: 'GC-50', title: '$50', barcode: '', price: '50.00', inventory_quantity: 100 }],
      });
      const hmac = signShopifyWebhookHmac(webhookPayload, process.env.SHOPIFY_API_SECRET!);
      const whRes = await processShopifyWebhook(repo, webhookPayload, {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': shopDomain,
        'x-shopify-delivery-id': 'del_gc_toggle_false',
      });
      assert.equal(whRes.processed, true);

      const auditAfterToggle = await repo.executeWorkspaceAudit(tenant.workspace.id);
      assert.equal(
        auditAfterToggle.catalog.findings.some(
          (f) => f.productId === 'p_shopify_70001' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' && f.reviewStatus === 'NEEDS_REVIEW'
        ),
        true,
        'Toggling gift_card=false via webhook must revoke gift card exemption'
      );

      // Disconnected Shopify store must fail closed even if provenance record had isGiftCard=true
      const whRestorePayload = JSON.stringify({
        id: 70001,
        title: 'Digital Store Gift Card',
        vendor: 'GiftCo',
        product_type: 'Gift Cards',
        handle: 'digital-gift-card',
        status: 'active',
        gift_card: true,
        updated_at: '2026-11-12T10:00:00Z',
        variants: [{ id: 80001, sku: 'GC-50', title: '$50', barcode: '', price: '50.00', inventory_quantity: 100 }],
      });
      const hmac2 = signShopifyWebhookHmac(whRestorePayload, process.env.SHOPIFY_API_SECRET!);
      await processShopifyWebhook(repo, whRestorePayload, {
        'x-shopify-hmac-sha256': hmac2,
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': shopDomain,
        'x-shopify-delivery-id': 'del_gc_toggle_true',
      });

      await repo.deleteShopifyConnection(tenant.workspace.id);
      const auditDisconnected = await repo.executeWorkspaceAudit(tenant.workspace.id);
      assert.equal(
        auditDisconnected.catalog.findings.some(
          (f) => f.productId === 'p_shopify_70001' && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' && f.reviewStatus === 'NEEDS_REVIEW'
        ),
        true,
        'Disconnected Shopify connection must fail closed for gift-card GTIN exemption'
      );
    } finally {
      if (prevEncKey === undefined) delete process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
      else process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = prevEncKey;
      if (prevSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
      else process.env.SHOPIFY_API_SECRET = prevSecret;
    }
  });

  test('7. Invalid GTIN check digits still fail critically even with server-verified exemption; valid GTIN-8/12/13/14 + leading zeros preserved', async () => {
    const tenant = await registerPaidTenant('gtin_formats@example.com', 'GTIN Formats Store');

    const pBadCheckDigit: Product = {
      ...makeUnbarcodedProduct('p_bad_check', 'Exempt Brand Bad Barcode'),
      variants: [
        { id: 'v_bad', sku: 'BAD-1', title: 'Default', barcode: '0850029381019', price: 20, inventoryCount: 5, attributes: {} },
      ],
    };
    const pLeadingZeros: Product = {
      ...makeUnbarcodedProduct('p_leading_zero', 'Valid GTIN-12 & GTIN-8 & GTIN-13 & GTIN-14'),
      variants: [
        { id: 'v_g8', sku: 'G8', title: 'GTIN-8', barcode: '00123457', price: 10, inventoryCount: 5, attributes: {} },
        { id: 'v_g12', sku: 'G12', title: 'GTIN-12', barcode: '012345678905', price: 10, inventoryCount: 5, attributes: {} },
        { id: 'v_g13', sku: 'G13', title: 'GTIN-13', barcode: '0850029381013', price: 10, inventoryCount: 5, attributes: {} },
        { id: 'v_g14', sku: 'G14', title: 'GTIN-14', barcode: '00012345678905', price: 10, inventoryCount: 5, attributes: {} },
      ],
    };

    const putRes = await fetch(`${baseUrl}/api/catalog`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        payload: {
          products: [pBadCheckDigit, pLeadingZeros],
          variants: [...pBadCheckDigit.variants, ...pLeadingZeros.variants],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore(),
        },
      }),
    });
    assert.equal(putRes.status, 200);

    // Attach verified exemption to pBadCheckDigit — invalid barcode MUST STILL fail critically!
    await repo.submitEvidenceDocument({
      workspaceId: tenant.workspace.id,
      productId: pBadCheckDigit.id,
      id: 'ev_exempt_bad_gtin',
      title: 'Exemption Proof',
      type: 'gtin_exemption_proof',
      issuer: 'GS1',
      evidencePurpose: 'gtin_exemption',
      submittedByUserId: tenant.user.id,
    });
    await repo.reviewEvidenceDocument({
      workspaceId: tenant.workspace.id,
      evidenceId: 'ev_exempt_bad_gtin',
      decision: 'approved',
      reviewerId: 'reviewer_1',
      reviewerRole: 'platform_reviewer',
    });

    const auditRes = await repo.executeWorkspaceAudit(tenant.workspace.id);
    const badGtinFinding = auditRes.catalog.findings.find(
      (f) =>
        f.productId === pBadCheckDigit.id &&
        f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT' &&
        f.gtinEligibilityStatus === 'gtin_present'
    );
    assert.ok(badGtinFinding, 'Invalid GTIN check digit must always trigger critical finding even if exemption exists');
    assert.equal(badGtinFinding.severity, 'critical');

    const leadingZeroFindings = auditRes.catalog.findings.filter(
      (f) => f.productId === pLeadingZeros.id && f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'
    );
    assert.equal(leadingZeroFindings.length, 0, 'Valid GTIN-8/12/13/14 with leading zeros must pass GTIN validation cleanly');
  });

  // 8. Conditional Live PostgreSQL Integration for Migration 015
  describe('Live PostgreSQL Migration 015 GTIN Evidence Trust Integration', () => {
    const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST || process.env.PGHOST);
    const skipReason = !hasLivePg
      ? 'SKIPPED: Live PostgreSQL infrastructure credentials (DATABASE_URL / SQL_HOST / PGHOST) not provisioned in current environment'
      : undefined;

    const buildLivePool = () => {
      if (process.env.DATABASE_URL) {
        return new Pool({ connectionString: process.env.DATABASE_URL });
      }
      return new Pool({
        host: process.env.SQL_HOST || process.env.PGHOST,
        port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
        user: process.env.SQL_USER || process.env.PGUSER,
        password: process.env.SQL_PASSWORD || process.env.PGPASSWORD,
        database: process.env.SQL_DB_NAME || process.env.PGDATABASE,
      });
    };

    test('Migration 015: schema default pending, immutable review audit log, Shopify provenance, and PostgresRepository audit execution', { skip: skipReason }, async () => {
      const { runMigrations } = await import('./db/migrate');
      const pool = buildLivePool();
      const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const wsId = `ws_pg_trust_${suffix}`;
      const userId = `usr_pg_trust_${suffix}`;

      try {
        await runMigrations(pool);
        const pgRepo = new PostgresRepository(pool);
        const readiness = await pgRepo.checkSchemaReadiness();
        assert.equal(readiness.isReady, true);

        await pool.query('INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)', [
          userId,
          `${userId}@example.com`,
          'hash',
          'PG Trust User',
        ]);
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          wsId,
          'PG Trust Workspace',
          `pg-trust-${suffix}`,
        ]);
        await pool.query('INSERT INTO workspace_memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)', [
          `mem_${wsId}`,
          wsId,
          userId,
          'owner',
        ]);
        await pool.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, tier, sku_limit, connectors_json)
           VALUES ($1, $2, $3, $4, 'USD', 0, 'Growth', 2500, '[]'::jsonb)`,
          [`store_${wsId}`, wsId, 'PG Trust Store', 'pg-trust.myshopify.com']
        );

        const pEx = makeUnbarcodedProduct('p_pg_exempt', 'Handmade Soap');
        const pGc = makeUnbarcodedProduct('p_shopify_9001', 'Store Gift Card', {
          sourcePlatform: 'shopify',
          sourceProductId: '9001',
          shopifyGid: 'gid://shopify/Product/9001',
          provenance: 'shopify_graphql_admin_api',
        });

        await pgRepo.saveWorkspaceCatalog(wsId, {
          products: [pEx, pGc],
          variants: [...pEx.variants, ...pGc.variants],
          offers: [],
          findings: [],
          actions: [],
          evidence: [],
          storeProfile: makeStore('pg-trust.myshopify.com'),
        });

        // Verify Migration 015 SQL default on evidence_documents.status is 'pending'
        const defRes = await pool.query<{ column_default: string }>(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'evidence_documents' AND column_name = 'status'`
        );
        assert.match(String(defRes.rows[0]?.column_default || ''), /pending/);

        // Submit + approve GTIN exemption via PostgresRepository
        const subRes = await pgRepo.submitEvidenceDocument({
          workspaceId: wsId,
          productId: pEx.id,
          id: `ev_pg_${suffix}`,
          title: 'GS1 Handmade Proof',
          type: 'gtin_exemption_proof',
          issuer: 'GS1',
          evidencePurpose: 'gtin_exemption',
          submittedByUserId: userId,
        });
        assert.equal(subRes.evidence.status, 'pending');
        assert.equal(
          subRes.evidence.integrityHash,
          computeEvidenceIntegrityHash(wsId, pEx.id, subRes.evidence)
        );

        const revRes = await pgRepo.reviewEvidenceDocument({
          workspaceId: wsId,
          evidenceId: `ev_pg_${suffix}`,
          decision: 'approved',
          reviewerId: 'pg_reviewer_1',
          reviewerRole: 'platform_reviewer',
          reason: 'Verified against GS1',
        });
        assert.equal(revRes.evidence.status, 'verified');

        // Seed connected Shopify connection & gift card provenance
        process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY =
          process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        await pgRepo.saveShopifyConnection({
          id: `conn_${wsId}`,
          workspaceId: wsId,
          shopDomain: 'pg-trust.myshopify.com',
          accessTokenEncrypted: encryptCredential('shpat_pg_test'),
          refreshTokenEncrypted: null,
          tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshTokenExpiresAt: null,
          lastRefreshedAt: null,
          webhookSubscriptions: [],
          grantedScopes: 'read_products',
          keyVersion: 'v1',
          status: 'connected',
          installedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await pgRepo.upsertShopifyProductProvenance({
          workspaceId: wsId,
          productId: 'p_shopify_9001',
          shopDomain: 'pg-trust.myshopify.com',
          shopifyProductId: '9001',
          shopifyGid: 'gid://shopify/Product/9001',
          isGiftCard: true,
          sourceType: 'shopify_graphql_admin_api',
          verifiedAt: new Date().toISOString(),
        });

        // Execute audit -> both must be exempted!
        const auditResult = await pgRepo.executeWorkspaceAudit(wsId);
        assert.equal(
          auditResult.catalog.findings.some((f) => f.ruleCode === 'RULE_VARIANT_GTIN_CHECK_DIGIT'),
          false,
          'Both approved GTIN exemption and server-owned Shopify gift card must be exempt in Postgres'
        );

        // Save unrelated catalog update -> verify provenance and review audit log survive saveCatalogRows!
        const reloaded = (await pgRepo.loadWorkspaceCatalog(wsId))!;
        await pgRepo.saveWorkspaceCatalog(wsId, reloaded, { expectedVersion: reloaded.catalogVersion });
        const logs = await pgRepo.getEvidenceReviewAuditLog(wsId, `ev_pg_${suffix}`);
        assert.equal(logs.length, 2, 'Evidence review audit log must survive saveCatalogRows');
        const provAfter = await pgRepo.getShopifyProductProvenance(wsId);
        assert.equal(provAfter.length, 1, 'Shopify product provenance must survive unrelated saveCatalogRows');
      } finally {
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
        await pool.end();
      }
    });
  });
});
