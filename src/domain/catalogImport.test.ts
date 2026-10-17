import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { 
  ingestAndAnalyzeStore, 
  validateCandidateProduct, 
  evaluateCandidateProducts,
  findMatchingCatalogProduct,
  detectProductConflict,
  ShopifyPublicProduct,
  DEMO_STORE_HOSTNAMES,
  normalizeHostname,
  isDemoStoreHostname
} from './ingestion/storeIngestion';
import {
  parseSourcePrice,
  DECIMAL_PRICE_REGEX,
  parseDecimalPrice,
  isValidDecimalPriceString,
  numberToPlainDecimal
} from './validation/price';
import type { ParsedPriceResult } from './validation/price';
import { 
  executeCatalogImport, 
  CatalogImportContext,
  executeActionApproval,
  executeActionRecheck,
  calculateProductCompleteness
} from './catalog/catalogMutationService';
import { CatalogStorageAdapter, MemoryStorageBackend, CURRENT_SCHEMA_VERSION } from './storage/storageAdapter';
import { Product, Variant, StoreProfile, ActionItem, Finding } from '../types';
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
    assert.equal(candidate.variants[0].inventoryCount, null, 'Inventory count must not be fabricated from public feed; unknown state must be null');
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

  // 14. Remediation A: Explicitly supported demo hostnames
  it('14. correctly identifies explicitly supported demo hostnames without false negatives', async () => {
    // Exact canonical demo store
    assert.equal(isDemoStoreHostname('solsticecraftgoods.store'), true);
    assert.equal(isDemoStoreHostname('solstice.store'), true);
    assert.equal(isDemoStoreHostname('demo.store'), true);
    assert.equal(isDemoStoreHostname('localhost'), true);
    assert.equal(isDemoStoreHostname('127.0.0.1'), true);

    // Safe normalization: case insensitivity, leading whitespace, trailing dots, and www prefix
    assert.equal(isDemoStoreHostname('  SOLSTICEcraftgoods.STORE  '), true);
    assert.equal(isDemoStoreHostname('www.solsticecraftgoods.store'), true);
    assert.equal(isDemoStoreHostname('solsticecraftgoods.store.'), true);
    assert.equal(isDemoStoreHostname('localhost:3000'), true);

    // Ingestion returns demo_fixture for explicitly supported demo host
    const res = await ingestAndAnalyzeStore('https://solsticecraftgoods.store', {
      existingCatalog: products,
    });
    assert.equal(res.scanStatus, 'demo_fixture');
    assert.equal(res.detectedPlatform, 'Solstice Mercantile (Demo Fixture Feed)');
    assert.ok(res.ingestionResult);
    assert.equal(res.ingestionResult.candidateProducts.length, initialProducts.length);
  });

  // 15. Remediation A: Real hostname containing demo-related substring
  it('15. rejects broad substring matches: real stores containing "solstice" or "demo" are NOT classified as demo stores', async () => {
    // Stores that contain 'solstice' but are separate real stores
    assert.equal(isDemoStoreHostname('solstice-candles.com'), false);
    assert.equal(isDemoStoreHostname('mysolsticeshop.com'), false);
    assert.equal(isDemoStoreHostname('solsticedesign.org'), false);
    assert.equal(isDemoStoreHostname('realsolstice.store'), false);
    assert.equal(isDemoStoreHostname('the-solstice-store.com'), false);

    // Stores that contain 'demo' or 'example'
    assert.equal(isDemoStoreHostname('demostore-gear.com'), false);
    assert.equal(isDemoStoreHostname('my-demo.shop'), false);
    assert.equal(isDemoStoreHostname('example.com'), false);

    // Mock response for real store containing 'solstice' in domain
    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify({
        products: [
          createMockShopifyProduct(901, {
            title: 'Real Solstice Artisan Pottery',
            variants: [{ id: 'var_901', title: 'Default', sku: 'REAL-901', barcode: '0850029381082', price: '58.00', available: true }],
          }),
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const res = await ingestAndAnalyzeStore('https://solstice-candles.com', {
      customFetch,
      existingCatalog: products,
    });

    // Must be real_scan, NEVER demo_fixture
    assert.equal(res.scanStatus, 'real_scan');
    assert.notEqual(res.detectedPlatform, 'Solstice Mercantile (Demo Fixture Feed)');
    assert.ok(res.ingestionResult);
    assert.equal(res.ingestionResult.source.discoveredCount, 1);
    assert.equal(res.ingestionResult.candidateProducts[0].title, 'Real Solstice Artisan Pottery');
  });

  // 16. Remediation A: Hostnames that resemble, but are not identical to, allowlist entries
  it('16. prevents spoofing and rejects hostnames that resemble allowlist entries', async () => {
    // Subdomain takeovers / spoof attempts
    assert.equal(isDemoStoreHostname('realdemo.store'), false);
    assert.equal(isDemoStoreHostname('demo.store.attacker.com'), false);
    assert.equal(isDemoStoreHostname('solsticecraftgoods.store.phishing.io'), false);
    assert.equal(isDemoStoreHostname('fake-solstice.store'), false);
    assert.equal(isDemoStoreHostname('solstice.store.co'), false);
    assert.equal(isDemoStoreHostname('notlocalhost'), false);
  });

  // 17. Honest failure reporting without silent demo fallback
  it('17. never silently substitutes demo products when a real store scan fails or encounters CORS restrictions', async () => {
    // Failing real store request (HTTP 404)
    const failingFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        statusText: 'Not Found',
      });

    const failRes = await ingestAndAnalyzeStore('https://solstice-candles.com', {
      customFetch: failingFetch,
      existingCatalog: products,
    });

    assert.equal(failRes.scanStatus, 'unsupported_store');
    assert.notEqual(failRes.scanStatus, 'demo_fixture');
    assert.equal(failRes.catalogCompletenessEstimate, 0);
    assert.ok(failRes.ingestionResult);
    assert.equal(failRes.ingestionResult.candidateProducts.length, 0, 'Must NOT substitute demo products on failure');
    assert.ok(failRes.sampleIssues.some(i => i.includes('HTTP 404')));

    // Network / CORS failure
    const networkFailFetch: typeof fetch = async () => {
      throw new Error('Failed to fetch (CORS header missing)');
    };

    const corsRes = await ingestAndAnalyzeStore('https://boutique-solstice.com', {
      customFetch: networkFailFetch,
      existingCatalog: products,
    });

    assert.equal(corsRes.scanStatus, 'network_failure');
    assert.notEqual(corsRes.scanStatus, 'demo_fixture');
    assert.equal(corsRes.catalogCompletenessEstimate, 0);
    assert.ok(corsRes.ingestionResult);
    assert.equal(corsRes.ingestionResult.candidateProducts.length, 0, 'Must NOT substitute demo products on network failure');
    assert.ok(corsRes.sampleIssues.some(i => i.includes('Direct browser fetch was blocked')));
  });

  // 18. Section 2: Price Data Integrity
  it('18. price data integrity: distinguishes valid positive and legitimate zero from missing/malformed prices, prevents invalid prices from becoming free products, and protects catalog', async () => {
    // 18a. Unit validation of parseSourcePrice
    // Valid positive numeric
    const p1 = parseSourcePrice(42.5);
    assert.equal(p1.isValid, true);
    assert.equal(p1.price, 42.5);

    // Valid positive numeric string
    const p2 = parseSourcePrice(' 89.99 ');
    assert.equal(p2.isValid, true);
    assert.equal(p2.price, 89.99);

    // Legitimate zero price (promotional/free sample)
    const p3 = parseSourcePrice(0);
    assert.equal(p3.isValid, true);
    assert.equal(p3.price, 0);

    const p4 = parseSourcePrice('0');
    assert.equal(p4.isValid, true);
    assert.equal(p4.price, 0);

    const p5 = parseSourcePrice('0.00');
    assert.equal(p5.isValid, true);
    assert.equal(p5.price, 0);

    // Missing / null / undefined
    const pMissing = parseSourcePrice(undefined);
    assert.equal(pMissing.isValid, false);
    assert.equal(pMissing.price, null);

    const pNull = parseSourcePrice(null);
    assert.equal(pNull.isValid, false);
    assert.equal(pNull.price, null);

    // Empty and whitespace-only strings
    const pEmpty = parseSourcePrice('');
    assert.equal(pEmpty.isValid, false);
    assert.equal(pEmpty.price, null);

    const pWhitespace = parseSourcePrice('   ');
    assert.equal(pWhitespace.isValid, false);
    assert.equal(pWhitespace.price, null);

    // Malformed and garbage strings
    const pAlpha = parseSourcePrice('free');
    assert.equal(pAlpha.isValid, false);
    assert.equal(pAlpha.price, null);

    const pTrailing = parseSourcePrice('12.50usd');
    assert.equal(pTrailing.isValid, false);
    assert.equal(pTrailing.price, null);

    // Negative prices
    const pNegNum = parseSourcePrice(-10);
    assert.equal(pNegNum.isValid, false);
    assert.equal(pNegNum.price, null);

    const pNegStr = parseSourcePrice('-10.50');
    assert.equal(pNegStr.isValid, false);
    assert.equal(pNegStr.price, null);

    // Non-finite values: NaN, Infinity, -Infinity
    const pNan = parseSourcePrice(NaN);
    assert.equal(pNan.isValid, false);
    assert.equal(pNan.price, null);

    const pInf = parseSourcePrice(Infinity);
    assert.equal(pInf.isValid, false);
    assert.equal(pInf.price, null);

    const pNegInf = parseSourcePrice(-Infinity);
    assert.equal(pNegInf.isValid, false);
    assert.equal(pNegInf.price, null);

    const pInfStr = parseSourcePrice('Infinity');
    assert.equal(pInfStr.isValid, false);
    assert.equal(pInfStr.price, null);

    // Hexadecimal string representations: must be strictly rejected (NOT parsed as base 16)
    const pHexLower = parseSourcePrice('0x10');
    assert.equal(pHexLower.isValid, false, 'Hexadecimal "0x10" must not be parsed as 16');
    assert.equal(pHexLower.price, null);
    assert.ok(pHexLower.reason?.includes('Malformed price string'));

    const pHexUpper = parseSourcePrice('0X1A');
    assert.equal(pHexUpper.isValid, false, 'Hexadecimal "0X1A" must be rejected');
    assert.equal(pHexUpper.price, null);

    // Binary string representations: must be strictly rejected
    const pBin = parseSourcePrice('0b101');
    assert.equal(pBin.isValid, false, 'Binary "0b101" must not be parsed as 5');
    assert.equal(pBin.price, null);

    // Octal string representations: must be strictly rejected
    const pOct = parseSourcePrice('0o77');
    assert.equal(pOct.isValid, false, 'Octal "0o77" must not be parsed as 63');
    assert.equal(pOct.price, null);

    // Scientific / exponential notation: must be strictly rejected
    const pExpLower = parseSourcePrice('1e3');
    assert.equal(pExpLower.isValid, false, 'Exponential "1e3" must not be parsed as 1000');
    assert.equal(pExpLower.price, null);

    const pExpUpper = parseSourcePrice('2.5E2');
    assert.equal(pExpUpper.isValid, false, 'Exponential "2.5E2" must be rejected');
    assert.equal(pExpUpper.price, null);

    // Currency symbols and leading signs: must be rejected as malformed
    const pDollar = parseSourcePrice('$12.50');
    assert.equal(pDollar.isValid, false, 'Currency symbol "$12.50" must be rejected');
    assert.equal(pDollar.price, null);

    const pPlus = parseSourcePrice('+12.50');
    assert.equal(pPlus.isValid, false, 'Leading plus sign "+12.50" must be rejected');
    assert.equal(pPlus.price, null);

    const pNegZero = parseSourcePrice('-0');
    assert.equal(pNegZero.isValid, false, 'Negative zero string "-0" must be rejected');
    assert.equal(pNegZero.price, null);

    // Multiple decimal points and trailing dots: must be rejected
    const pMultiDot = parseSourcePrice('12..50');
    assert.equal(pMultiDot.isValid, false, 'Double dot "12..50" must be rejected');
    assert.equal(pMultiDot.price, null);

    const pThreeDots = parseSourcePrice('12.50.00');
    assert.equal(pThreeDots.isValid, false, 'Multiple dots "12.50.00" must be rejected');
    assert.equal(pThreeDots.price, null);

    // Valid standard decimal merchant prices with various scales
    assert.equal(parseSourcePrice('19').isValid, true);
    assert.equal(parseSourcePrice('19').price, 19);
    assert.equal(parseSourcePrice('0.5').isValid, true);
    assert.equal(parseSourcePrice('0.5').price, 0.5);
    assert.equal(parseSourcePrice('1').isValid, true);
    assert.equal(parseSourcePrice('1').price, 1);
    assert.equal(parseSourcePrice('12.34').isValid, true);
    assert.equal(parseSourcePrice('12.34').price, 12.34);
    assert.equal(parseSourcePrice('1299.99').isValid, true);
    assert.equal(parseSourcePrice('1299.99').price, 1299.99);

    // Incomplete decimals: leading dot and trailing dot must be rejected
    const pLeadDot = parseDecimalPrice('.5');
    assert.equal(pLeadDot.isValid, false, 'Leading dot ".5" must be rejected without leading integer');
    assert.equal(pLeadDot.price, null);

    const pTrailDot = parseDecimalPrice('1.');
    assert.equal(pTrailDot.isValid, false, 'Trailing dot "1." must be rejected without fractional digits');
    assert.equal(pTrailDot.price, null);

    // Explicit signs: "+1", "-1"
    const pPlusOne = parseDecimalPrice('+1');
    assert.equal(pPlusOne.isValid, false, 'Leading plus "+1" must be rejected');
    assert.equal(pPlusOne.price, null);

    const pMinusOne = parseDecimalPrice('-1');
    assert.equal(pMinusOne.isValid, false, 'Leading minus "-1" must be rejected');
    assert.equal(pMinusOne.price, null);

    // Negative zero numeric normalization: -0 normalized to 0
    const pNegZeroNum = parseDecimalPrice(-0);
    assert.equal(pNegZeroNum.isValid, true);
    assert.equal(pNegZeroNum.price, 0);
    assert.equal(Object.is(pNegZeroNum.price, -0), false, '-0 must be normalized to standard 0');

    // Values exceeding JavaScript IEEE-754 safe integer limits (Number.MAX_SAFE_INTEGER: 9007199254740991)
    const pExceedingStr = parseDecimalPrice('9007199254740992');
    assert.equal(pExceedingStr.isValid, false, 'Price string exceeding MAX_SAFE_INTEGER must be rejected');
    assert.equal(pExceedingStr.price, null);
    assert.ok(pExceedingStr.reason?.includes('MAX_SAFE_INTEGER'));

    const pExceedingNum = parseDecimalPrice(9007199254740992);
    assert.equal(pExceedingNum.isValid, false, 'Numeric price exceeding MAX_SAFE_INTEGER must be rejected');
    assert.equal(pExceedingNum.price, null);
    assert.ok(pExceedingNum.reason?.includes('MAX_SAFE_INTEGER'));

    // Safe maximum integer boundary is accepted
    const pMaxSafe = parseDecimalPrice(Number.MAX_SAFE_INTEGER);
    assert.equal(pMaxSafe.isValid, true);
    assert.equal(pMaxSafe.price, Number.MAX_SAFE_INTEGER);

    // Direct verification of DECIMAL_PRICE_REGEX and isValidDecimalPriceString
    assert.equal(DECIMAL_PRICE_REGEX.test('0'), true);
    assert.equal(DECIMAL_PRICE_REGEX.test('0.00'), true);
    assert.equal(DECIMAL_PRICE_REGEX.test('1'), true);
    assert.equal(DECIMAL_PRICE_REGEX.test('12.34'), true);
    assert.equal(DECIMAL_PRICE_REGEX.test('49.95'), true);
    assert.equal(DECIMAL_PRICE_REGEX.test('.5'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('1.'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('+1'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('-1'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('0x10'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('1e3'), false);
    assert.equal(DECIMAL_PRICE_REGEX.test('$10'), false);

    // Decimal Precision Invariants: inputs that suffer binary floating-point precision loss
    const pPrecisionLoss1 = parseDecimalPrice('0.10000000000000001');
    assert.equal(pPrecisionLoss1.isValid, false, '0.10000000000000001 must be rejected for precision loss');
    assert.equal(pPrecisionLoss1.price, null);
    assert.ok(pPrecisionLoss1.reason?.includes('precision loss'));

    const pPrecisionLoss2 = parseDecimalPrice('1.234567890123456789');
    assert.equal(pPrecisionLoss2.isValid, false, '1.234567890123456789 must be rejected for precision loss');
    assert.equal(pPrecisionLoss2.price, null);
    assert.ok(pPrecisionLoss2.reason?.includes('precision loss'));

    // Formatting vs monetary-value equivalence:
    // '0.10' and '0.1' both represent 10 cents and parse to identical numeric value 0.1
    const pTenCents1 = parseDecimalPrice('0.1');
    const pTenCents2 = parseDecimalPrice('0.10');
    assert.equal(pTenCents1.isValid, true);
    assert.equal(pTenCents2.isValid, true);
    assert.equal(pTenCents1.price, 0.1);
    assert.equal(pTenCents2.price, 0.1);

    // '0.50' and '0.5' both represent 50 cents
    assert.equal(parseDecimalPrice('0.50').price, 0.5);
    assert.equal(parseDecimalPrice('0.5').price, 0.5);

    // Small valid fractional prices: must NOT be falsely rejected solely because JavaScript renders them in scientific notation (1e-7)
    const pSmallFrac1 = parseDecimalPrice('0.0000001');
    assert.equal(pSmallFrac1.isValid, true, 'Small decimal fraction "0.0000001" must be accepted');
    assert.equal(pSmallFrac1.price, 0.0000001);
    assert.equal(numberToPlainDecimal(pSmallFrac1.price!), '0.0000001');

    const pSmallFrac2 = parseDecimalPrice('0.00000001');
    assert.equal(pSmallFrac2.isValid, true, 'Small decimal fraction "0.00000001" must be accepted');
    assert.equal(pSmallFrac2.price, 0.00000001);

    const pSmallFrac3 = parseDecimalPrice('0.00000015');
    assert.equal(pSmallFrac3.isValid, true, 'Small decimal fraction "0.00000015" must be accepted');
    assert.equal(pSmallFrac3.price, 0.00000015);

    // Scientific notation string input: must be strictly rejected
    const pSciSmall = parseDecimalPrice('1e-7');
    assert.equal(pSciSmall.isValid, false, 'Scientific notation string "1e-7" must be rejected as non-decimal merchant price');
    assert.equal(pSciSmall.price, null);

    // Leading zeros and trailing fractional zeros: normalized to canonical mathematical values
    const pLeadingZeros1 = parseDecimalPrice('007.50');
    assert.equal(pLeadingZeros1.isValid, true);
    assert.equal(pLeadingZeros1.price, 7.5);

    const pLeadingZeros2 = parseDecimalPrice('012.34');
    assert.equal(pLeadingZeros2.isValid, true);
    assert.equal(pLeadingZeros2.price, 12.34);

    const pTrailingZeros = parseDecimalPrice('12.3400');
    assert.equal(pTrailingZeros.isValid, true);
    assert.equal(pTrailingZeros.price, 12.34);

    const pZeroPadded = parseDecimalPrice('00.00');
    assert.equal(pZeroPadded.isValid, true);
    assert.equal(pZeroPadded.price, 0);

    // 18b. End-to-end ingestion test: feed containing valid and invalid prices
    const testFeed = {
      products: [
        createMockShopifyProduct(801, {
          title: 'Valid Zero Sample',
          variants: [{ id: 'var_801', title: 'Sample', sku: 'FREE-SAMPLE', barcode: '0850029381082', price: '0.00', available: true }],
        }),
        createMockShopifyProduct(802, {
          title: 'Missing Price Item',
          variants: [{ id: 'var_802', title: 'Default', sku: 'NO-PRICE', barcode: '0850029389019', price: undefined, available: true }],
        }),
        createMockShopifyProduct(803, {
          title: 'Empty Price Item',
          variants: [{ id: 'var_803', title: 'Default', sku: 'EMPTY-PRICE', barcode: '0850029389026', price: '   ', available: true }],
        }),
        createMockShopifyProduct(804, {
          title: 'Malformed Price Item',
          variants: [{ id: 'var_804', title: 'Default', sku: 'BAD-PRICE', barcode: '0850029381082', price: 'Call for price', available: true }],
        }),
        createMockShopifyProduct(805, {
          title: 'Negative Price Item',
          variants: [{ id: 'var_805', title: 'Default', sku: 'NEG-PRICE', barcode: '0850029381082', price: '-25.00', available: true }],
        }),
        createMockShopifyProduct(806, {
          title: 'Precision Loss Item 1',
          variants: [{ id: 'var_806', title: 'Default', sku: 'PREC-LOSS-1', barcode: '0850029389019', price: '0.10000000000000001', available: true }],
        }),
        createMockShopifyProduct(807, {
          title: 'Precision Loss Item 2',
          variants: [{ id: 'var_807', title: 'Default', sku: 'PREC-LOSS-2', barcode: '0850029389026', price: '1.234567890123456789', available: true }],
        }),
        createMockShopifyProduct(808, {
          title: 'Valid Ten Cents Item',
          variants: [{ id: 'var_808', title: 'Default', sku: 'TEN-CENTS', barcode: '0850029389033', price: '0.10', available: true }],
        }),
        createMockShopifyProduct(809, {
          title: 'Valid Small Fractional Price Item',
          variants: [{ id: 'var_809', title: 'Default', sku: 'SMALL-FRAC', barcode: '0850029389040', price: '0.0000001', available: true }],
        }),
      ],
    };

    const customFetch: typeof fetch = async () =>
      new Response(JSON.stringify(testFeed), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const scanRes = await ingestAndAnalyzeStore('https://price-integrity-test.com', {
      customFetch,
      existingCatalog: products,
    });

    assert.ok(scanRes.ingestionResult);
    const candidates = scanRes.ingestionResult.candidateProducts;
    const details = scanRes.ingestionResult.evaluationDetails;

    // Check Candidate 801 (Legitimate zero): accepted
    const d801 = details.find(d => d.productId === 'p_801')!;
    assert.equal(d801.status, 'eligible');
    assert.equal(candidates.find(p => p.id === 'p_801')!.variants[0].price, 0);

    // Check Candidate 808 (Valid ten cents): accepted, monetary value 0.1
    const d808 = details.find(d => d.productId === 'p_808')!;
    assert.equal(d808.status, 'eligible');
    assert.equal(candidates.find(p => p.id === 'p_808')!.variants[0].price, 0.1);

    // Check Candidate 809 (Valid small fraction 0.0000001): accepted, monetary value 0.0000001
    const d809 = details.find(d => d.productId === 'p_809')!;
    assert.equal(d809.status, 'eligible');
    assert.equal(candidates.find(p => p.id === 'p_809')!.variants[0].price, 0.0000001);

    // Check Candidate 802 (Missing price): rejected, raw evidence preserved, price is null (NOT 0)
    const c802 = candidates.find(p => p.id === 'p_802')!;
    assert.equal(c802.variants[0].price, null, 'Must NOT convert missing price to 0');
    assert.equal(c802.variants[0].attributes?.rawSourcePrice, 'undefined');
    const d802 = details.find(d => d.productId === 'p_802')!;
    assert.equal(d802.status, 'rejected');
    assert.ok(d802.reasons.some(r => r.includes('price is missing or invalid')));

    // Check Candidate 803 (Empty string price): rejected, price is null (NOT 0)
    const c803 = candidates.find(p => p.id === 'p_803')!;
    assert.equal(c803.variants[0].price, null, 'Must NOT convert whitespace price to 0');
    const d803 = details.find(d => d.productId === 'p_803')!;
    assert.equal(d803.status, 'rejected');

    // Check Candidate 804 (Malformed string): rejected, price is null (NOT 0)
    const c804 = candidates.find(p => p.id === 'p_804')!;
    assert.equal(c804.variants[0].price, null, 'Must NOT convert malformed price to 0');
    const d804 = details.find(d => d.productId === 'p_804')!;
    assert.equal(d804.status, 'rejected');

    // Check Candidate 805 (Negative price): rejected, price is null (NOT 0)
    const c805 = candidates.find(p => p.id === 'p_805')!;
    assert.equal(c805.variants[0].price, null);
    const d805 = details.find(d => d.productId === 'p_805')!;
    assert.equal(d805.status, 'rejected');

    // Check Candidate 806 (Precision loss 0.10000000000000001): rejected, price is null
    const c806 = candidates.find(p => p.id === 'p_806')!;
    assert.equal(c806.variants[0].price, null);
    assert.equal(c806.variants[0].attributes?.rawSourcePrice, '0.10000000000000001');
    assert.ok(c806.variants[0].attributes?.priceError?.includes('precision loss'));
    const d806 = details.find(d => d.productId === 'p_806')!;
    assert.equal(d806.status, 'rejected');

    // Check Candidate 807 (Precision loss 1.234567890123456789): rejected, price is null
    const c807 = candidates.find(p => p.id === 'p_807')!;
    assert.equal(c807.variants[0].price, null);
    assert.equal(c807.variants[0].attributes?.rawSourcePrice, '1.234567890123456789');
    const d807 = details.find(d => d.productId === 'p_807')!;
    assert.equal(d807.status, 'rejected');

    // 18c. Direct import execution: rejects all products with missing/invalid price; only eligible products import
    const initialCatalogCount = products.length;
    const importRes = executeCatalogImport(candidates, getImportContext());
    assert.equal(importRes.success, true);
    assert.equal(importRes.importedCount, 3, 'Candidate 801 (price 0), 808 (price 0.1), and 809 (price 0.0000001) import cleanly');
    assert.equal(importRes.rejectedCount, 6, 'All 6 invalid price candidates must be rejected');
    assert.equal(importRes.nextProducts.length, initialCatalogCount + 3);

    // Existing catalog items strictly preserved
    for (let i = 0; i < initialCatalogCount; i++) {
      assert.deepEqual(importRes.nextProducts[i], products[i], 'Existing catalog data must remain completely intact');
    }

    // 18d. Persistence, re-check, and mutation consistency for decimal prices
    const smallFracProduct = importRes.nextProducts.find(p => p.id === 'p_809')!;
    assert.ok(smallFracProduct);
    assert.equal(smallFracProduct.variants[0].price, 0.0000001);

    // Persistence round-trip verifies small fractional price and 0 price without corruption
    const saveRes = adapter.save({
      products: importRes.nextProducts,
      variants: importRes.nextProducts.flatMap(p => p.variants || []),
      offers: importRes.nextProducts.flatMap(p => p.offers || []),
      findings,
      evidence: [],
      actions: actionItems,
      storeProfile,
    });
    assert.equal(saveRes.success, true);
    const loadRes = adapter.load();
    assert.equal(loadRes.type, 'valid');
    if (loadRes.type === 'valid') {
      const persisted809 = loadRes.envelope.payload.products.find(p => p.id === 'p_809')!;
      assert.equal(persisted809.variants[0].price, 0.0000001);
      const persisted801 = loadRes.envelope.payload.products.find(p => p.id === 'p_801')!;
      assert.equal(persisted801.variants[0].price, 0);
    }

    // Mutation rejection for invalid price leaves catalog completely unchanged
    const originalCandlePrice = products[0].variants[0].price;
    const badPriceAction: ActionItem = {
      id: 'act_bad_price_test',
      findingId: 'find_bad_price',
      productId: products[0].id,
      title: 'Set Invalid Price',
      severity: 'medium',
      status: 'pending_review',
      evidenceRequired: false,
      proposedChange: { field: 'variants[0].price', from: String(originalCandlePrice), to: '0.10000000000000001' },
      verificationStatus: 'unverified',
    };
    const mutRejectRes = executeActionApproval('act_bad_price_test', undefined, {
      products,
      findings,
      actionItems: [badPriceAction],
      storeProfile,
      isReadOnly: false,
    });
    assert.equal(mutRejectRes.success, false);
    assert.equal(mutRejectRes.errorCode, 'UNSUPPORTED_FIELD');
    assert.equal(products[0].variants[0].price, originalCandlePrice, 'Catalog price must not change on mutation failure');

    // Mutation approval with small valid fraction 0.0000001 updates price and verifies in recheck
    const smallFracAction: ActionItem = {
      id: 'act_small_frac_test',
      findingId: 'find_small_frac',
      productId: products[0].id,
      title: 'Set Micro-Transaction Price',
      severity: 'low',
      status: 'pending_review',
      evidenceRequired: false,
      proposedChange: { field: 'variants[0].price', from: String(originalCandlePrice), to: '0.0000001' },
      verificationStatus: 'unverified',
    };
    const mutApproveRes = executeActionApproval('act_small_frac_test', undefined, {
      products,
      findings,
      actionItems: [smallFracAction],
      storeProfile,
      isReadOnly: false,
    });
    assert.equal(mutApproveRes.success, true);
    const updatedProd = mutApproveRes.nextProducts.find(p => p.id === products[0].id)!;
    assert.equal(updatedProd.variants[0].price, 0.0000001);

    // Recheck verifies the small fractional price
    const recheckSmallFrac = executeActionRecheck('act_small_frac_test', {
      products: mutApproveRes.nextProducts,
      findings: mutApproveRes.nextFindings,
      actionItems: mutApproveRes.nextActions,
      storeProfile: mutApproveRes.nextStoreProfile,
      isReadOnly: false,
    });
    assert.equal(recheckSmallFrac.success, true);
    assert.equal(recheckSmallFrac.isVerified, true);
    assert.equal(recheckSmallFrac.verificationStatus, 'verified_in_catalog');

    // Recheck verifies monetary equivalence between '0.10' and stored 0.1
    const tenCentsAction: ActionItem = {
      id: 'act_ten_cents_test',
      findingId: 'find_ten_cents',
      productId: 'p_808',
      title: 'Verify Ten Cents Price',
      severity: 'low',
      status: 'approved',
      evidenceRequired: false,
      proposedChange: { field: 'variants[0].price', from: '0', to: '0.10' },
      verificationStatus: 'recheck_required',
    };
    const recheckTenCents = executeActionRecheck('act_ten_cents_test', {
      products: importRes.nextProducts,
      findings,
      actionItems: [tenCentsAction],
      storeProfile,
      isReadOnly: false,
    });
    assert.equal(recheckTenCents.success, true);
    assert.equal(recheckTenCents.isVerified, true, '0.1 in catalog must verify against expected value "0.10"');
    assert.equal(recheckTenCents.verificationStatus, 'verified_in_catalog');
  });

  // 19. Section 3: SKU Requirements and Stable Product Identity
  it('19. SKU requirements and stable product identity: rejects SKU-less candidate with explicit schema technical reason, preserves multi-variants, deduplicates idempotently, and detects conflicts', async () => {
    // 19a. Product with valid SKU is accepted
    const validSkuProduct: Product = {
      id: 'p_valid_sku',
      title: 'Valid SKU Ceramic Pitcher',
      brand: 'ClayWorks',
      category: 'Tableware',
      description: 'Handmade stoneware pitcher.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: { sourceProductId: '777' },
      variants: [{ id: 'v_val_1', title: 'Standard', sku: 'PITCHER-1L', barcode: '0850029381082', price: 34.0, inventoryCount: null, attributes: {} }],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };
    const valRes = validateCandidateProduct(validSkuProduct);
    assert.equal(valRes.isValid, true);

    // 19b. Product without SKU: rejected with explicit technical reason documenting storage schema v1 requirement
    const missingSkuProduct: Product = {
      ...validSkuProduct,
      id: 'p_missing_sku',
      variants: [{ id: 'v_nosku_1', title: 'Standard', sku: '   ', barcode: '0850029381082', price: 34.0, inventoryCount: null, attributes: {} }],
    };
    const noSkuRes = validateCandidateProduct(missingSkuProduct);
    assert.equal(noSkuRes.isValid, false);
    assert.ok(
      noSkuRes.reasons.some(r => r.includes(`Merchant SKU is required by catalog storage schema v${CURRENT_SCHEMA_VERSION}`)),
      `Must cite storage schema v${CURRENT_SCHEMA_VERSION}`
    );
    assert.ok(
      !noSkuRes.reasons.some(r => r.includes('v1.2')),
      'User-facing error must not cite nonexistent schema v1.2'
    );

    // No dummy or fabricated SKUs are invented
    assert.equal(missingSkuProduct.variants[0].sku.trim(), '');

    // 19c. Product with multiple distinct variants belonging to one source product: all preserved without collapsing
    const multiVariantProduct: Product = {
      id: 'p_multi_var',
      title: 'Hand-Poured Soy Candle',
      brand: 'Studio Crafts',
      category: 'Home Fragrance',
      description: 'Natural soy wax candle in multiple sizes.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: { sourceProductId: '888' },
      variants: [
        { id: 'v_mv_small', title: 'Small 4oz', sku: 'CANDLE-4OZ', barcode: '0850029381082', price: 18.0, inventoryCount: 50, attributes: { sourceVariantId: 'sv_1' } },
        { id: 'v_mv_medium', title: 'Medium 8oz', sku: 'CANDLE-8OZ', barcode: '0850029389019', price: 28.0, inventoryCount: 35, attributes: { sourceVariantId: 'sv_2' } },
        { id: 'v_mv_large', title: 'Large 16oz', sku: 'CANDLE-16OZ', barcode: '0850029389026', price: 42.0, inventoryCount: 20, attributes: { sourceVariantId: 'sv_3' } },
      ],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    const mvImport = executeCatalogImport([multiVariantProduct], getImportContext());
    assert.equal(mvImport.success, true);
    assert.equal(mvImport.importedCount, 1);
    const importedMv = mvImport.nextProducts.find(p => p.id === 'p_multi_var')!;
    assert.equal(importedMv.variants.length, 3, 'All 3 variants must be preserved without collapsing');
    assert.equal(importedMv.variants[0].sku, 'CANDLE-4OZ');
    assert.equal(importedMv.variants[1].sku, 'CANDLE-8OZ');
    assert.equal(importedMv.variants[2].sku, 'CANDLE-16OZ');

    // 19d. Repeated imports of the same source product and variants: idempotent, skipped as duplicate
    const reImportMv = executeCatalogImport([multiVariantProduct], {
      ...getImportContext(),
      products: mvImport.nextProducts,
      storeProfile: mvImport.nextStoreProfile,
    });
    assert.equal(reImportMv.importedCount, 0, 'Re-import must not create duplicate records');
    assert.equal(reImportMv.skippedCount, 1);
    assert.equal(reImportMv.nextProducts.length, mvImport.nextProducts.length);

    // 19e. Conflict with existing catalog product: detected and merchant data preserved
    const conflictingProduct: Product = {
      ...multiVariantProduct,
      title: 'Altered Candle Title From Source',
      brand: 'Different Brand',
    };
    const conflictRes = executeCatalogImport([conflictingProduct], {
      ...getImportContext(),
      products: mvImport.nextProducts,
      storeProfile: mvImport.nextStoreProfile,
    });
    assert.equal(conflictRes.conflictCount, 1);
    assert.equal(conflictRes.importedCount, 0);
    // Preserved merchant data:
    const catalogItem = conflictRes.nextProducts.find(p => p.id === 'p_multi_var')!;
    assert.equal(catalogItem.title, 'Hand-Poured Soy Candle', 'Merchant title must not be overwritten');
    assert.equal(catalogItem.brand, 'Studio Crafts', 'Merchant brand must not be overwritten');
  });

  // 20. Section 4: Three Distinct Inventory States & Storage Round-Trip
  it('20. inventory states: correctly distinguishes known > 0, confirmed zero, and unknown (null) across ingestion, completeness, and storage round-trip', () => {
    // 20a. Three distinct variants representing the 3 states
    const variantKnownPositive: Variant = {
      id: 'v_inv_pos',
      sku: 'INV-POS-100',
      title: 'In Stock 100',
      barcode: '0850029381082',
      price: 25.0,
      inventoryCount: 100, // State 1: Known > 0
      attributes: {},
    };

    const variantConfirmedZero: Variant = {
      id: 'v_inv_zero',
      sku: 'INV-ZERO-000',
      title: 'Confirmed Out of Stock',
      barcode: '0850029389019',
      price: 25.0,
      inventoryCount: 0, // State 2: Confirmed zero
      attributes: {},
    };

    const variantUnknown: Variant = {
      id: 'v_inv_null',
      sku: 'INV-NULL-XXX',
      title: 'Public Feed Sample (Unknown Stock)',
      barcode: '0850029389026',
      price: 25.0,
      inventoryCount: null, // State 3: Unknown / unavailable from source
      attributes: {},
    };

    const testProduct: Product = {
      id: 'p_inv_states',
      title: 'Inventory States Demonstration Product',
      brand: 'Warehouse Brand',
      category: 'Supplies',
      description: 'Demonstrates 3 distinct inventory states without false claims.',
      image: '',
      status: 'active',
      completenessScore: 0,
      evidenceCoverageScore: 0,
      externalDiscoveryStatus: 'observed_in_sample',
      attributes: {},
      variants: [variantKnownPositive, variantConfirmedZero, variantUnknown],
      offers: [],
      evidenceDocuments: [],
      findingsCount: 0,
      lastAudited: new Date().toISOString(),
    };

    // 20b. Completeness calculation works identically and safely across all inventory states
    const score = calculateProductCompleteness(testProduct);
    assert.ok(score > 0, 'Completeness calculates without throwing on null inventory');

    // 20c. Persistence through storageAdapter: validates and saves clean envelope
    const allProducts = [...products, testProduct];
    const saveRes = adapter.save({
      products: allProducts,
      variants: allProducts.flatMap(p => p.variants || []),
      offers: allProducts.flatMap(p => p.offers || []),
      findings,
      evidence: [],
      actions: actionItems,
      storeProfile,
    });
    assert.equal(saveRes.success, true, 'Storage adapter must accept variants with null inventoryCount');

    // 20d. Load round-trip: restores exact states faithfully
    const loadRes = adapter.load();
    assert.equal(loadRes.type, 'valid');
    if (loadRes.type === 'valid') {
      const loadedProd = loadRes.envelope.payload.products.find(p => p.id === 'p_inv_states')!;
      assert.ok(loadedProd);
      assert.equal(loadedProd.variants[0].inventoryCount, 100, 'State 1 (known > 0) preserved');
      assert.equal(loadedProd.variants[1].inventoryCount, 0, 'State 2 (confirmed 0) preserved');
      assert.equal(loadedProd.variants[2].inventoryCount, null, 'State 3 (null/unknown) preserved');
    }
  });

  // 21. Section 5: Scan Status and Completeness Semantics
  it('21. scan status & completeness semantics: accurately separates demo fixture, partial real sample, HTTP failure, and CORS network failure', async () => {
    // 21a. Explicit Demo Fixture: scanStatus is demo_fixture, isPartialSample is false
    const demoRes = await ingestAndAnalyzeStore('https://solsticecraftgoods.store', {
      existingCatalog: products,
    });
    assert.equal(demoRes.scanStatus, 'demo_fixture');
    assert.equal(demoRes.detectedPlatform, 'Solstice Mercantile (Demo Fixture Feed)');
    assert.ok(demoRes.ingestionResult);
    assert.equal(demoRes.ingestionResult.source.isPartialSample, false);
    assert.equal(demoRes.ingestionResult.warnings.length, 0);

    // 21b. Real Live Sample: scanStatus is real_scan, isPartialSample is true (25 limit), clear warning
    const sampleFeed = {
      products: [
        createMockShopifyProduct(1, { title: 'Item 1' }),
        createMockShopifyProduct(2, { title: 'Item 2' }),
      ],
    };
    const sampleFetch: typeof fetch = async () =>
      new Response(JSON.stringify(sampleFeed), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const sampleRes = await ingestAndAnalyzeStore('https://real-boutique-goods.com', {
      customFetch: sampleFetch,
      existingCatalog: products,
    });
    assert.equal(sampleRes.scanStatus, 'real_scan');
    assert.ok(sampleRes.ingestionResult);
    assert.equal(sampleRes.ingestionResult.source.isPartialSample, true);
    assert.equal(sampleRes.ingestionResult.source.sampleLimit, 25);
    assert.ok(sampleRes.ingestionResult.warnings.some(w => w.includes('25-product sample')));
    assert.ok(sampleRes.notice?.includes('Sample evaluation scanned'));

    // 21c. HTTP 403 / Restricted: scanStatus is unsupported_store, candidateProducts is empty
    const forbiddenFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'Access denied' }), { status: 403, statusText: 'Forbidden' });

    const forbiddenRes = await ingestAndAnalyzeStore('https://private-store.com', {
      customFetch: forbiddenFetch,
      existingCatalog: products,
    });
    assert.equal(forbiddenRes.scanStatus, 'unsupported_store');
    assert.ok(forbiddenRes.ingestionResult);
    assert.equal(forbiddenRes.ingestionResult.candidateProducts.length, 0);
    assert.ok(forbiddenRes.sampleIssues.some(i => i.includes('HTTP 403')));

    // 21d. Network / CORS Failure: scanStatus is network_failure, candidateProducts is empty
    const corsFetch: typeof fetch = async () => {
      throw new Error('Failed to fetch due to CORS preflight');
    };
    const corsRes = await ingestAndAnalyzeStore('https://cors-blocked-store.com', {
      customFetch: corsFetch,
      existingCatalog: products,
    });
    assert.equal(corsRes.scanStatus, 'network_failure');
    assert.ok(corsRes.ingestionResult);
    assert.equal(corsRes.ingestionResult.candidateProducts.length, 0);
    assert.ok(corsRes.sampleIssues.some(i => i.includes('Direct browser fetch was blocked')));
  });
});
