import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ingestAndAnalyzeStore } from './storeIngestion';
import { MemoryRepository } from '../../server/db/memoryRepository';
import { encryptCredential } from '../../server/security/encryption';
import { syncShopifyCatalog, resumeShopifySync } from '../../server/shopify/syncService';
import { LandingPage } from '../../pages/LandingPage';
import { HomePage } from '../../pages/HomePage';
import { AuthContext } from '../../context/AuthContext';
import { AppContext, AppContextType } from '../../context/AppContext';
import { apiClient, BillingPlansResponse } from '../../api/client';
import { initialProducts, initialStoreProfile, initialFindings, initialActionItems } from '../../data/mockData';
import { evaluateDemoOverwriteProtection } from '../catalog/demoMigrationProtection';

function createUiTestDom() {
  const doc: any = {
    nodeType: 9,
    nodeName: '#document',
    title: 'AIXSHOP Test',
    ownerDocument: null,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  doc.ownerDocument = doc;

  function linkSiblings(nodes: any[]) {
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].previousSibling = i > 0 ? nodes[i - 1] : null;
      nodes[i].nextSibling = i < nodes.length - 1 ? nodes[i + 1] : null;
    }
  }

  function makeElement(tagName: string): any {
    const childNodes: any[] = [];
    const attrs: Record<string, string> = {};
    let _text = '';
    const el: any = {
      nodeType: 1,
      nodeName: tagName.toUpperCase(),
      tagName: tagName.toUpperCase(),
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      ownerDocument: doc,
      parentNode: null,
      childNodes,
      get children() {
        return childNodes.filter(c => c.nodeType === 1);
      },
      nextSibling: null,
      previousSibling: null,
      style: {},
      attributes: attrs,
      value: '',
      disabled: false,
      get firstChild() {
        return childNodes[0] ?? null;
      },
      get lastChild() {
        return childNodes[childNodes.length - 1] ?? null;
      },
      get textContent() {
        if (childNodes.length === 0) return _text;
        return childNodes.map(c => c.textContent).join('');
      },
      set textContent(val: string) {
        childNodes.length = 0;
        _text = String(val ?? '');
      },
      get innerHTML() {
        return childNodes.map(c => c.innerHTML || c.textContent).join('');
      },
      set innerHTML(val: string) {
        childNodes.length = 0;
        _text = String(val ?? '');
      },
      appendChild(child: any) {
        return el.insertBefore(child, null);
      },
      insertBefore(child: any, refChild: any) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = el;
        if (!refChild) childNodes.push(child);
        else {
          const idx = childNodes.indexOf(refChild);
          if (idx === -1) childNodes.push(child);
          else childNodes.splice(idx, 0, child);
        }
        linkSiblings(childNodes);
        return child;
      },
      removeChild(child: any) {
        const idx = childNodes.indexOf(child);
        if (idx !== -1) {
          childNodes.splice(idx, 1);
          child.parentNode = null;
          child.nextSibling = null;
          child.previousSibling = null;
          linkSiblings(childNodes);
        }
        return child;
      },
      setAttribute(k: string, v: string) {
        attrs[k] = String(v);
        if (k === 'disabled') el.disabled = true;
        if (k === 'value') el.value = String(v);
      },
      getAttribute(k: string) {
        return k in attrs ? attrs[k] : null;
      },
      removeAttribute(k: string) {
        delete attrs[k];
        if (k === 'disabled') el.disabled = false;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    return el;
  }

  function makeTextOrComment(nodeType: number, text: string): any {
    const val = String(text ?? '');
    return {
      nodeType,
      nodeName: nodeType === 3 ? '#text' : '#comment',
      ownerDocument: doc,
      parentNode: null,
      childNodes: [],
      children: [],
      nextSibling: null,
      previousSibling: null,
      nodeValue: val,
      firstChild: null,
      lastChild: null,
      get textContent() {
        return nodeType === 3 ? this.nodeValue ?? '' : '';
      },
      set textContent(next: string) {
        this.nodeValue = String(next ?? '');
      },
      innerHTML: '',
      appendChild: (c: any) => c,
      insertBefore: (c: any) => c,
      removeChild: (c: any) => c,
      setAttribute: () => {},
      getAttribute: () => null,
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
  }

  const win: any = {
    document: doc,
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      search: '',
    },
    history: { replaceState: () => {} },
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Element: function Element() {},
    Node: function Node() {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    scrollTo: () => {},
  };

  doc.defaultView = win;
  doc.createElement = (tag: string) => makeElement(tag);
  doc.createElementNS = (_ns: string, tag: string) => makeElement(tag);
  doc.createTextNode = (text: string) => makeTextOrComment(3, text);
  doc.createComment = (text: string) => makeTextOrComment(8, text);
  doc.documentElement = makeElement('html');
  doc.head = makeElement('head');
  doc.body = makeElement('body');

  return { doc, win, container: makeElement('div') };
}

function buildMockAppContext(overrides: Partial<AppContextType> = {}): AppContextType {
  return {
    currentPage: 'landing',
    previousPage: 'home',
    selectedProductId: initialProducts[0]?.id ?? null,
    selectedActionId: null,
    storeProfile: initialStoreProfile,
    products: initialProducts,
    variantsCount: initialProducts.flatMap(p => p.variants || []).length,
    offersCount: initialProducts.flatMap(p => p.offers || []).length,
    findings: initialFindings,
    actionItems: initialActionItems,
    evidenceCount: initialProducts.flatMap(p => p.evidenceDocuments || []).length,
    toasts: [],
    quickCheckResult: null,
    lastIngestionResult: null,
    isCheckingStore: false,
    selectedProduct: initialProducts[0] ?? null,
    mobileMenuOpen: false,
    isReadOnlyMode: false,
    readOnlyReason: null,
    storageLoadResult: null,
    isDurableStorage: true,
    isCloudWorkspace: false,
    cloudCatalogStatus: 'idle',
    loadedWorkspaceId: null,
    cloudCatalogError: null,
    catalogVersion: undefined,
    demoOverwriteProtection: evaluateDemoOverwriteProtection({
      isCloudWorkspace: false,
      cloudCatalogStatus: 'idle',
      productsCount: initialProducts.length,
      variantsCount: initialProducts.flatMap(p => p.variants || []).length,
      offersCount: initialProducts.flatMap(p => p.offers || []).length,
      findingsCount: initialFindings.length,
      actionsCount: initialActionItems.length,
      evidenceCount: initialProducts.flatMap(p => p.evidenceDocuments || []).length,
    }),
    setMobileMenuOpen: () => {},
    setSelectedActionId: () => {},
    navigateTo: () => {},
    viewProductDetail: () => {},
    returnFromProductDetail: () => {},
    runStoreCheck: async () => {},
    importDiscoveredProducts: async () => null,
    approveAction: () => {},
    dismissAction: () => {},
    recheckAction: () => {},
    recheckProduct: () => {},
    updateStoreProfile: () => ({ success: true }),
    toggleConnectorSync: () => ({ success: true }),
    migrateDemoDataToCloud: async () => false,
    runAudit: async () => null,
    addToast: () => {},
    removeToast: () => {},
    resetToSeedData: () => {},
    reloadWorkspaceCatalog: async () => {},
    ...overrides,
  };
}

const PLAN_FIXTURE: BillingPlansResponse = {
  currency: 'USD',
  plans: [
    {
      id: 'plan_free',
      tier: 'Free Audit',
      name: 'Free Audit',
      priceCents: 0,
      currency: 'USD',
      billingInterval: 'none',
      skuLimit: 2500,
      features: ['Catalog onboarding up to 2,500 SKUs'],
    },
    {
      id: 'plan_starter',
      tier: 'Starter',
      name: 'Starter Plan',
      priceCents: 4900,
      currency: 'USD',
      billingInterval: 'month',
      skuLimit: 250,
      features: ['Up to 250 verified SKUs'],
    },
  ],
};

describe('Task F: Public Store Discovery vs Full Shopify Catalog Sync', () => {
  let prevEncryptionKey: string | undefined;

  beforeEach(() => {
    prevEncryptionKey = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  });

  afterEach(() => {
    if (prevEncryptionKey === undefined) delete process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
    else process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = prevEncryptionKey;
  });

  it('tags Public Store Discovery as Limited Sample (<=25 products, public_products_json_sample) and handles CORS explicitly', async () => {
    const publicRes = await ingestAndAnalyzeStore('https://sample-merchant.example.com', {
      customFetch: async () =>
        new Response(
          JSON.stringify({
            products: [
              {
                id: 901,
                title: 'Handwoven Market Basket',
                vendor: 'Loom Co',
                product_type: 'Home',
                handle: 'market-basket',
                body_html: '<p>Natural seagrass woven basket.</p>',
                variants: [
                  {
                    id: 9011,
                    title: 'Default',
                    sku: 'BASKET-01',
                    barcode: '0850029381082',
                    price: '58.00',
                    available: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    assert.equal(publicRes.scanStatus, 'real_scan');
    assert.match(publicRes.detectedPlatform, /Public Store Discovery — Limited Sample/);
    assert.equal(publicRes.ingestionResult?.source.classification, 'public_feed');
    assert.equal(publicRes.ingestionResult?.source.acquisitionMethod, 'public_products_json_sample');
    assert.equal(publicRes.ingestionResult?.source.isPartialSample, true);
    assert.equal(publicRes.ingestionResult?.source.sampleLimit, 25);
    assert.equal(publicRes.ingestionResult?.candidateProducts[0]?.sourceClassification, 'public_feed');
    assert.equal(publicRes.ingestionResult?.candidateProducts[0]?.acquisitionMethod, 'public_products_json_sample');
    assert.match(publicRes.ingestionResult?.warnings[0] || '', /Limited 25-product sample/i);
    assert.match(publicRes.ingestionResult?.warnings[0] || '', /CORS/i);

    const corsRes = await ingestAndAnalyzeStore('https://cors-blocked-store.example.com', {
      customFetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    assert.equal(corsRes.scanStatus, 'network_failure');
    assert.match(corsRes.detectedPlatform, /CORS/);
    assert.equal(corsRes.ingestionResult?.candidateProducts.length, 0);
    assert.equal(corsRes.ingestionResult?.source.classification, 'unconfigured');
  });

  it('executes Full Shopify Catalog Sync with cursor pagination, resume, deduplication, provenance, and tenant isolation', async () => {
    const repo = new MemoryRepository(false);
    const createdA = await repo.registerUser({
      user: {
        id: 'user_taskf_a',
        email: 'merchant-a-taskf@example.test',
        passwordHash: 'hash_a',
        fullName: 'Merchant A',
      },
      workspace: {
        id: 'ws_taskf_a',
        name: 'Workspace A',
        slug: 'ws-a-taskf',
      },
      session: {
        id: 'sess_taskf_a',
        sessionTokenHash: 'tok_taskf_a',
        userId: 'user_taskf_a',
        activeWorkspaceId: 'ws_taskf_a',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const createdB = await repo.registerUser({
      user: {
        id: 'user_taskf_b',
        email: 'merchant-b-taskf@example.test',
        passwordHash: 'hash_b',
        fullName: 'Merchant B',
      },
      workspace: {
        id: 'ws_taskf_b',
        name: 'Workspace B',
        slug: 'ws-b-taskf',
      },
      session: {
        id: 'sess_taskf_b',
        sessionTokenHash: 'tok_taskf_b',
        userId: 'user_taskf_b',
        activeWorkspaceId: 'ws_taskf_b',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    const wsA = createdA.workspace.id;
    const wsB = createdB.workspace.id;
    const now = new Date().toISOString();

    await repo.saveSubscription({
      id: 'sub_taskf_a',
      workspaceId: wsA,
      provider: 'stripe',
      customerId: 'cus_taskf_a',
      subscriptionId: 'sub_stripe_taskf_a',
      tier: 'Growth',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 86_400_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
      createdAt: now,
      updatedAt: now,
    });

    await repo.saveShopifyConnection({
      id: 'conn_taskf_a',
      workspaceId: wsA,
      shopDomain: 'taskf-store-a.myshopify.com',
      accessTokenEncrypted: encryptCredential('shpat_taskf_fixture_token'),
      grantedScopes: 'read_products',
      keyVersion: 'v1',
      installedAt: now,
      lastVerifiedAt: now,
      status: 'connected',
      webhookSubscriptions: [],
      webhookVerificationStatus: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const makeNode = (id: number, title: string, sku: string) => ({
      id: `gid://shopify/Product/${id}`,
      title,
      handle: `prod-${id}`,
      vendor: 'Solstice',
      productType: 'Goods',
      status: 'ACTIVE',
      descriptionHtml: '<p>Full Shopify OAuth synced item.</p>',
      images: { edges: [] },
      variants: {
        edges: [
          {
            node: {
              id: `gid://shopify/ProductVariant/${id}1`,
              title: 'Default',
              sku,
              barcode: '0850029381082',
              price: '39.00',
              inventoryQuantity: 12,
              selectedOptions: [],
            },
          },
        ],
      },
    });

    const mockShopifyFetch: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body || '{}'));
      const after = parsed?.variables?.after || null;

      if (!after) {
        return new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor_page_1' },
                edges: [
                  { cursor: 'cursor_page_1', node: makeNode(1001, 'OAuth Ceramic Pitcher', 'OAUTH-1001') },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: 'cursor_page_2' },
              edges: [
                { cursor: 'cursor_page_2', node: makeNode(1002, 'OAuth Brass Grinder', 'OAUTH-1002') },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // 1. Page 1 capped with maxPages=1 -> partially_completed with resume cursor
    const partial = await syncShopifyCatalog(repo, wsA, {
      customFetch: mockShopifyFetch,
      maxPages: 1,
      pageSize: 1,
    });
    assert.equal(partial.status, 'partially_completed');
    assert.equal(partial.syncRun.cursorResumed, 'cursor_page_1');
    assert.equal(partial.productsImported, 1);

    // 2. Resume remaining page -> completed, total 2 unique Shopify OAuth products
    const resumed = await resumeShopifySync(repo, wsA, {
      syncRunId: partial.syncRun.id,
      customFetch: mockShopifyFetch,
      maxPages: 5,
      pageSize: 1,
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.productsImported, 1);

    const wsACatalog = await repo.loadWorkspaceCatalog(wsA);
    assert.ok(wsACatalog);
    assert.equal(wsACatalog.products.length, 2);
    for (const p of wsACatalog.products) {
      assert.equal(p.sourceClassification, 'shopify_oauth');
      assert.equal(p.acquisitionMethod, 'shopify_admin_graphql');
    }

    // 3. Re-sync full catalog -> deduplicates (remains 2 products)
    const rerun = await syncShopifyCatalog(repo, wsA, {
      customFetch: mockShopifyFetch,
      maxPages: 5,
      pageSize: 1,
    });
    assert.equal(rerun.status, 'completed');
    const wsACatalogAfterRerun = await repo.loadWorkspaceCatalog(wsA);
    assert.equal(wsACatalogAfterRerun?.products.length, 2);

    // 4. Tenant B remains completely isolated
    const wsBCatalog = await repo.loadWorkspaceCatalog(wsB);
    assert.equal(wsBCatalog?.products.length ?? 0, 0);
    const wsBRuns = await repo.getShopifySyncRuns(wsB, 10);
    assert.equal(wsBRuns.length, 0);
  });

  it('renders clear UI distinction on LandingPage and HomePage between Public Store Discovery and Full Shopify Sync', async () => {
    const dom = createUiTestDom();
    const prevWin = (globalThis as any).window;
    const prevDoc = (globalThis as any).document;
    const prevAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    const origGetPlans = apiClient.getBillingPlans;

    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    apiClient.getBillingPlans = async () => PLAN_FIXTURE;

    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        root.render(
          React.createElement(
            AuthContext.Provider,
            {
              value: {
                user: null,
                activeWorkspace: null,
                workspaces: [],
                isAuthenticated: false,
                isLoading: false,
                authModalOpen: false,
                authModalMode: 'login',
                openAuthModal: () => {},
                closeAuthModal: () => {},
                login: async () => ({ success: false }),
                register: async () => ({ success: false }),
                logout: async () => {},
                switchWorkspace: async () => false,
              },
            },
            React.createElement(
              AppContext.Provider,
              { value: buildMockAppContext() },
              React.createElement(LandingPage)
            )
          )
        );
      });

      const landingText = dom.container.textContent;
      assert.match(landingText, /Public Store Discovery/);
      assert.match(landingText, /Limited Sample \(up to 25\)/);
      assert.match(landingText, /Full Shopify Catalog Sync/);
      assert.match(landingText, /Authenticated OAuth/);

      await act(async () => {
        root.render(
          React.createElement(
            AppContext.Provider,
            {
              value: buildMockAppContext({
                currentPage: 'home',
                storeProfile: {
                  ...initialStoreProfile,
                  sourceClassification: 'public_feed',
                  shopifyConnected: false,
                  domain: 'sample.example.com',
                },
              }),
            },
            React.createElement(HomePage)
          )
        );
      });
      assert.match(dom.container.textContent, /Public Store Discovery \(Limited Sample ≤25\)/);

      await act(async () => {
        root.render(
          React.createElement(
            AppContext.Provider,
            {
              value: buildMockAppContext({
                currentPage: 'home',
                storeProfile: {
                  ...initialStoreProfile,
                  sourceClassification: 'shopify_oauth',
                  shopifyConnected: true,
                  shopifyShopDomain: 'solstice-live.myshopify.com',
                },
              }),
            },
            React.createElement(HomePage)
          )
        );
      });
      assert.match(dom.container.textContent, /Full Shopify Sync \(OAuth\)/);
    } finally {
      await act(async () => {
        root.unmount();
      });
      apiClient.getBillingPlans = origGetPlans;
      (globalThis as any).window = prevWin;
      (globalThis as any).document = prevDoc;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
  });
});
