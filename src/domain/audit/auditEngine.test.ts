import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeCatalogAudit,
  AUDIT_RULES,
  buildAuditEntityIds,
  sha256Hex,
  MAX_AUDIT_IDENTIFIER_LENGTH,
} from './auditEngine';
import { mapShopifyProductNodeToDomain } from '../../server/shopify/syncService';
import { Product, StoreProfile } from '../../types';
import { initialProducts, initialStoreProfile, initialActionItems } from '../../data/mockData';

describe('AIXSHOP v1.0 — Catalog Audit Domain Engine Tests', () => {
  it('defines 12 canonical audit rules', () => {
    assert.equal(AUDIT_RULES.length, 12);
  });

  it('evaluates populated catalog and returns deterministic findings, actions, and summary', () => {
    const result = executeCatalogAudit(initialProducts, initialStoreProfile, initialActionItems);

    assert.ok(result.summary);
    assert.equal(result.summary.totalProducts, initialProducts.length);
    assert.ok(result.summary.rulesEvaluated > 0);
    assert.ok(result.summary.totalFindingsCount > 0);
    assert.ok(result.summary.totalActionsCount > 0);
    assert.ok(result.findings.length > 0);
    assert.ok(result.actionItems.length > 0);
    assert.ok(result.updatedProducts.length === initialProducts.length);
    assert.ok(result.updatedStoreProfile.lastAuditDate);
  });

  it('handles empty catalog gracefully with 0 completeness score and 0 findings on product rules', () => {
    const emptyStore: StoreProfile = {
      name: 'Empty Boutique',
      domain: 'empty.myshopify.com',
      currency: 'USD',
      skuCount: 0,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    };

    const result = executeCatalogAudit([], emptyStore, []);

    assert.equal(result.summary.totalProducts, 0);
    assert.equal(result.summary.totalVariants, 0);
    assert.equal(result.summary.catalogCompletenessAvg, 0);
    assert.equal(result.findings.length, 0);
    assert.equal(result.actionItems.length, 0);
    assert.equal(result.updatedProducts.length, 0);
  });

  it('flags missing GTIN barcode as critical finding and generates action item', () => {
    const testProd: Product = {
      id: 'p_test_gtin',
      title: 'Artisan Bowl',
      brand: 'Ceramics Co',
      category: 'Home Goods',
      description: 'Hand-thrown stoneware bowl for daily dining and kitchen serving.',
      image: 'https://example.com/bowl.jpg',
      status: 'active',
      completenessScore: 80,
      evidenceCoverageScore: 50,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [
        { id: 'v1', sku: 'BOWL-01', title: 'Default', barcode: '', price: 25.0, inventoryCount: 5, attributes: {} },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: '',
    };

    const store: StoreProfile = {
      name: 'Test Store',
      domain: 'test.myshopify.com',
      currency: 'USD',
      skuCount: 1,
      catalogCompletenessAvg: 80,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    };

    const result = executeCatalogAudit([testProd], store, []);
    const gtinFinding = result.findings.find(f => f.title.includes('Missing GTIN / Barcode'));

    assert.ok(gtinFinding, 'Should have missing GTIN finding');
    assert.equal(gtinFinding?.severity, 'critical');
    assert.equal(gtinFinding?.productId, 'p_test_gtin');

    const gtinAction = result.actionItems.find(a => a.id === gtinFinding?.actionItemId);
    assert.ok(gtinAction, 'Should have matching action item');
    assert.equal(gtinAction?.severity, 'critical');
  });

  it('flags invalid GTIN-13 check digit as critical finding', () => {
    const testProd: Product = {
      id: 'p_test_invalid_gtin',
      title: 'Linen Napkin',
      brand: 'Linen Co',
      category: 'Textiles',
      description: 'Washed European flax linen napkin set for dining table settings.',
      image: 'https://example.com/napkin.jpg',
      status: 'active',
      completenessScore: 80,
      evidenceCoverageScore: 50,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [
        // 0850029381044 is valid, so 0850029381045 has invalid check digit
        { id: 'v1', sku: 'NAPKIN-01', title: 'Default', barcode: '0850029381045', price: 15.0, inventoryCount: 5, attributes: {} },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: '',
    };

    const store: StoreProfile = {
      name: 'Test Store',
      domain: 'test.myshopify.com',
      currency: 'USD',
      skuCount: 1,
      catalogCompletenessAvg: 80,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    };

    const result = executeCatalogAudit([testProd], store, []);
    const invalidFinding = result.findings.find(f => f.title.includes('Invalid GTIN-13 Check Digit'));

    assert.ok(invalidFinding, 'Should have invalid GTIN finding');
    assert.equal(invalidFinding?.severity, 'critical');
  });

  it('preserves existing approved action status across subsequent audit runs', () => {
    const testProd: Product = {
      id: 'p_test_preserve',
      title: 'Artisan Mug',
      brand: 'Pottery Co',
      category: 'Drinkware',
      description: 'Fine handmade porcelain mug for tea and pour-over coffee.',
      image: 'https://example.com/mug.jpg',
      status: 'active',
      completenessScore: 85,
      evidenceCoverageScore: 60,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {
        microwaveSafe: 'Unspecified',
      },
      variants: [
        { id: 'v1', sku: 'MUG-01', title: 'Default', barcode: '0850029381044', price: 20.0, inventoryCount: 10, attributes: {} },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: '',
    };

    const store: StoreProfile = {
      name: 'Test Store',
      domain: 'test.myshopify.com',
      currency: 'USD',
      skuCount: 1,
      catalogCompletenessAvg: 80,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    };

    // Pre-existing approved action
    const existingApprovedAction = {
      id: 'act_02_p_test_preserve',
      findingId: 'find_02_p_test_preserve',
      productId: 'p_test_preserve',
      productTitle: 'Artisan Mug',
      title: 'Specify Microwave Safety in Structured Attributes',
      severity: 'high' as const,
      status: 'approved' as const,
      approvedAt: '2026-11-01T10:00:00Z',
      evidenceRequired: false,
      proposedChange: {
        field: 'attributes.microwaveSafe',
        from: 'Unspecified',
        to: 'True (Tested up to 900W)',
      },
      verificationStatus: 'verified_in_catalog' as const,
      auditLog: [],
    };

    const result = executeCatalogAudit([testProd], store, [existingApprovedAction]);
    const action = result.actionItems.find(a => a.id === 'act_02_p_test_preserve');

    assert.ok(action);
    assert.equal(action?.status, 'approved', 'Must preserve previously approved status');

    const finding = result.findings.find(f => f.actionItemId === 'act_02_p_test_preserve');
    assert.ok(finding);
    assert.equal(finding?.merchantVerified, true, 'Finding should be marked merchantVerified when action was approved');
  });

  // =========================================================================
  // Workstream A — Bounded Deterministic Finding & Action Identifier Regression
  // =========================================================================
  describe('Workstream A: Bounded Finding & Action ID Generation (VARCHAR(64) Safety)', () => {
    const baseStore: StoreProfile = {
      name: 'Shopify Production Store',
      domain: 'shopify-prod.myshopify.com',
      currency: 'USD',
      skuCount: 1,
      catalogCompletenessAvg: 50,
      truthBoundaryStrictness: 'standard',
      tier: 'Growth',
      connectors: [],
      catalogPolicy: { units: 'mixed' },
      shippingSla: { gmc: '3-5 business days' },
    };

    function assertAllAuditIdsValid(result: ReturnType<typeof executeCatalogAudit>, contextLabel: string) {
      const findingIds = new Set<string>();
      const actionIds = new Set<string>();

      for (const f of result.findings) {
        assert.ok(f.id.length > 0 && f.id.length <= MAX_AUDIT_IDENTIFIER_LENGTH, `${contextLabel}: finding.id "${f.id}" (${f.id.length}) exceeds 64 chars`);
        assert.ok(f.id.startsWith('find_'), `${contextLabel}: finding.id "${f.id}" must preserve find_ namespace`);
        assert.equal(findingIds.has(f.id), false, `${contextLabel}: duplicate finding.id "${f.id}"`);
        findingIds.add(f.id);

        if (f.actionItemId) {
          assert.ok(
            f.actionItemId.length <= MAX_AUDIT_IDENTIFIER_LENGTH,
            `${contextLabel}: finding.actionItemId "${f.actionItemId}" exceeds 64 chars`
          );
          const pairedAction = result.actionItems.find(a => a.id === f.actionItemId);
          assert.ok(pairedAction, `${contextLabel}: finding "${f.id}" missing paired action "${f.actionItemId}"`);
          assert.equal(pairedAction?.findingId, f.id, `${contextLabel}: action.findingId mismatch for "${f.id}"`);
        }

        // Historical snapshot ID `hfind_${runId}_${f.id}` must also fit audit_run_findings.id VARCHAR(128)
        const syntheticRunId = 'audit_1794800000000_abcdef'; // 26 chars
        const historicalId = `hfind_${syntheticRunId}_${f.id}`;
        assert.ok(historicalId.length <= 128, `${contextLabel}: historical ID "${historicalId}" (${historicalId.length}) exceeds 128 chars`);
      }

      for (const a of result.actionItems) {
        assert.ok(a.id.length > 0 && a.id.length <= MAX_AUDIT_IDENTIFIER_LENGTH, `${contextLabel}: action.id "${a.id}" (${a.id.length}) exceeds 64 chars`);
        assert.ok(a.id.startsWith('act_'), `${contextLabel}: action.id "${a.id}" must preserve act_ namespace`);
        assert.equal(actionIds.has(a.id), false, `${contextLabel}: duplicate action.id "${a.id}"`);
        actionIds.add(a.id);
        assert.ok(a.findingId.length > 0 && a.findingId.length <= MAX_AUDIT_IDENTIFIER_LENGTH, `${contextLabel}: action.findingId "${a.findingId}" exceeds 64 chars`);

        const pairedFinding = result.findings.find(f => f.id === a.findingId);
        assert.ok(pairedFinding, `${contextLabel}: action "${a.id}" missing paired finding "${a.findingId}"`);
        assert.equal(pairedFinding?.actionItemId, a.id, `${contextLabel}: finding.actionItemId mismatch for "${a.id}"`);
      }
    }

    it('1. Preserves existing readable ID format for normal short identifiers (<= 64 chars)', () => {
      const ids = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: 'p_01', variantId: 'v_01' });
      assert.equal(ids.findingId, 'find_gtin_missing_p_01_v_01');
      assert.equal(ids.actionId, 'act_gtin_missing_p_01_v_01');
      assert.ok(ids.findingId.length <= 64);
      assert.ok(ids.actionId.length <= 64);

      const prodIds = buildAuditEntityIds({ ruleSlug: 'desc_short', productId: 'p_01' });
      assert.equal(prodIds.findingId, 'find_desc_short_p_01');
      assert.equal(prodIds.actionId, 'act_desc_short_p_01');

      const storeIds = buildAuditEntityIds({ ruleSlug: '04' });
      assert.equal(storeIds.findingId, 'find_04');
      assert.equal(storeIds.actionId, 'act_04');
    });

    it('2 & 3. Bounds long Shopify product IDs and long Shopify variant IDs within VARCHAR(64)', () => {
      const longProdOnly = buildAuditEntityIds({
        ruleSlug: 'desc_short',
        productId: 'p_shopify_product_identifier_exceeding_max_64_characters_1234567890',
      });
      assert.ok(longProdOnly.findingId.length <= 64);
      assert.ok(longProdOnly.actionId.length <= 64);
      assert.match(longProdOnly.findingId, /^find_desc_short_h_[0-9a-f]{32}$/);
      assert.match(longProdOnly.actionId, /^act_desc_short_h_[0-9a-f]{32}$/);

      const longVariantOnly = buildAuditEntityIds({
        ruleSlug: 'gtin_invalid',
        productId: 'p_short',
        variantId: 'v_shopify_variant_identifier_exceeding_max_64_characters_1234567890',
      });
      assert.ok(longVariantOnly.findingId.length <= 64);
      assert.ok(longVariantOnly.actionId.length <= 64);
      assert.match(longVariantOnly.findingId, /^find_gtin_invalid_h_[0-9a-f]{32}$/);
      assert.match(longVariantOnly.actionId, /^act_gtin_invalid_h_[0-9a-f]{32}$/);
    });

    it('4. Realistic 13-16 digit Shopify GraphQL product & variant IDs never overflow VARCHAR(64) during executeCatalogAudit', () => {
      // Previously: find_gtin_missing_p_shopify_8901234567890123_v_shopify_4567890123456789 = 71 chars (PG overflow!)
      const shopifyProduct16 = mapShopifyProductNodeToDomain(
        {
          id: 'gid://shopify/Product/8901234567890123',
          title: 'Trail Runner 16-Digit',
          handle: 'trail-runner-16',
          vendor: '',
          productType: '',
          descriptionHtml: '<p>Short</p>',
          status: 'ACTIVE',
          images: { edges: [] },
          variants: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/ProductVariant/4567890123456789',
                  sku: 'TR-16-A',
                  title: 'Size 10',
                  barcode: '',
                  price: '0.00',
                  inventoryQuantity: 12,
                },
              },
              {
                node: {
                  id: 'gid://shopify/ProductVariant/4567890123456788',
                  sku: 'TR-16-B',
                  title: 'Size 11',
                  barcode: '0850029381045', // invalid check digit
                  price: '129.00',
                  inventoryQuantity: 4,
                },
              },
            ],
          },
        },
        'USD',
        'allbirds-dev.myshopify.com'
      );

      // Realistic 13-digit Shopify IDs (e.g. find_gtin_missing_p_shopify_7890123456789_v_shopify_1234567890123 = 65 chars!)
      const shopifyProduct13 = mapShopifyProductNodeToDomain(
        {
          id: 'gid://shopify/Product/7890123456789',
          title: 'Wool Slipper 13-Digit',
          handle: 'wool-slipper-13',
          vendor: 'Wool Co',
          productType: 'Footwear',
          descriptionHtml: '<p>Comfortable merino wool house slipper made from natural fibers.</p>',
          status: 'ACTIVE',
          images: { edges: [{ node: { url: 'https://cdn.shopify.com/slipper.jpg' } }] },
          variants: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/ProductVariant/1234567890123',
                  sku: 'WS-13-A',
                  title: 'Medium',
                  barcode: '',
                  price: '88.00',
                  inventoryQuantity: 7,
                },
              },
            ],
          },
        },
        'USD',
        'allbirds-dev.myshopify.com'
      );

      assert.equal(shopifyProduct16.id, 'p_shopify_8901234567890123');
      assert.equal(shopifyProduct16.variants[0].id, 'v_shopify_4567890123456789');

      const result = executeCatalogAudit([shopifyProduct16, shopifyProduct13], baseStore, []);
      assert.ok(result.findings.length >= 6, 'Expected variant and product findings for incomplete Shopify products');
      assertAllAuditIdsValid(result, 'shopify-13-16-digit');
    });

    it('5. Long combinations of rule prefix, product ID, and variant ID across all product & variant rules fit <= 64 chars', () => {
      const longProductId = `p_tenant_${'x'.repeat(48)}_end`; // 58 chars
      const longVariantId1 = `v_variant_${'y'.repeat(48)}_01`; // 61 chars
      const longVariantId2 = `v_variant_${'y'.repeat(48)}_02`; // 61 chars

      const prod: Product = {
        id: longProductId,
        title: 'Ceramic Mug Coffee Candle 60-hour',
        brand: '',
        category: '',
        description: 'OEKO-TEX short',
        image: '',
        status: 'active',
        completenessScore: 0,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {
          microwaveSafe: 'Unspecified',
          recommendedBrewMethods: '(none)',
          burnTime: '45-50 Hours',
        },
        variants: [
          { id: longVariantId1, sku: 'LONG-1', title: 'V1', barcode: '', price: null, inventoryCount: 2, attributes: {} },
          { id: longVariantId2, sku: 'LONG-2', title: 'V2', barcode: '0850029381045', price: 0, inventoryCount: 2, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [
          {
            id: 'ev_long_1',
            title: 'Lab Certificate',
            type: 'lab_report',
            issuer: 'UL',
            dateVerified: '2026-01-01',
            url: 'https://example.com/cert.pdf',
            status: 'unverified',
          },
        ],
        findingsCount: 0,
        lastAudited: '',
      };

      const result = executeCatalogAudit([prod], baseStore, []);
      // Emits findings across variant rules (gtin_missing, gtin_invalid, price_invalid), product rules
      // (desc_short, brand_missing, cat_missing, img_missing, 02, 03, 05, 07), and store rules (04, 06)
      assert.ok(result.findings.length >= 12, `Expected >= 12 findings, got ${result.findings.length}`);
      assertAllAuditIdsValid(result, 'long-rule-product-variant-matrix');
    });

    it('6 & 7. Deterministic generation, collision avoidance on shared prefixes/delimiters, missing v.id, and namespace separation', () => {
      // FIPS 180-4 test vector sanity check
      assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

      // Identical inputs yield identical IDs across repeated calls
      const a1 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: 'p_shopify_8901234567890123', variantId: 'v_shopify_4567890123456789' });
      const a2 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: 'p_shopify_8901234567890123', variantId: 'v_shopify_4567890123456789' });
      assert.deepEqual(a1, a2);

      // Namespace separation between Finding and Action
      assert.notEqual(a1.findingId, a1.actionId);
      assert.equal(a1.findingId.replace(/^find_/, ''), a1.actionId.replace(/^act_/, ''));

      // Shared 60-char prefix differing ONLY in the last character -> zero truncation collision!
      const sharedPrefix = 'p_shared_prefix_' + 'a'.repeat(45);
      const vDiff1 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: sharedPrefix, variantId: 'v_suffix_00001' });
      const vDiff2 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: sharedPrefix, variantId: 'v_suffix_00002' });
      assert.notEqual(vDiff1.findingId, vDiff2.findingId);
      assert.notEqual(vDiff1.actionId, vDiff2.actionId);

      // Delimiter ambiguity check when total length triggers hash fallback (> 64 chars): ('a_b', 'c') vs ('a', 'b_c')
      const delim1 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: `p_${'z'.repeat(45)}_a`, variantId: 'b_c' });
      const delim2 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: `p_${'z'.repeat(45)}`, variantId: 'a_b_c' });
      assert.notEqual(delim1.findingId, delim2.findingId);
      assert.ok(delim1.findingId.length <= 64 && delim2.findingId.length <= 64);

      // Distinct rules on same long (productId, variantId) yield distinct IDs
      const ruleA = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: sharedPrefix, variantId: 'v_1' });
      const ruleB = buildAuditEntityIds({ ruleSlug: 'price_invalid', productId: sharedPrefix, variantId: 'v_1' });
      assert.notEqual(ruleA.findingId, ruleB.findingId);

      // Missing variant.id falls back cleanly using variantIndex
      const idx0 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: sharedPrefix, variantId: '', variantIndex: 0 });
      const idx1 = buildAuditEntityIds({ ruleSlug: 'gtin_missing', productId: sharedPrefix, variantId: '', variantIndex: 1 });
      assert.notEqual(idx0.findingId, idx1.findingId);
      assert.ok(idx0.findingId.length <= 64 && idx1.findingId.length <= 64);

      // Repeated executeCatalogAudit produces identical IDs
      const prod: Product = {
        id: 'p_shopify_8901234567890123',
        title: 'Repeat Audit',
        brand: 'Brand',
        category: 'Cat',
        description: 'Long enough product description with plenty of detail.',
        image: 'https://example.com/i.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [
          { id: 'v_shopify_4567890123456781', sku: 'S1', title: 'S1', barcode: '', price: 10, inventoryCount: 1, attributes: {} },
          { id: 'v_shopify_4567890123456782', sku: 'S2', title: 'S2', barcode: '', price: 12, inventoryCount: 1, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      };
      const run1 = executeCatalogAudit([prod], baseStore, []);
      const run2 = executeCatalogAudit([prod], baseStore, []);
      assert.deepEqual(
        run1.findings.map(f => ({ id: f.id, actionItemId: f.actionItemId })),
        run2.findings.map(f => ({ id: f.id, actionItemId: f.actionItemId }))
      );
      assert.deepEqual(
        run1.actionItems.map(a => ({ id: a.id, findingId: a.findingId })),
        run2.actionItems.map(a => ({ id: a.id, findingId: a.findingId }))
      );
    });

    it('8, 9 & 10. Preserves Finding-to-Action integrity and existing historical approved/legacy actions without duplicates or overflow', () => {
      const prodA: Product = {
        id: 'p_shopify_9000000000000001',
        title: 'Legacy Match A',
        brand: 'Ceramics Co',
        category: 'Drinkware',
        description: 'Fine handmade porcelain cup for tea and coffee.',
        image: 'https://example.com/a.jpg',
        status: 'active',
        completenessScore: 80,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: { microwaveSafe: 'Unspecified' },
        variants: [
          { id: 'v_shopify_8000000000000001', sku: 'A1', title: 'Default', barcode: '', price: 20, inventoryCount: 1, attributes: {} },
        ],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: '',
      };
      const prodB: Product = {
        ...prodA,
        id: 'p_shopify_9000000000000002',
        title: 'Legacy Match B',
        variants: [
          { id: 'v_shopify_8000000000000002', sku: 'B1', title: 'Default', barcode: '', price: 20, inventoryCount: 1, attributes: {} },
        ],
      };

      // Run 1 with a legacy fallback action id `act_02` owned by prodA
      const legacyApproved = {
        ...initialActionItems.find(a => a.id === 'act_02')!,
        productId: prodA.id,
        productTitle: prodA.title,
        status: 'approved' as const,
        approvedAt: '2026-11-01T00:00:00Z',
        verificationStatus: 'verified_in_catalog' as const,
      };
      const run1 = executeCatalogAudit([prodA, prodB], baseStore, [legacyApproved]);
      assertAllAuditIdsValid(run1, 'legacy-multi-product');

      // Legacy action id `act_02` may only be claimed by its owner prodA; prodB must get a distinct clean Action
      const act02Matches = run1.actionItems.filter(a => a.id === 'act_02');
      assert.equal(act02Matches.length, 1, 'Legacy action ID must never collide across multiple products');
      assert.equal(act02Matches[0].productId, prodA.id);
      assert.equal(act02Matches[0].status, 'approved');
      const prodBAct02 = run1.actionItems.find(a => a.productId === prodB.id && a.title.includes('Microwave Safety'))!;
      assert.ok(prodBAct02);
      assert.notEqual(prodBAct02.id, 'act_02');
      assert.equal(prodBAct02.status, 'pending_review');
      const prodBFinding02 = run1.findings.find(f => f.id === prodBAct02.findingId)!;
      assert.equal(prodBFinding02.merchantVerified, false);

      // Mark one hashed Shopify GTIN action approved, then re-run audit -> status & relationship preserved
      const hashedGtinAction = run1.actionItems.find(a => a.productId === 'p_shopify_9000000000000001' && a.title.includes('GTIN'))!;
      assert.ok(hashedGtinAction);
      const approvedActions = run1.actionItems.map(a =>
        a.id === hashedGtinAction.id ? { ...a, status: 'approved' as const, approvedAt: '2026-11-16T00:00:00Z' } : a
      );

      const run2 = executeCatalogAudit([prodA, prodB], baseStore, approvedActions);
      assertAllAuditIdsValid(run2, 're-audit-long-approved');

      const preservedAction = run2.actionItems.find(a => a.id === hashedGtinAction.id);
      assert.equal(preservedAction?.status, 'approved');
      const pairedFinding = run2.findings.find(f => f.actionItemId === hashedGtinAction.id);
      assert.equal(pairedFinding?.merchantVerified, true);
    });
  });

  // =========================================================================
  // Workstream A — Legacy Action Cross-Product Contamination Isolation
  // =========================================================================
  describe('Workstream A: Legacy Action Ownership & Cross-Product Isolation (act_02, act_03, act_05, act_07)', () => {
    const isolationStore: StoreProfile = {
      name: 'Isolation Store',
      domain: 'isolation.myshopify.com',
      currency: 'USD',
      skuCount: 2,
      catalogCompletenessAvg: 70,
      truthBoundaryStrictness: 'standard',
      tier: 'Growth',
      connectors: [],
    };

    const makeAllRulesProduct = (id: string, title: string): Product => ({
      id,
      title,
      brand: 'Solstice Artisan',
      category: 'Drinkware Coffee Candle',
      description: `Handcrafted ${title} made with OEKO-TEX Standard 100 cotton and 60-hour burn soy wax blend.`,
      image: `https://example.com/${id}.jpg`,
      status: 'active',
      completenessScore: 80,
      evidenceCoverageScore: 50,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {
        microwaveSafe: 'Unspecified',
        oekoTexCertified: 'Standard 100 (Unverified)',
        recommendedBrewMethods: '(none)',
        burnTime: '45-50 Hours',
      },
      variants: [
        { id: `${id}_v1`, sku: `${id}_SKU`, title: 'Default', barcode: '0850029381044', price: 32, inventoryCount: 5, attributes: {} },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: '',
    });

    const legacySpecs: Array<{
      legacyId: 'act_02' | 'act_03' | 'act_05' | 'act_07';
      ruleCode: string;
      expectedField: string;
    }> = [
      { legacyId: 'act_02', ruleCode: 'RULE_DISHWASHER_MICROWAVE_SAFETY', expectedField: 'attributes.microwaveSafe' },
      { legacyId: 'act_03', ruleCode: 'RULE_UNVERIFIED_EVIDENCE_CLAIMS', expectedField: 'attributes.oekoTexCertified' },
      { legacyId: 'act_05', ruleCode: 'RULE_STRUCTURED_BREW_METHODS', expectedField: 'attributes.recommendedBrewMethods' },
      { legacyId: 'act_07', ruleCode: 'RULE_MARKETING_BURN_TIME_CONFLICT', expectedField: 'title / marketing claims' },
    ];

    it('Scenario 1 — Same Product: preserves approved legacy actions for all 4 fallback IDs when productId matches', () => {
      for (const spec of legacySpecs) {
        const prodA = makeAllRulesProduct(`prod_owner_${spec.legacyId}`, `Owner Mug Coffee Candle ${spec.legacyId}`);
        const baseLegacy = initialActionItems.find(a => a.id === spec.legacyId)!;
        const legacyForA = {
          ...baseLegacy,
          productId: prodA.id,
          productTitle: prodA.title,
          status: 'approved' as const,
          approvedAt: '2026-11-10T12:00:00Z',
          verificationStatus: 'verified_in_catalog' as const,
          proposedChange: {
            field: spec.expectedField,
            from: 'custom_from_A',
            to: 'custom_approved_to_A',
          },
          auditLog: [
            { timestamp: '2026-11-10T12:00:00Z', actor: 'owner@store.com', action: 'approved', details: 'Verified A' },
          ],
        };

        const result = executeCatalogAudit([prodA], isolationStore, [legacyForA]);
        const finding = result.findings.find(f => f.ruleCode === spec.ruleCode && f.productId === prodA.id)!;
        const action = result.actionItems.find(a => a.id === finding.actionItemId)!;

        assert.ok(finding, `${spec.legacyId}: expected finding`);
        assert.ok(action, `${spec.legacyId}: expected action`);
        assert.equal(action.id, spec.legacyId);
        assert.equal(action.productId, prodA.id);
        assert.equal(action.productTitle, prodA.title);
        assert.equal(action.status, 'approved');
        assert.equal(action.approvedAt, '2026-11-10T12:00:00Z');
        assert.equal(action.proposedChange.to, 'custom_approved_to_A');
        assert.equal(action.auditLog?.length, 1);
        assert.equal(finding.merchantVerified, true);
      }
    });

    it('Scenario 2 & 3 — Different Products & Approved Action Isolation: Product B never inherits Product A state or unowned legacy fallbacks', () => {
      for (const spec of legacySpecs) {
        const prodB = makeAllRulesProduct(`prod_b_${spec.legacyId}`, `Product B Clean Mug Coffee Candle ${spec.legacyId}`);
        const baseLegacy = initialActionItems.find(a => a.id === spec.legacyId)!;

        // Subcase 2a: Approved legacy action explicitly belongs to Product A (Product A absent from catalog batch)
        const approvedForA = {
          ...baseLegacy,
          productId: 'prod_other_A',
          productTitle: 'Product A Contaminated Source',
          status: 'approved' as const,
          approvedAt: '2026-11-11T09:00:00Z',
          verificationStatus: 'verified_in_catalog' as const,
          proposedChange: {
            field: spec.expectedField,
            from: 'A_from',
            to: 'A_SECRET_APPROVED_VALUE',
          },
          auditLog: [
            { timestamp: '2026-11-11T09:00:00Z', actor: 'merchantA@example.com', action: 'approved', details: 'Only for A' },
          ],
        };

        const runWithOtherOwner = executeCatalogAudit([prodB], isolationStore, [approvedForA]);
        const bFinding = runWithOtherOwner.findings.find(f => f.ruleCode === spec.ruleCode && f.productId === prodB.id)!;
        const bAction = runWithOtherOwner.actionItems.find(a => a.id === bFinding.actionItemId)!;

        assert.ok(bFinding, `${spec.legacyId}: expected Product B finding`);
        assert.ok(bAction, `${spec.legacyId}: expected Product B action`);
        assert.notEqual(bAction.id, spec.legacyId, `${spec.legacyId}: Product B must not reuse Product A legacy ID`);
        assert.equal(bAction.findingId, bFinding.id);
        assert.equal(bAction.productId, prodB.id);
        assert.equal(bAction.productTitle, prodB.title);
        assert.equal(bAction.status, 'pending_review');
        assert.equal(bAction.approvedAt, undefined);
        assert.notEqual(bAction.proposedChange.to, 'A_SECRET_APPROVED_VALUE');
        assert.deepEqual(bAction.auditLog, []);
        assert.equal(bFinding.merchantVerified, false);

        // Subcase 2b: Unowned legacy action (productId missing) must NOT be guessed onto Product B
        const unownedLegacy = {
          ...approvedForA,
          productId: undefined,
          productTitle: undefined,
        };
        const runWithUnowned = executeCatalogAudit([prodB], isolationStore, [unownedLegacy]);
        const bUnownedFinding = runWithUnowned.findings.find(f => f.ruleCode === spec.ruleCode && f.productId === prodB.id)!;
        const bUnownedAction = runWithUnowned.actionItems.find(a => a.id === bUnownedFinding.actionItemId)!;

        assert.equal(bUnownedFinding.merchantVerified, false);
        assert.equal(bUnownedAction.status, 'pending_review');
        assert.equal(bUnownedAction.productId, prodB.id);
        assert.equal(bUnownedAction.productTitle, prodB.title);
        assert.deepEqual(bUnownedAction.auditLog, []);
      }
    });

    it('Scenario 4 — Multiple Findings & Actions in single audit run with overlapping legacy fallback IDs (act_02, act_03, act_05, act_07)', () => {
      const prodA = makeAllRulesProduct('prod_alpha', 'Alpha Coffee Mug Candle');
      const prodB = makeAllRulesProduct('prod_beta', 'Beta Coffee Mug Candle');

      const existingForAlpha = legacySpecs.map((spec) => {
        const baseLegacy = initialActionItems.find(a => a.id === spec.legacyId)!;
        return {
          ...baseLegacy,
          productId: prodA.id,
          productTitle: prodA.title,
          status: 'approved' as const,
          approvedAt: '2026-11-12T08:00:00Z',
          verificationStatus: 'verified_in_catalog' as const,
          proposedChange: {
            field: spec.expectedField,
            from: 'alpha_from',
            to: `alpha_approved_${spec.legacyId}`,
          },
          auditLog: [
            { timestamp: '2026-11-12T08:00:00Z', actor: 'alpha@example.com', action: 'approved', details: `Alpha ${spec.legacyId}` },
          ],
        };
      });

      const result = executeCatalogAudit([prodA, prodB], isolationStore, existingForAlpha);

      // Zero duplicate Action IDs or Finding IDs
      const seenActionIds = new Set(result.actionItems.map(a => a.id));
      const seenFindingIds = new Set(result.findings.map(f => f.id));
      assert.equal(seenActionIds.size, result.actionItems.length);
      assert.equal(seenFindingIds.size, result.findings.length);

      for (const spec of legacySpecs) {
        const alphaFinding = result.findings.find(f => f.ruleCode === spec.ruleCode && f.productId === prodA.id)!;
        const alphaAction = result.actionItems.find(a => a.id === alphaFinding.actionItemId)!;
        assert.equal(alphaAction.id, spec.legacyId);
        assert.equal(alphaAction.productId, prodA.id);
        assert.equal(alphaAction.productTitle, prodA.title);
        assert.equal(alphaAction.status, 'approved');
        assert.equal(alphaAction.proposedChange.to, `alpha_approved_${spec.legacyId}`);
        assert.equal(alphaFinding.merchantVerified, true);

        const betaFinding = result.findings.find(f => f.ruleCode === spec.ruleCode && f.productId === prodB.id)!;
        const betaAction = result.actionItems.find(a => a.id === betaFinding.actionItemId)!;
        assert.notEqual(betaAction.id, spec.legacyId);
        assert.equal(betaAction.findingId, betaFinding.id);
        assert.equal(betaAction.productId, prodB.id);
        assert.equal(betaAction.productTitle, prodB.title);
        assert.equal(betaAction.status, 'pending_review');
        assert.equal(betaAction.approvedAt, undefined);
        assert.notEqual(betaAction.proposedChange.to, `alpha_approved_${spec.legacyId}`);
        assert.deepEqual(betaAction.auditLog, []);
        assert.equal(betaFinding.merchantVerified, false);
      }
    });
  });
});


