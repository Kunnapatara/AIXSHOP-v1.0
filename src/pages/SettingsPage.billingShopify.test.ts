import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SettingsPage } from './SettingsPage';
import { AuthContext } from '../context/AuthContext';
import { AppContext, AppContextType } from '../context/AppContext';
import {
  apiClient,
  BillingPlansResponse,
  BillingSubscriptionResponse,
  PortalSessionResponse,
  ShopifyConnectResponse,
} from '../api/client';
import { initialProducts, initialStoreProfile, initialFindings, initialActionItems } from '../data/mockData';
import { evaluateDemoOverwriteProtection } from '../domain/catalog/demoMigrationProtection';

function createUiTestDom(initialSearch: string = '') {
  const doc: any = {
    nodeType: 9,
    nodeName: '#document',
    title: 'AIXSHOP Settings Test',
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
        if (child.parentNode) {
          child.parentNode.removeChild(child);
        }
        child.parentNode = el;
        if (!refChild) {
          childNodes.push(child);
        } else {
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

  const locationStub = {
    href: `http://localhost:3000/${initialSearch}`,
    origin: 'http://localhost:3000',
    pathname: '/',
    search: initialSearch,
  };

  const win: any = {
    document: doc,
    location: locationStub,
    history: {
      replaceState: (_state: any, _title: string, url: string) => {
        locationStub.pathname = url || '/';
        locationStub.search = '';
      },
    },
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

  return { doc, win, container: makeElement('div'), locationStub };
}

function getReactProps(node: any): Record<string, any> {
  const key = Object.keys(node || {}).find(k => k.startsWith('__reactProps$'));
  return key ? node[key] : {};
}

function findElements(root: any, predicate: (node: any) => boolean): any[] {
  const results: any[] = [];
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 1 && predicate(node)) {
      results.push(node);
    }
    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }
  walk(root);
  return results;
}

function findButtonByText(root: any, textFragment: string): any | undefined {
  return findElements(
    root,
    n => n.tagName === 'BUTTON' && String(n.textContent || '').includes(textFragment)
  )[0];
}

function isElementDisabled(el: any): boolean {
  const props = getReactProps(el);
  return Boolean(el?.disabled || el?.getAttribute?.('disabled') !== null || props.disabled);
}

function buildMockAppContext(overrides: Partial<AppContextType> = {}): AppContextType {
  return {
    currentPage: 'settings',
    previousPage: 'home',
    selectedProductId: initialProducts[0]?.id ?? null,
    selectedActionId: null,
    storeProfile: {
      ...initialStoreProfile,
      tier: 'Free Audit',
      skuCount: 120,
      skuLimit: 2500,
    },
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
    isCloudWorkspace: true,
    cloudCatalogStatus: 'loaded',
    loadedWorkspaceId: 'ws_1',
    cloudCatalogError: null,
    catalogVersion: 1,
    demoOverwriteProtection: evaluateDemoOverwriteProtection({
      isCloudWorkspace: true,
      cloudCatalogStatus: 'loaded',
      catalogVersion: 1,
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

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const AUTHORITATIVE_PLANS_FIXTURE: BillingPlansResponse = {
  currency: 'USD',
  plans: [
    {
      id: 'plan_free_audit',
      tier: 'Free Audit',
      name: 'Free Audit',
      priceCents: 0,
      currency: 'USD',
      billingInterval: 'none',
      skuLimit: 2500,
      features: ['Catalog onboarding capacity up to 2,500 SKUs'],
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
    {
      id: 'plan_growth',
      tier: 'Growth',
      name: 'Growth Plan',
      priceCents: 14900,
      currency: 'USD',
      billingInterval: 'month',
      skuLimit: 2500,
      features: ['Full catalogue intelligence', 'Up to 2,500 verified SKUs'],
    },
    {
      id: 'plan_enterprise',
      tier: 'Enterprise',
      name: 'Enterprise Plan',
      priceCents: 49900,
      currency: 'USD',
      billingInterval: 'month',
      skuLimit: null,
      features: ['Unlimited SKUs', 'Dedicated SLA'],
    },
  ],
};

function renderSettings(
  dom: ReturnType<typeof createUiTestDom>,
  opts: {
    initialTab?: 'profile' | 'workspace' | 'connectors' | 'subscription';
    isAuthenticated?: boolean;
    appOverrides?: Partial<AppContextType>;
  } = {}
) {
  const authed = opts.isAuthenticated ?? true;
  const authModalCalls: string[] = [];
  const root: Root = createRoot(dom.container);

  const renderPromise = act(async () => {
    root.render(
      React.createElement(
        AuthContext.Provider,
        {
          value: {
            user: authed ? { id: 'u1', email: 'merchant@store.com', fullName: 'Merchant Owner' } : null,
            activeWorkspace: authed ? { id: 'ws_1', name: 'Solstice WS', slug: 'solstice-ws', role: 'owner' } : null,
            workspaces: authed ? [{ id: 'ws_1', name: 'Solstice WS', slug: 'solstice-ws', role: 'owner' }] : [],
            isAuthenticated: authed,
            isLoading: false,
            authModalOpen: false,
            authModalMode: 'login',
            openAuthModal: (mode = 'login') => authModalCalls.push(mode),
            closeAuthModal: () => {},
            login: async () => ({ success: true }),
            register: async () => ({ success: true }),
            logout: async () => {},
            switchWorkspace: async () => true,
          },
        },
        React.createElement(
          AppContext.Provider,
          { value: buildMockAppContext(opts.appOverrides) },
          React.createElement(SettingsPage, opts.initialTab ? { initialTab: opts.initialTab } : {})
        )
      )
    );
  });

  return { root, renderPromise, authModalCalls };
}

describe('Task C3, C4 & C5: SettingsPage Billing & Shopify OAuth Integration', () => {
  let prevWindow: any;
  let prevDocument: any;
  let prevActEnv: any;
  let origGetPlans: typeof apiClient.getBillingPlans;
  let origGetSub: typeof apiClient.getBillingSubscription;
  let origCreateCheckout: typeof apiClient.createCheckoutSession;
  let origCreatePortal: typeof apiClient.createPortalSession;
  let origShopifyStatus: typeof apiClient.getShopifyStatus;
  let origShopifyRuns: typeof apiClient.getShopifySyncRuns;
  let origConnectShopify: typeof apiClient.connectShopify;

  beforeEach(() => {
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    origGetPlans = apiClient.getBillingPlans;
    origGetSub = apiClient.getBillingSubscription;
    origCreateCheckout = apiClient.createCheckoutSession;
    origCreatePortal = apiClient.createPortalSession;
    origShopifyStatus = apiClient.getShopifyStatus;
    origShopifyRuns = apiClient.getShopifySyncRuns;
    origConnectShopify = apiClient.connectShopify;
  });

  afterEach(() => {
    apiClient.getBillingPlans = origGetPlans;
    apiClient.getBillingSubscription = origGetSub;
    apiClient.createCheckoutSession = origCreateCheckout;
    apiClient.createPortalSession = origCreatePortal;
    apiClient.getShopifyStatus = origShopifyStatus;
    apiClient.getShopifySyncRuns = origShopifyRuns;
    apiClient.connectShopify = origConnectShopify;

    (globalThis as any).window = prevWindow;
    (globalThis as any).document = prevDocument;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  });

  describe('Task C3 & C5: Subscription Tab Integration', () => {
    test('displays active paid subscription details, limits, dates, hides internal Stripe IDs, and redirects on Manage Billing', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      const portalDeferred = createDeferred<PortalSessionResponse>();
      let portalCalls = 0;

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () =>
        ({
          workspaceId: 'ws_1',
          subscription: {
            id: 'subrec_internal_1',
            workspaceId: 'ws_1',
            provider: 'stripe',
            customerId: 'cus_SECRET_DO_NOT_RENDER',
            subscriptionId: 'sub_SECRET_DO_NOT_RENDER',
            tier: 'Growth',
            status: 'active',
            currentPeriodStart: '2026-11-01T00:00:00.000Z',
            currentPeriodEnd: '2026-12-01T00:00:00.000Z',
            cancelAtPeriodEnd: false,
          },
          storeProfile: {
            ...initialStoreProfile,
            tier: 'Growth',
            skuCount: 120,
            skuLimit: 2500,
          },
        } as BillingSubscriptionResponse);

      apiClient.createPortalSession = async () => {
        portalCalls += 1;
        return portalDeferred.promise;
      };

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      const text = dom.container.textContent;
      assert.match(text, /Growth/);
      assert.match(text, /active/i);
      assert.match(text, /\$149 \/ mo/);
      assert.match(text, /120 \/ 2500 SKUs/);
      assert.match(text, /Monthly/i);
      assert.doesNotMatch(text, /cus_SECRET_DO_NOT_RENDER/, 'Internal Stripe customer ID must never be exposed');
      assert.doesNotMatch(text, /sub_SECRET_DO_NOT_RENDER/, 'Internal Stripe subscription ID must never be exposed');

      const manageBtn = findButtonByText(dom.container, 'Manage Billing');
      assert.ok(manageBtn, 'Manage Billing button should be rendered for active Stripe subscription');

      await act(async () => {
        getReactProps(manageBtn).onClick?.();
      });

      assert.equal(isElementDisabled(manageBtn), true, 'Manage Billing button must disable while loading');
      assert.match(dom.container.textContent, /Opening Portal/);

      // Duplicate click must be ignored while loading
      await act(async () => {
        getReactProps(manageBtn).onClick?.();
      });
      assert.equal(portalCalls, 1);

      await act(async () => {
        portalDeferred.resolve({
          success: true,
          portalUrl: 'https://billing.stripe.com/p/session/bps_test_portal_123',
          provider: 'stripe',
        });
      });

      assert.equal(dom.locationStub.href, 'https://billing.stripe.com/p/session/bps_test_portal_123');

      await act(async () => {
        root.unmount();
      });
    });

    test('renders Free Audit as Non-Recurring (Free) and $0 without nonely or $0 / mo', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () =>
        ({
          workspaceId: 'ws_1',
          subscription: {
            provider: 'none',
            tier: 'Free Audit',
            status: 'active',
            billingInterval: 'none',
            isRecurring: false,
            cancelAtPeriodEnd: false,
          },
          storeProfile: {
            ...initialStoreProfile,
            tier: 'Free Audit',
            skuCount: 12,
            skuLimit: 2500,
          },
        } as BillingSubscriptionResponse);

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      const text = dom.container.textContent;
      assert.match(text, /Non-Recurring \(Free\)/);
      assert.match(text, /\$0/);
      assert.doesNotMatch(text, /nonely/i, 'UI must never render malformed "nonely" interval label');
      assert.doesNotMatch(text, /\$0\s*\/\s*mo/i, 'Free Audit must never render as recurring $0 / mo');

      await act(async () => {
        root.unmount();
      });
    });

    test('handles failed portal session or invalid portalUrl without redirecting', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () => ({
        workspaceId: 'ws_1',
        subscription: {
          provider: 'stripe',
          tier: 'Starter',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Starter',
          skuCount: 10,
          skuLimit: 250,
        },
      });
      apiClient.createPortalSession = async () => {
        throw new Error('Customer portal unavailable for workspace.');
      };

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      const manageBtn = findButtonByText(dom.container, 'Manage Billing');
      assert.ok(manageBtn);

      await act(async () => {
        getReactProps(manageBtn).onClick?.();
      });

      assert.equal(dom.locationStub.href, 'http://localhost:3000/');
      assert.match(dom.container.textContent, /Customer portal unavailable for workspace/);

      await act(async () => {
        root.unmount();
      });
    });

    test('handles Free/unpaid users accurately and does NOT grant paid access from checkout return query param', async () => {
      const dom = createUiTestDom('?page=settings&tab=subscription&checkout=success&session_id=cs_fake_return');
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      const toasts: Array<{ title: string; message: string }> = [];
      const checkoutCalls: string[] = [];

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () => ({
        workspaceId: 'ws_1',
        subscription: {
          provider: 'none',
          tier: 'Free Audit',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Free Audit',
          skuCount: 40,
          skuLimit: 2500,
        },
      });
      apiClient.createCheckoutSession = async params => {
        checkoutCalls.push(params.tier);
        return {
          success: true,
          sessionId: 'cs_upgrade_1',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_upgrade_1',
          provider: 'stripe',
        };
      };

      const { root, renderPromise } = renderSettings(dom, {
        appOverrides: {
          addToast: (title, message) => toasts.push({ title, message }),
        },
      });
      await renderPromise;

      const text = dom.container.textContent;
      assert.match(text, /Free Audit/);
      assert.match(text, /Free \/ No Paid Plan/);
      assert.equal(findButtonByText(dom.container, 'Manage Billing'), undefined, 'Free user must not see broken Manage Billing portal CTA');
      assert.doesNotMatch(text, /Active Billing Profile/, 'Return URL param must NOT grant paid status when backend reports Free Audit');
      assert.ok(toasts.some(t => t.title.includes('Stripe Checkout Returned')));

      const upgradeGrowthBtn = findButtonByText(dom.container, 'Upgrade to Growth');
      assert.ok(upgradeGrowthBtn);
      await act(async () => {
        getReactProps(upgradeGrowthBtn).onClick?.();
      });
      assert.deepEqual(checkoutCalls, ['Growth']);
      assert.equal(dom.locationStub.href, 'https://checkout.stripe.com/c/pay/cs_upgrade_1');

      await act(async () => {
        root.unmount();
      });
    });

    test('renders Enterprise Unlimited SKU capacity cleanly without NaN%', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () => ({
        workspaceId: 'ws_1',
        subscription: {
          provider: 'stripe',
          tier: 'Enterprise',
          status: 'active',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-12-31T00:00:00.000Z',
        },
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Enterprise',
          skuCount: 8400,
          skuLimit: null as any,
        },
      });

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      const text = dom.container.textContent;
      assert.match(text, /8400 \/ Unlimited SKUs/);
      assert.match(text, /Scheduled to cancel at period end/);
      assert.doesNotMatch(text, /NaN/);

      await act(async () => {
        root.unmount();
      });
    });

    test('rejects untrusted external HTTPS, lookalike Stripe, and HTTP-in-production URLs for portal and upgrade checkout without redirecting', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () => ({
        workspaceId: 'ws_1',
        subscription: {
          provider: 'stripe',
          tier: 'Starter',
          status: 'canceled',
          cancelAtPeriodEnd: false,
        },
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Free Audit',
          skuCount: 10,
          skuLimit: 2500,
        },
      });
      apiClient.createPortalSession = async () => ({
        success: true,
        portalUrl: 'https://billing.stripe.com.evil.com/p/session/bps_bad',
        provider: 'stripe',
      });
      apiClient.createCheckoutSession = async () => ({
        success: true,
        sessionId: 'cs_evil',
        checkoutUrl: 'https://evil-attacker.example.com/c/pay/cs_evil',
        provider: 'stripe',
      });

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      const manageBtn = findButtonByText(dom.container, 'Manage Billing');
      assert.ok(manageBtn);
      await act(async () => {
        getReactProps(manageBtn).onClick?.();
      });
      assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Lookalike portal URL must not redirect');
      assert.match(dom.container.textContent, /missing a valid portal URL/i);

      const upgradeGrowthBtn = findButtonByText(dom.container, 'Upgrade to Growth');
      assert.ok(upgradeGrowthBtn);
      await act(async () => {
        getReactProps(upgradeGrowthBtn).onClick?.();
      });
      assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Arbitrary external checkout URL must not redirect');
      assert.match(dom.container.textContent, /missing a valid checkout URL/i);

      await act(async () => {
        root.unmount();
      });
    });

    test('fails closed on upgrade plans when getBillingPlans fails and recovers on Retry', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      let plansCalls = 0;
      apiClient.getBillingPlans = async () => {
        plansCalls += 1;
        if (plansCalls === 1) {
          throw new Error('Plans endpoint unavailable');
        }
        return AUTHORITATIVE_PLANS_FIXTURE;
      };
      apiClient.getBillingSubscription = async () => ({
        workspaceId: 'ws_1',
        subscription: {
          provider: 'none',
          tier: 'Free Audit',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
        storeProfile: {
          ...initialStoreProfile,
          tier: 'Free Audit',
          skuCount: 15,
          skuLimit: 2500,
        },
      });

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      assert.match(dom.container.textContent, /Plans endpoint unavailable/);
      assert.equal(findButtonByText(dom.container, 'Upgrade to Growth'), undefined, 'Upgrade checkout buttons must not render when plans fail');

      const retryBtn = findButtonByText(dom.container, 'Retry');
      assert.ok(retryBtn);
      await act(async () => {
        getReactProps(retryBtn).onClick?.();
      });

      assert.equal(plansCalls, 2);
      assert.ok(findButtonByText(dom.container, 'Upgrade to Growth'), 'Upgrade button should appear once plans load on Retry');

      await act(async () => {
        root.unmount();
      });
    });

    test('fails closed and disables upgrade checkout buttons when getBillingSubscription fails', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      let subCalls = 0;
      apiClient.getBillingPlans = async () => AUTHORITATIVE_PLANS_FIXTURE;
      apiClient.getBillingSubscription = async () => {
        subCalls += 1;
        if (subCalls === 1) {
          throw new Error('Subscription service temporarily unreachable');
        }
        return {
          workspaceId: 'ws_1',
          subscription: {
            provider: 'none',
            tier: 'Free Audit',
            status: 'active',
            cancelAtPeriodEnd: false,
          },
          storeProfile: {
            ...initialStoreProfile,
            tier: 'Free Audit',
            skuCount: 15,
            skuLimit: 2500,
          },
        };
      };

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'subscription' });
      await renderPromise;

      assert.match(dom.container.textContent, /Subscription service temporarily unreachable/);
      assert.equal(findButtonByText(dom.container, 'Manage Billing'), undefined);
      const upgradeGrowthDuringError = findButtonByText(dom.container, 'Upgrade to Growth');
      if (upgradeGrowthDuringError) {
        assert.equal(isElementDisabled(upgradeGrowthDuringError), true, 'Upgrade CTA must be disabled when subscription fetch fails');
      }

      const retryBtn = findButtonByText(dom.container, 'Retry');
      assert.ok(retryBtn);
      await act(async () => {
        getReactProps(retryBtn).onClick?.();
      });

      assert.equal(subCalls, 2);
      const upgradeGrowthAfterRetry = findButtonByText(dom.container, 'Upgrade to Growth');
      assert.ok(upgradeGrowthAfterRetry);
      assert.equal(isElementDisabled(upgradeGrowthAfterRetry), false);

      await act(async () => {
        root.unmount();
      });
    });
  });

  describe('Task C4 & C5: Shopify OAuth Connect Flow', () => {
    test('submits valid shop domain via API client and redirects to returned Shopify OAuth authUrl without raw JSON output', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      const connectCalls: string[] = [];
      const connectDeferred = createDeferred<ShopifyConnectResponse>();

      apiClient.getShopifyStatus = async () => ({
        connected: false,
        status: 'not_connected',
        shopDomain: null,
        grantedScopes: [],
        installedAt: null,
        lastVerifiedAt: null,
      });
      apiClient.getShopifySyncRuns = async () => ({ success: true, syncRuns: [] });
      apiClient.connectShopify = async shop => {
        connectCalls.push(shop);
        return connectDeferred.promise;
      };

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'connectors' });
      await renderPromise;

      const inputs = findElements(dom.container, n => n.tagName === 'INPUT');
      const shopInput = inputs.find(i =>
        String(i.getAttribute('placeholder') || '').includes('myshopify.com')
      );
      assert.ok(shopInput, 'Shopify domain input should render in disconnected state');

      const form = findElements(dom.container, n => n.tagName === 'FORM')[0];
      const connectBtn = findButtonByText(dom.container, 'Connect Store');
      assert.ok(form && connectBtn);

      await act(async () => {
        shopInput.value = 'https://Solstice-Test.myshopify.com/admin';
        getReactProps(shopInput).onChange?.({ target: shopInput });
      });

      await act(async () => {
        getReactProps(form).onSubmit?.({ preventDefault: () => {} });
      });

      assert.deepEqual(connectCalls, ['solstice-test.myshopify.com']);
      assert.equal(isElementDisabled(connectBtn), true, 'Connect button should be disabled while OAuth URL is fetched');
      assert.match(dom.container.textContent, /Connecting/);

      // Duplicate submit while in flight must be blocked
      await act(async () => {
        getReactProps(form).onSubmit?.({ preventDefault: () => {} });
      });
      assert.equal(connectCalls.length, 1);

      const expectedAuthUrl =
        'https://solstice-test.myshopify.com/admin/oauth/authorize?client_id=cid_1&scope=read_products&state=st_abc';

      await act(async () => {
        connectDeferred.resolve({
          success: true,
          authUrl: expectedAuthUrl,
          state: 'st_abc',
          shopDomain: 'solstice-test.myshopify.com',
        });
      });

      assert.equal(dom.locationStub.href, expectedAuthUrl, 'Browser must redirect to returned Shopify HTTPS authUrl');
      assert.doesNotMatch(dom.locationStub.href, /\/api\/shopify\/connect/, 'Must never navigate browser directly to /api/shopify/connect JSON endpoint');
      assert.match(dom.container.textContent, /Read-only Shopify catalog synchronization/);

      await act(async () => {
        root.unmount();
      });
    });

    test('rejects invalid shop domain client-side and handles API error or missing authUrl without redirecting while preserving input', async () => {
      const dom = createUiTestDom();
      (globalThis as any).window = dom.win;
      (globalThis as any).document = dom.doc;

      let connectCalls = 0;
      apiClient.getShopifyStatus = async () => ({
        connected: false,
        status: 'not_connected',
        shopDomain: null,
        grantedScopes: [],
        installedAt: null,
        lastVerifiedAt: null,
      });
      apiClient.getShopifySyncRuns = async () => ({ success: true, syncRuns: [] });
      apiClient.connectShopify = async () => {
        connectCalls += 1;
        throw new Error('Only workspace owners or admins can connect Shopify stores.');
      };

      const { root, renderPromise } = renderSettings(dom, { initialTab: 'connectors' });
      await renderPromise;

      const shopInput = findElements(dom.container, n => n.tagName === 'INPUT').find(i =>
        String(i.getAttribute('placeholder') || '').includes('myshopify.com')
      );
      const form = findElements(dom.container, n => n.tagName === 'FORM')[0];
      assert.ok(shopInput && form);

      // 1. Invalid domain -> rejected client-side without API call or redirect
      await act(async () => {
        shopInput.value = 'not-shopify.example.com';
        getReactProps(shopInput).onChange?.({ target: shopInput });
      });
      await act(async () => {
        getReactProps(form).onSubmit?.({ preventDefault: () => {} });
      });

      assert.equal(connectCalls, 0);
      assert.equal(dom.locationStub.href, 'http://localhost:3000/');
      assert.match(dom.container.textContent, /valid Shopify store domain/i);

      // 2. Valid domain, API fails -> error displayed, no redirect, input preserved for retry
      await act(async () => {
        shopInput.value = 'solstice-retry.myshopify.com';
        getReactProps(shopInput).onChange?.({ target: shopInput });
      });
      await act(async () => {
        getReactProps(form).onSubmit?.({ preventDefault: () => {} });
      });

      assert.equal(connectCalls, 1);
      assert.equal(dom.locationStub.href, 'http://localhost:3000/');
      assert.match(dom.container.textContent, /Only workspace owners or admins can connect Shopify stores/);
      assert.equal(shopInput.value, 'solstice-retry.myshopify.com', 'Entered shop domain must be preserved for retry');

      // 3. Server returns invalid/malicious authUrl -> rejected safely without redirect
      apiClient.connectShopify = async () =>
        ({
          success: true,
          authUrl: 'https://evil.example.com/steal',
          state: 'st_x',
          shopDomain: 'solstice-retry.myshopify.com',
        } as ShopifyConnectResponse);

      await act(async () => {
        getReactProps(form).onSubmit?.({ preventDefault: () => {} });
      });

      assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Untrusted authUrl must never trigger redirect');
      assert.match(dom.container.textContent, /invalid Shopify authorization URL/i);

      await act(async () => {
        root.unmount();
      });
    });
  });
});
