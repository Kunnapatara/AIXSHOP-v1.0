import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { 
  ingestAndAnalyzeStore, 
  validateCandidateProduct, 
  evaluateCandidateProducts,
  findMatchingCatalogProduct,
  detectProductConflict,
  ShopifyPublicProduct
} from './ingestion/storeIngestion';
import { 
  executeCatalogImport, 
  CatalogImportContext,
  executeActionApproval,
  executeActionRecheck
} from './catalog/catalogMutationService';
import { CatalogStorageAdapter, MemoryStorageBackend } from './storage/storageAdapter';
import { Product, StoreProfile, ActionItem, Finding } from '../types';
import { initialProducts, initialFindings, initialActionItems, initialStoreProfile } from '../data/mockData';

describe('Store Check → Safe Product Catalog Import Suite', () => {
  let backend: MemoryStorageBackend;
  let adapter: CatalogStorageAdapter;
  let products: Product[];
  let findings: Finding[];
  let actionItems: ActionItem[];
  let storeProfile: StoreProfile;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
    adapter = new CatalogStorageAdapter(backend);
    products = JSON.parse(JSON.stringify(initialProducts));
    findings = JSON.parse(JSON.stringify(initialFindings));
    actionItems = JSON.parse(JSON.stringify(initialActionItems));
    storeProfile = JSON.parse(JSON.stringify(initialStoreProfile));
  });

  const getImportContext = (isReadOnly = false): CatalogImportContext => ({
    products,
    findings,
    actionItems,
    storeProfile,
    isReadOnly,
  });

  // Sample fixture builder for mock Shopify feeds
  const createMockShopifyProduct = (id: number | string, overrides: Partial<ShopifyPublicProduct> = {}): ShopifyPublicProduct => ({
    id,
    title: `Artisan Product ${id}`,
    vendor: 'Studio Crafts',
    product_type: 'Home Decor',
    handle: `artisan-product-${id}`,
    body_html: '<p>Handcrafted artisan decor item with natural textures.</p>',
    variants: [
      {
        id: `var_${id}_1`,
        title: 'Default Variant',
        sku: `SKU-${id}-1`,
        barcode: '0850029381082', // valid GTIN-13
        price: '42.00',
        available: true,
      },
    ],
    ...overrides,
  });

  // 1. Valid ingestion result with multiple products
  it('1. ingests multiple valid products into a typed ingestion result with eligible candidate records', async () => {
    const rawFeed = {
      products: [
        createMockShopifyProduct(101, {
          title: 'Cedar Wood Bowl',
          variants: [{ id: 'var_101_1', title: 'Default', sku: 'SKU-101-1', barcode: '0850029389019', price: '42.00', available: true }],
        }),
        createMockShopifyProduct(102, {
          title: 'Linen Kitchen Towel',
          variants: [{ id: 'var_102_1', title: 'Default', sku: 'SKU-102-1', barcode: '0850029389026', price: '28.00', available: true }],
        }),
      ],
    };

    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify(rawFeed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await ingestAndAnalyzeStore('https://example-shop.com', {
      customFetch,
      existingCatalog: products,
    });

    assert.equal(result.scanStatus, 'real_scan');
    assert.ok(result.ingestionResult, 'ingestionResult must be present');
    assert.equal(result.ingestionResult.source.discoveredCount, 2);
    assert.equal(result.ingestionResult.source.parsedCount, 2);
    assert.equal(result.ingestionResult.candidateProducts.length, 2);

    // Both should be eligible since neither exists in initialProducts
    const eligible = result.ingestionResult.evaluationDetails.filter(d => d.status === 'eligible');
    assert.equal(eligible.length, 2);
    assert.equal(eligible[0].title, 'Cedar Wood Bowl');
    assert.equal(eligible[1].title, 'Linen Kitchen Towel');
  });

  // 2. Empty source catalog
  it('2. handles empty source catalog safely without fabricating products or completeness', async () => {
    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await ingestAndAnalyzeStore('https://empty-shop.com', {
      customFetch,
      existingCatalog: products,
    });

    assert.equal(result.catalogCompletenessEstimate, 0);
    assert.ok(result.ingestionResult);
    assert.equal(result.ingestionResult.candidateProducts.length, 0);
    assert.equal(result.ingestionResult.source.discoveredCount, 0);

    // Attempting import with empty candidates returns success 0 imported
    const importRes = executeCatalogImport([], getImportContext());
    assert.equal(importRes.success, true);
    assert.equal(importRes.importedCount, 0);
    assert.equal(importRes.nextProducts.length, products.length);
  });

  // 3. Malformed or incomplete source records
  it('3. rejects malformed or incomplete source records without corrupting catalog', () => {
    const malformedProducts: Product[] = [
      // Missing title
      {
        id: 'p_bad_title',
        title: '',
        brand: 'Test Brand',
        category: 'Test Category',
        description: 'Valid description here',
        image: '',
        status: 'active',
        completenessScore: 0,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [{ id: 'v1', title: 'V1', sku: 'SKU-1', barcode: '', price: 20, inventoryCount: 0, attributes: {} }],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      },
      // Missing brand
      {
        id: 'p_bad_brand',
        title: 'Product Without Brand',
        brand: '',
        category: 'Test Category',
        description: 'Valid description',
        image: '',
        status: 'active',
        completenessScore: 0,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [{ id: 'v2', title: 'V2', sku: 'SKU-2', barcode: '', price: 25, inventoryCount: 0, attributes: {} }],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      },
      // Invalid negative price variant
      {
        id: 'p_bad_price',
        title: 'Product With Bad Variant Price',
        brand: 'Brand X',
        category: 'Category Y',
        description: 'Valid description',
        image: '',
        status: 'active',
        completenessScore: 0,
        evidenceCoverageScore: 0,
        externalDiscoveryStatus: 'observed_in_sample',
        attributes: {},
        variants: [{ id: 'v3', title: 'V3', sku: 'SKU-3', barcode: '', price: -15, inventoryCount: 0, attributes: {} }],
        offers: [],
        evidenceDocuments: [],
        findingsCount: 0,
        lastAudited: new Date().toISOString(),
      },
    ];

    const evaluation = evaluateCandidateProducts(malformedProducts, products);
    assert.equal(evaluation.eligibleProducts.length, 0);
    assert.equal(evaluation.candidateDetails.length, 3);
    assert.ok(evaluation.candidateDetails.every(d => d.status === 'rejected'));

    // Attempting import
    const importRes = executeCatalogImport(malformedProducts, getImportContext());
    assert.equal(importRes.importedCount, 0);
    assert.equal(importRes.rejectedCount, 3);
    assert.equal(importRes.nextProducts.length, products.length, 'Existing catalog must not be modified');
  });

  // 4. Duplicate records within one ingestion batch
  it('4. detects and deduplicates duplicate records within one ingestion batch', () => {
    const duplicateProduct1: Product = {
      id: 'p_batch_1',
      title: 'Handcrafted Mug',
      brand: 'Ceramics Co',
      category: 'Kitchenware',
      description: 'Stoneware mug with natural glaze.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: { sourceProductId: '9999' },
      variants: [{ id: 'v_dup_1', title: '12oz', sku: 'MUG-12OZ', barcode: '0850029381082', price: 24, inventoryCount: 0, attributes: {} }],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    // Identical product in same batch with different internal ID but same sourceProductId and barcode
    const duplicateProduct2: Product = {
      ...duplicateProduct1,
      id: 'p_batch_2',
    };

    const evaluation = evaluateCandidateProducts([duplicateProduct1, duplicateProduct2], products);
    assert.equal(evaluation.candidateDetails.length, 2);
    assert.equal(evaluation.candidateDetails[0].status, 'eligible');
    assert.equal(evaluation.candidateDetails[1].status, 'duplicate');
    assert.equal(evaluation.eligibleProducts.length, 1);

    const importRes = executeCatalogImport([duplicateProduct1, duplicateProduct2], getImportContext());
    assert.equal(importRes.importedCount, 1);
    assert.equal(importRes.skippedCount, 1);
  });

  // 5. Re-import of previously imported products (Idempotency)
  it('5. ensures re-importing the same candidate batch is idempotent', () => {
    const candidate: Product = {
      id: 'p_new_teapot',
      title: 'Cast Iron Teapot',
      brand: 'Eastern Metal',
      category: 'Teaware',
      description: 'Japanese-style cast iron teapot with stainless steel infuser.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: { sourceProductId: 'teapot_101' },
      variants: [{ id: 'v_tp_1', title: '600ml', sku: 'TEAPOT-600', barcode: '0850029381082', price: 65, inventoryCount: 0, attributes: {} }],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    // First import
    const firstImport = executeCatalogImport([candidate], getImportContext());
    assert.equal(firstImport.success, true);
    assert.equal(firstImport.importedCount, 1);
    assert.equal(firstImport.nextProducts.length, products.length + 1);

    // Second import of the same candidate against updated catalog
    const secondImport = executeCatalogImport([candidate], {
      ...getImportContext(),
      products: firstImport.nextProducts,
    });
    assert.equal(secondImport.success, true);
    assert.equal(secondImport.importedCount, 0, 'No products should be re-imported');
    assert.equal(secondImport.skippedCount, 1, 'Product must be flagged as duplicate/already in catalog');
    assert.equal(secondImport.nextProducts.length, firstImport.nextProducts.length, 'Catalog count must not change');
  });

  // 6. Conflict between incoming data and an existing merchant-edited product
  it('6. detects conflicts with merchant-edited products and preserves catalog data', () => {
    // Existing candle has merchant-edited title and attributes
    const existingCandle = products.find(p => p.id === 'prod_solstice_04')!;
    const originalCandleTitle = existingCandle.title;

    // Incoming candidate with matching barcode but raw/un-remediated title from feed
    const incomingCandle: Product = {
      id: 'p_feed_candle',
      title: 'Solstice Candle Raw Feed Title',
      brand: existingCandle.brand,
      category: existingCandle.category,
      description: existingCandle.description,
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [
        {
          id: 'v_feed_1',
          title: 'Standard',
          sku: existingCandle.variants[0].sku, // Matches SKU
          barcode: existingCandle.variants[0].barcode, // Matches Barcode
          price: 19.99, // Differs from catalog price (34)
          inventoryCount: 0,
          attributes: {},
        },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    const conflictCheck = detectProductConflict(incomingCandle, existingCandle);
    assert.equal(conflictCheck.isConflict, true);
    assert.ok(conflictCheck.differences.some(d => d.includes('Title: incoming')));
    assert.ok(conflictCheck.differences.some(d => d.includes('price')));

    const evaluation = evaluateCandidateProducts([incomingCandle], products);
    assert.equal(evaluation.candidateDetails[0].status, 'conflict');
    assert.equal(evaluation.eligibleProducts.length, 0);

    const importRes = executeCatalogImport([incomingCandle], getImportContext());
    assert.equal(importRes.importedCount, 0);
    assert.equal(importRes.conflictCount, 1);
    
    // Crucial check: merchant catalog product remains strictly untouched!
    const catalogCandle = importRes.nextProducts.find(p => p.id === 'prod_solstice_04')!;
    assert.equal(catalogCandle.title, originalCandleTitle);
    assert.equal(catalogCandle.variants[0].price, existingCandle.variants[0].price);
  });

  // 7. Partial or limited feed reporting
  it('7. explicitly labels partial 25-product sample feeds and limits', async () => {
    const rawProducts: ShopifyPublicProduct[] = Array.from({ length: 25 }, (_, i) => 
      createMockShopifyProduct(200 + i, { title: `Sample Item ${i}` })
    );

    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ products: rawProducts }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await ingestAndAnalyzeStore('https://store-sample.com', {
      customFetch,
      existingCatalog: products,
    });

    assert.equal(result.scanStatus, 'real_scan');
    assert.ok(result.ingestionResult);
    assert.equal(result.ingestionResult.source.isPartialSample, true);
    assert.equal(result.ingestionResult.source.sampleLimit, 25);
    assert.equal(result.ingestionResult.source.discoveredCount, 25);
    assert.ok(result.ingestionResult.warnings.some(w => w.includes('25-product sample')));
  });

  // 8. Network and CORS failure handling
  it('8. handles network and CORS failures gracefully without corrupting catalog', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('Failed to fetch (CORS header missing)');
    };

    const result = await ingestAndAnalyzeStore('https://cors-blocked-store.com', {
      customFetch: failingFetch,
      existingCatalog: products,
    });

    assert.equal(result.scanStatus, 'network_failure');
    assert.ok(result.detectedPlatform.includes('CORS'));
    assert.ok(result.ingestionResult);
    assert.equal(result.ingestionResult.candidateProducts.length, 0);
    assert.equal(result.ingestionResult.evaluationDetails.length, 0);
    assert.ok(result.ingestionResult.warnings.some(w => w.toLowerCase().includes('cors')));

    // Catalog unchanged
    assert.equal(products.length, initialProducts.length);
  });

  // 9. Failed import leaving existing catalog unchanged
  it('9. blocks import in read-only mode and leaves catalog strictly unchanged', () => {
    const validCandidate: Product = {
      id: 'p_ro_candidate',
      title: 'Handmade Wool Scarf',
      brand: 'Nordic Knit',
      category: 'Apparel',
      description: '100% Merino wool winter scarf.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [{ id: 'v_ro_1', title: 'Charcoal', sku: 'SCARF-CHR', barcode: '0850029381082', price: 48, inventoryCount: 0, attributes: {} }],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    const importRes = executeCatalogImport([validCandidate], getImportContext(true));
    assert.equal(importRes.success, false);
    assert.equal(importRes.importedCount, 0);
    assert.ok(importRes.message.includes('read-only'));
    assert.equal(importRes.nextProducts.length, products.length);
  });

  // 10. Successful import updating the internal catalog and persistence through existing architecture
  it('10. imports valid products and persists cleanly through storage adapter', () => {
    const newProduct: Product = {
      id: 'p_e2e_planter',
      title: 'Terracotta Planter Pot',
      brand: 'Earthware',
      category: 'Garden',
      description: 'Porous clay planter pot with drainage tray.',
      image: 'https://images.unsplash.com/photo-planter',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {
        material: 'Terracotta Clay',
      },
      variants: [
        {
          id: 'v_pot_1',
          title: '8-inch',
          sku: 'POT-TERRA-8',
          barcode: '0850029381082',
          price: 29.5,
          inventoryCount: 0,
          attributes: {},
        },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    const importRes = executeCatalogImport([newProduct], getImportContext());
    assert.equal(importRes.success, true);
    assert.equal(importRes.importedCount, 1);
    assert.equal(importRes.nextProducts.length, products.length + 1);
    assert.ok(importRes.nextStoreProfile.skuCount > storeProfile.skuCount);

    // Persist via storage adapter
    const payload = {
      products: importRes.nextProducts,
      variants: importRes.nextProducts.flatMap(p => p.variants || []),
      offers: importRes.nextProducts.flatMap(p => p.offers || []),
      findings,
      actions: actionItems,
      evidence: [],
      storeProfile: importRes.nextStoreProfile,
    };

    const saveRes = adapter.save(payload);
    assert.equal(saveRes.success, true);

    // Verify reload from storage
    const loadRes = adapter.load();
    assert.equal(loadRes.type, 'valid');
    if (loadRes.type === 'valid') {
      const persisted = loadRes.envelope.payload.products.find(p => p.id === 'p_e2e_planter');
      assert.ok(persisted, 'Newly imported product must be persisted');
      assert.equal(persisted.title, 'Terracotta Planter Pot');
      assert.equal(persisted.variants[0].price, 29.5);
      assert.ok(persisted.completenessScore > 0, 'Completeness score must be calculated');
    }
  });

  // 11. No fabricated inventory or unsupported product attributes
  it('11. strictly ensures no fabricated inventory counts or false evidence documents', async () => {
    const rawFeed = {
      products: [createMockShopifyProduct(301, { title: 'Authentic Wool Throw' })],
    };

    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify(rawFeed), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const result = await ingestAndAnalyzeStore('https://store-check-truth.com', {
      customFetch,
      existingCatalog: products,
    });

    const candidate = result.ingestionResult?.candidateProducts[0]!;
    assert.ok(candidate);
    assert.equal(candidate.variants[0].inventoryCount, 0, 'Inventory count must not be fabricated from public feed');
    assert.equal(candidate.evidenceCoverageScore, 0, 'Evidence coverage must be 0 without lab documents');
    assert.equal(candidate.evidenceDocuments.length, 0, 'No fake evidence documents');
    assert.equal(candidate.offers.length, 0, 'Product and Offer must remain distinct');
  });

  // 12. No external-store write-back claims after internal import
  it('12. explicitly documents that internal catalog import does not modify external store', () => {
    const newProduct: Product = {
      id: 'p_nowriteback',
      title: 'Bamboo Cutlery Set',
      brand: 'EcoKitchen',
      category: 'Dining',
      description: 'Portable bamboo utensils in organic pouch.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [{ id: 'v_wb_1', title: 'Set', sku: 'BAMBOO-SET', barcode: '0850029381082', price: 16, inventoryCount: 0, attributes: {} }],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    const importRes = executeCatalogImport([newProduct], getImportContext());
    assert.ok(
      importRes.message.includes('No external store write-back was performed'),
      'Must contain explicit note that external store was not modified'
    );
  });

  // 13. Existing Store Check and catalog mutation behavior remaining intact
  it('13. preserves all existing Store Check and Action approval/recheck behavior intact', async () => {
    // Demo store check
    const demoResult = await ingestAndAnalyzeStore('https://solsticecraftgoods.store', {
      existingCatalog: products,
    });
    assert.equal(demoResult.scanStatus, 'demo_fixture');
    assert.equal(demoResult.catalogCompletenessEstimate, 89);
    assert.ok(demoResult.ingestionResult);

    // Existing Action Approval: does not verify catalog automatically
    const approvalRes = executeActionApproval('act_01', undefined, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: false,
    });
    assert.equal(approvalRes.success, true);
    assert.equal(approvalRes.targetAction?.status, 'approved');
    assert.equal(approvalRes.targetAction?.verificationStatus, 'recheck_required');

    // Recheck verifies against actual catalog state
    const recheckRes = executeActionRecheck('act_01', {
      products: approvalRes.nextProducts,
      findings: approvalRes.nextFindings,
      actionItems: approvalRes.nextActions,
      storeProfile: approvalRes.nextStoreProfile,
      isReadOnly: false,
    });
    assert.equal(recheckRes.success, true);
    assert.equal(recheckRes.isVerified, true);
    assert.equal(recheckRes.verificationStatus, 'verified_in_catalog');
  });
});
