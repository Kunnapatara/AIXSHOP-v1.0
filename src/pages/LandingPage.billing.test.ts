import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { LandingPage } from './LandingPage';
import { AuthContext, AuthProvider, useAuth } from '../context/AuthContext';
import { AppContext, AppContextType } from '../context/AppContext';
import { apiClient, BillingPlansResponse, CheckoutSessionResponse } from '../api/client';
import { initialProducts, initialStoreProfile, initialFindings, initialActionItems } from '../data/mockData';
import { evaluateDemoOverwriteProtection } from '../domain/catalog/demoMigrationProtection';

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
    href: 'http://localhost:3000/',
    origin: 'http://localhost:3000',
    pathname: '/',
    search: '',
  };

  const win: any = {
    document: doc,
    location: locationStub,
    history: {
      replaceState: () => {},
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

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const AUTHORITATIVE_PLAN_FIXTURE: BillingPlansResponse = {
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
      features: ['Up to 250 verified SKUs', 'Essential schema & GTIN validation'],
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

describe('Task C2: LandingPage Stripe Billing Integration', () => {
  let prevWindow: any;
  let prevDocument: any;
  let prevActEnv: any;
  let origGetPlans: typeof apiClient.getBillingPlans;
  let origCreateCheckout: typeof apiClient.createCheckoutSession;

  beforeEach(() => {
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    origGetPlans = apiClient.getBillingPlans;
    origCreateCheckout = apiClient.createCheckoutSession;
  });

  afterEach(() => {
    apiClient.getBillingPlans = origGetPlans;
    apiClient.createCheckoutSession = origCreateCheckout;
    (globalThis as any).window = prevWindow;
    (globalThis as any).document = prevDocument;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  });

  test('loads authoritative plans from backend, displays SKU capacities, and handles authenticated checkout redirect', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    let getPlansCalls = 0;
    const checkoutRequests: any[] = [];
    const navigations: string[] = [];

    apiClient.getBillingPlans = async () => {
      getPlansCalls += 1;
      return AUTHORITATIVE_PLAN_FIXTURE;
    };
    apiClient.createCheckoutSession = async params => {
      checkoutRequests.push(params);
      return {
        success: true,
        sessionId: 'cs_live_test_1',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_live_test_1',
        provider: 'stripe',
      };
    };

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', email: 'owner@store.com', fullName: 'Owner' },
              activeWorkspace: { id: 'ws1', name: 'Store', slug: 'store', role: 'owner' },
              workspaces: [{ id: 'ws1', name: 'Store', slug: 'store', role: 'owner' }],
              isAuthenticated: true,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: true }),
              register: async () => ({ success: true }),
              logout: async () => {},
              switchWorkspace: async () => true,
            },
          },
          React.createElement(
            AppContext.Provider,
            {
              value: buildMockAppContext({
                navigateTo: page => navigations.push(page),
              }),
            },
            React.createElement(LandingPage)
          )
        )
      );
    });

    assert.equal(getPlansCalls, 1);
    const text = dom.container.textContent;
    assert.match(text, /Starter Plan/);
    assert.match(text, /\$49/);
    assert.match(text, /Growth Plan/);
    assert.match(text, /\$149/);
    assert.match(text, /Enterprise Plan/);
    assert.match(text, /\$499/);
    assert.match(text, /Unlimited SKUs/);

    const growthBtn = findButtonByText(dom.container, 'Select Growth Plan');
    assert.ok(growthBtn, 'Growth plan CTA button should be rendered');

    await act(async () => {
      getReactProps(growthBtn).onClick?.();
    });

    assert.equal(checkoutRequests.length, 1);
    assert.equal(checkoutRequests[0].tier, 'Growth');
    assert.equal(dom.locationStub.href, 'https://checkout.stripe.com/c/pay/cs_live_test_1');
    assert.equal(navigations.length, 0, 'Selecting paid plan must NOT navigate to workspace/settings instead of checkout');

    await act(async () => {
      root.unmount();
    });
  });

  test('displays error and prevents redirect when checkout fails or returns invalid checkoutUrl', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    apiClient.getBillingPlans = async () => AUTHORITATIVE_PLAN_FIXTURE;
    apiClient.createCheckoutSession = async () => {
      throw new Error('Stripe price ID for Growth is not configured.');
    };

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', email: 'owner@store.com', fullName: 'Owner' },
              activeWorkspace: { id: 'ws1', name: 'Store', slug: 'store', role: 'owner' },
              workspaces: [],
              isAuthenticated: true,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: true }),
              register: async () => ({ success: true }),
              logout: async () => {},
              switchWorkspace: async () => true,
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

    const starterBtn = findButtonByText(dom.container, 'Select Starter Plan');
    await act(async () => {
      getReactProps(starterBtn).onClick?.();
    });

    assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Failed checkout must not redirect');
    assert.match(dom.container.textContent, /Stripe price ID for Growth is not configured/);

    // Now return malformed empty/invalid URL object directly (simulating corrupted client/network return)
    apiClient.createCheckoutSession = async () =>
      ({ success: true, sessionId: 'cs_bad', checkoutUrl: 'javascript:alert(1)', provider: 'stripe' } as any);

    await act(async () => {
      getReactProps(starterBtn).onClick?.();
    });

    assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Unsafe URL must never trigger browser redirect');
    assert.match(dom.container.textContent, /missing a valid checkout URL/i);

    await act(async () => {
      root.unmount();
    });
  });

  test('disables plan buttons during in-flight checkout to prevent duplicate requests', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    const deferred = createDeferred<CheckoutSessionResponse>();
    let checkoutCalls = 0;

    apiClient.getBillingPlans = async () => AUTHORITATIVE_PLAN_FIXTURE;
    apiClient.createCheckoutSession = async () => {
      checkoutCalls += 1;
      return deferred.promise;
    };

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', email: 'owner@store.com', fullName: 'Owner' },
              activeWorkspace: { id: 'ws1', name: 'Store', slug: 'store', role: 'owner' },
              workspaces: [],
              isAuthenticated: true,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: true }),
              register: async () => ({ success: true }),
              logout: async () => {},
              switchWorkspace: async () => true,
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

    const growthBtn = findButtonByText(dom.container, 'Select Growth Plan');
    await act(async () => {
      getReactProps(growthBtn).onClick?.();
    });

    assert.equal(isElementDisabled(growthBtn), true, 'Button should be disabled while checkout is loading');
    assert.match(dom.container.textContent, /Starting Checkout/);

    // Attempt duplicate click while in-flight
    await act(async () => {
      getReactProps(growthBtn).onClick?.();
    });
    assert.equal(checkoutCalls, 1, 'Duplicate clicks must not issue multiple checkout sessions');

    await act(async () => {
      deferred.resolve({
        success: true,
        sessionId: 'cs_done',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_done',
        provider: 'stripe',
      });
    });

    assert.equal(dom.locationStub.href, 'https://checkout.stripe.com/c/pay/cs_done');

    await act(async () => {
      root.unmount();
    });
  });

  test('unauthenticated user opens auth modal on plan click and resumes selected checkout immediately after auth', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    apiClient.getBillingPlans = async () => AUTHORITATIVE_PLAN_FIXTURE;
    const checkoutCalls: string[] = [];
    apiClient.createCheckoutSession = async params => {
      checkoutCalls.push(params.tier);
      return {
        success: true,
        sessionId: 'cs_resumed_1',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_resumed_1',
        provider: 'stripe',
      };
    };

    const modalCalls: string[] = [];
    let triggerAuthSuccess!: () => void;

    const Harness: React.FC = () => {
      const [authed, setAuthed] = useState(false);
      const [modalOpen, setModalOpen] = useState(false);
      triggerAuthSuccess = () => {
        setAuthed(true);
        setModalOpen(false);
      };
      return React.createElement(
        AuthContext.Provider,
        {
          value: {
            user: authed ? { id: 'u1', email: 'u@example.com', fullName: 'U' } : null,
            activeWorkspace: authed ? { id: 'ws1', name: 'WS', slug: 'ws', role: 'owner' } : null,
            workspaces: [],
            isAuthenticated: authed,
            isLoading: false,
            authModalOpen: modalOpen,
            authModalMode: 'register',
            openAuthModal: (mode = 'login') => {
              modalCalls.push(mode);
              setModalOpen(true);
            },
            closeAuthModal: () => setModalOpen(false),
            login: async () => ({ success: true }),
            register: async () => ({ success: true }),
            logout: async () => {},
            switchWorkspace: async () => true,
          },
        },
        React.createElement(
          AppContext.Provider,
          { value: buildMockAppContext() },
          React.createElement(LandingPage)
        )
      );
    };

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    const enterpriseBtn = findButtonByText(dom.container, 'Select Enterprise Plan');
    await act(async () => {
      getReactProps(enterpriseBtn).onClick?.();
    });

    assert.deepEqual(modalCalls, ['register']);
    assert.deepEqual(checkoutCalls, [], 'Must NOT call checkout while unauthenticated');
    assert.equal(dom.locationStub.href, 'http://localhost:3000/');

    await act(async () => {
      triggerAuthSuccess();
    });

    assert.deepEqual(checkoutCalls, ['Enterprise'], 'Must automatically resume intended Enterprise plan checkout after auth');
    assert.equal(dom.locationStub.href, 'https://checkout.stripe.com/c/pay/cs_resumed_1');

    await act(async () => {
      root.unmount();
    });
  });

  test('preserves existing Enter Merchant App navigation on header CTA', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;
    apiClient.getBillingPlans = async () => AUTHORITATIVE_PLAN_FIXTURE;

    const navigatedTo: string[] = [];
    const root: Root = createRoot(dom.container);
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
            {
              value: buildMockAppContext({
                navigateTo: page => navigatedTo.push(page),
              }),
            },
            React.createElement(LandingPage)
          )
        )
      );
    });

    const enterAppBtn = findButtonByText(dom.container, 'Enter Merchant App');
    assert.ok(enterAppBtn);
    await act(async () => {
      getReactProps(enterAppBtn).onClick?.();
    });
    assert.deepEqual(navigatedTo, ['home']);

    await act(async () => {
      root.unmount();
    });
  });

  test('fails closed when billing plans fail to load, disables paid checkout, preserves Free Audit, and recovers on Retry', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    let getPlansAttempts = 0;
    let checkoutCalls = 0;
    const storeCheckUrls: string[] = [];
    const navigations: string[] = [];
    const deferredLoad = createDeferred<BillingPlansResponse>();

    apiClient.getBillingPlans = async () => {
      getPlansAttempts += 1;
      if (getPlansAttempts === 1) {
        return deferredLoad.promise;
      }
      if (getPlansAttempts === 2) {
        return AUTHORITATIVE_PLAN_FIXTURE;
      }
      throw new Error('Billing service temporarily unavailable');
    };
    apiClient.createCheckoutSession = async params => {
      checkoutCalls += 1;
      return {
        success: true,
        sessionId: 'cs_retry_ok',
        checkoutUrl: `https://checkout.stripe.com/c/pay/cs_${params.tier.toLowerCase()}`,
        provider: 'stripe',
      };
    };

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', email: 'owner@store.com', fullName: 'Owner' },
              activeWorkspace: { id: 'ws1', name: 'Store', slug: 'store', role: 'owner' },
              workspaces: [],
              isAuthenticated: true,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: true }),
              register: async () => ({ success: true }),
              logout: async () => {},
              switchWorkspace: async () => true,
            },
          },
          React.createElement(
            AppContext.Provider,
            {
              value: buildMockAppContext({
                navigateTo: page => navigations.push(page),
                runStoreCheck: async url => {
                  storeCheckUrls.push(url);
                },
              }),
            },
            React.createElement(LandingPage)
          )
        )
      );
    });

    // 1. While initial getBillingPlans() is still in flight -> ALL paid plan buttons MUST be disabled
    for (const label of ['Select Starter Plan', 'Select Growth Plan', 'Select Enterprise Plan']) {
      const btn = findButtonByText(dom.container, label);
      assert.ok(btn, `Button ${label} should exist`);
      assert.equal(isElementDisabled(btn), true, `${label} must be disabled while plans are loading`);
      await act(async () => {
        getReactProps(btn).onClick?.();
      });
    }
    assert.equal(checkoutCalls, 0, 'Must NOT allow checkout while plans are loading');

    // 2. Reject initial plans load -> ALL paid plan buttons MUST remain disabled, error + Retry rendered, Free Audit still works
    await act(async () => {
      deferredLoad.reject(new Error('503 Billing Plans API Offline'));
    });

    assert.match(dom.container.textContent, /503 Billing Plans API Offline/);
    assert.match(dom.container.textContent, /Paid checkout is temporarily disabled/);
    assert.match(dom.container.textContent, /Unverified preview/);

    for (const label of ['Select Starter Plan', 'Select Growth Plan', 'Select Enterprise Plan']) {
      const btn = findButtonByText(dom.container, label);
      assert.ok(btn);
      assert.equal(isElementDisabled(btn), true, `${label} must stay disabled when plans fail to load`);
      await act(async () => {
        getReactProps(btn).onClick?.();
      });
    }
    assert.equal(checkoutCalls, 0, 'Fallback pricing must NEVER initiate paid checkout on failure');
    assert.equal(dom.locationStub.href, 'http://localhost:3000/');

    // Free Audit behavior (Store Check + Enter Merchant App) MUST remain usable
    const inspectBtn = findButtonByText(dom.container, 'Inspect Catalog');
    assert.ok(inspectBtn);
    assert.equal(isElementDisabled(inspectBtn), false, 'Free Audit Store Check must stay enabled when plans fail');
    const storeForm = findElements(dom.container, n => n.tagName === 'FORM')[0];
    await act(async () => {
      getReactProps(storeForm).onSubmit?.({ preventDefault: () => {} });
    });
    assert.equal(storeCheckUrls.length, 1, 'Free Store Check must execute normally');

    const enterAppBtn = findButtonByText(dom.container, 'Enter Merchant App');
    assert.ok(enterAppBtn);
    assert.equal(isElementDisabled(enterAppBtn), false);
    await act(async () => {
      getReactProps(enterAppBtn).onClick?.();
    });
    assert.deepEqual(navigations, ['home']);

    // 3. Click Retry -> succeeds and enables paid Checkout
    const retryBtn = findButtonByText(dom.container, 'Retry');
    assert.ok(retryBtn, 'Retry button must render on plans error');
    await act(async () => {
      getReactProps(retryBtn).onClick?.();
    });

    assert.equal(getPlansAttempts, 2);
    const growthBtnAfterRetry = findButtonByText(dom.container, 'Select Growth Plan');
    assert.ok(growthBtnAfterRetry);
    assert.equal(isElementDisabled(growthBtnAfterRetry), false, 'Checkout must re-enable once authoritative plans load on retry');

    await act(async () => {
      getReactProps(growthBtnAfterRetry).onClick?.();
    });
    assert.equal(checkoutCalls, 1);
    assert.equal(dom.locationStub.href, 'https://checkout.stripe.com/c/pay/cs_growth');

    await act(async () => {
      root.unmount();
    });
  });

  test('rejects arbitrary external HTTPS and HTTP-in-production redirect URLs in LandingPage without redirecting', async () => {
    const dom = createUiTestDom();
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    apiClient.getBillingPlans = async () => AUTHORITATIVE_PLAN_FIXTURE;
    apiClient.createCheckoutSession = async () => ({
      success: true,
      sessionId: 'cs_evil',
      checkoutUrl: 'https://evil.example.com/c/pay/cs_evil',
      provider: 'stripe',
    });

    const root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', email: 'owner@store.com', fullName: 'Owner' },
              activeWorkspace: { id: 'ws1', name: 'Store', slug: 'store', role: 'owner' },
              workspaces: [],
              isAuthenticated: true,
              isLoading: false,
              authModalOpen: false,
              authModalMode: 'login',
              openAuthModal: () => {},
              closeAuthModal: () => {},
              login: async () => ({ success: true }),
              register: async () => ({ success: true }),
              logout: async () => {},
              switchWorkspace: async () => true,
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

    const starterBtn = findButtonByText(dom.container, 'Select Starter Plan');
    await act(async () => {
      getReactProps(starterBtn).onClick?.();
    });
    assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'Arbitrary external HTTPS host must not redirect');
    assert.match(dom.container.textContent, /missing a valid checkout URL/i);

    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      apiClient.createCheckoutSession = async () => ({
        success: true,
        sessionId: 'cs_http_prod',
        checkoutUrl: 'http://checkout.stripe.com/c/pay/cs_http_prod',
        provider: 'stripe',
      });
      await act(async () => {
        getReactProps(starterBtn).onClick?.();
      });
      assert.equal(dom.locationStub.href, 'http://localhost:3000/', 'HTTP URL in production must not redirect');
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }

    await act(async () => {
      root.unmount();
    });
  });

  test('AuthProvider extracts #reset_token from URL fragment and immediately strips it via history.replaceState', async () => {
    const dom = createUiTestDom();
    const replacedUrls: string[] = [];
    dom.locationStub.href = 'http://localhost:3000/#reset_token=raw_secret_fragment_token_123';
    (dom.locationStub as any).hash = '#reset_token=raw_secret_fragment_token_123';
    dom.win.history.replaceState = (_state: any, _title: string, nextUrl: string) => {
      replacedUrls.push(nextUrl);
      (dom.locationStub as any).hash = '';
      dom.locationStub.href = `http://localhost:3000${nextUrl}`;
    };
    (globalThis as any).window = dom.win;
    (globalThis as any).document = dom.doc;

    const origGetSession = apiClient.getSession;
    apiClient.getSession = async () => null;

    let observedToken: string | null | undefined = null;
    let observedMode = '';
    let observedOpen = false;
    const Probe: React.FC = () => {
      const auth = useAuth();
      observedToken = auth.pendingResetToken;
      observedMode = auth.authModalMode;
      observedOpen = auth.authModalOpen;
      return null;
    };

    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        root.render(React.createElement(AuthProvider, null, React.createElement(Probe)));
      });
      assert.equal(observedToken, 'raw_secret_fragment_token_123');
      assert.equal(observedMode, 'reset');
      assert.equal(observedOpen, true);
      assert.deepEqual(replacedUrls, ['/']);
      assert.equal((dom.locationStub as any).hash, '');
    } finally {
      apiClient.getSession = origGetSession;
      await act(async () => {
        root.unmount();
      });
    }
  });
});
