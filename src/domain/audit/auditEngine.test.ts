import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeCatalogAudit, AUDIT_RULES } from './auditEngine';
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
});
