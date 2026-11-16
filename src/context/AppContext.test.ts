import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AuthContext } from './AuthContext';
import { AppProvider, useApp, AppContextType } from './AppContext';
import { apiClient, AuthUser, WorkspaceSummary } from '../api/client';
import { CatalogStorageAdapter, MemoryStorageBackend } from '../domain/storage/storageAdapter';
import { initialProducts, initialStoreProfile, initialFindings, initialActionItems } from '../data/mockData';
import type { Product, Finding, ActionItem, StoreProfile } from '../types';
import type { StoragePayloadV1 } from '../domain/storage/storageTypes';

// Minimal DOM host for React 19 createRoot in Node.js without external jsdom dependency
interface MinimalNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  ownerDocument: any;
  parentNode: MinimalNode | null;
  childNodes: MinimalNode[];
  children: MinimalNode[];
  nextSibling: MinimalNode | null;
  previousSibling: MinimalNode | null;
  nodeValue?: string;
  style?: Record<string, string>;
  attributes?: Record<string, string>;
  firstChild: MinimalNode | null;
  lastChild: MinimalNode | null;
  textContent: string;
  innerHTML: string;
  appendChild: (child: MinimalNode) => MinimalNode;
  insertBefore: (child: MinimalNode, refChild: MinimalNode | null) => MinimalNode;
  removeChild: (child: MinimalNode) => MinimalNode;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
}

function createMinimalDom() {
  const doc: any = {
    nodeType: 9,
    nodeName: '#document',
    ownerDocument: null,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  doc.ownerDocument = doc;

  function linkSiblings(nodes: MinimalNode[]) {
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].previousSibling = i > 0 ? nodes[i - 1] : null;
      nodes[i].nextSibling = i < nodes.length - 1 ? nodes[i + 1] : null;
    }
  }

  function makeElement(tagName: string): MinimalNode {
    const childNodes: MinimalNode[] = [];
    const attrs: Record<string, string> = {};
    let _text = '';
    const el: MinimalNode = {
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
      appendChild(child: MinimalNode) {
        return el.insertBefore(child, null);
      },
      insertBefore(child: MinimalNode, refChild: MinimalNode | null) {
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
      removeChild(child: MinimalNode) {
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
      },
      getAttribute(k: string) {
        return k in attrs ? attrs[k] : null;
      },
      removeAttribute(k: string) {
        delete attrs[k];
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    return el;
  }

  function makeTextOrComment(nodeType: number, text: string): MinimalNode {
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
      appendChild(c) {
        return c;
      },
      insertBefore(c) {
        return c;
      },
      removeChild(c) {
        return c;
      },
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

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makeProduct(id: string, title: string): Product {
  return {
    id,
    title,
    brand: 'TestBrand',
    category: 'Apparel',
    description: `${title} description`,
    image: '',
    status: 'active',
    completenessScore: 95,
    evidenceCoverageScore: 90,
    externalDiscoveryStatus: 'observed_in_sample',
    lastAudited: '2026-10-11T04:15:00Z',
    findingsCount: 0,
    attributes: {},
    variants: [],
    offers: [],
    evidenceDocuments: [],
  };
}

function makeFinding(id: string, productId: string, summary: string): Finding {
  return {
    id,
    scope: 'product',
    productId,
    productTitle: `Product ${productId}`,
    type: 'missing_information',
    severity: 'high',
    title: summary,
    description: summary,
    observedEvidence: 'Observed test evidence',
    derivedConclusion: 'Derived test conclusion',
    merchantVerified: false,
    whyItMatters: 'Test matter',
    suggestedCorrection: 'Fix GTIN',
  };
}

function makeAction(id: string, productId: string, title: string): ActionItem {
  return {
    id,
    findingId: `finding_${id}`,
    productId,
    productTitle: `Product ${productId}`,
    title,
    severity: 'high',
    status: 'pending_review',
    evidenceRequired: false,
    proposedChange: {
      field: 'variants[0].barcode',
      from: '(empty)',
      to: '0123456789012',
    },
    verificationStatus: 'unverified',
  };
}

function makeCatalogPayload(opts: {
  storeName: string;
  products: Product[];
  findings?: Finding[];
  actions?: ActionItem[];
  catalogVersion: number;
}): StoragePayloadV1 {
  const storeProfile: StoreProfile = {
    name: opts.storeName,
    domain: `${opts.storeName.toLowerCase().replace(/\s+/g, '-')}.myshopify.com`,
    currency: 'USD',
    skuCount: opts.products.length,
    skuLimit: 2500,
    catalogCompletenessAvg: 92,
    truthBoundaryStrictness: 'standard',
    tier: 'Pro',
    connectors: [],
  };
  return {
    products: opts.products,
    variants: [],
    offers: [],
    findings: opts.findings ?? [],
    actions: opts.actions ?? [],
    evidence: [],
    storeProfile,
    catalogVersion: opts.catalogVersion,
  };
}

interface AuthHarnessValue {
  user: AuthUser | null;
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  isAuthenticated: boolean;
}

function buildAuthContextValue(v: AuthHarnessValue) {
  return {
    user: v.user,
    activeWorkspace: v.activeWorkspace,
    workspaces: v.workspaces,
    isAuthenticated: v.isAuthenticated,
    isLoading: false,
    authModalOpen: false,
    authModalMode: 'login' as const,
    openAuthModal: () => {},
    closeAuthModal: () => {},
    login: async () => ({ success: true }),
    register: async () => ({ success: true }),
    logout: async () => {},
    switchWorkspace: async () => true,
  };
}

interface RenderSnapshot {
  workspaceIdSeen: string | null;
  isCloudWorkspace: boolean;
  cloudCatalogStatus: string;
  loadedWorkspaceId: string | null | undefined;
  productIds: string[];
  findingIds: string[];
  actionIds: string[];
  storeName: string;
  catalogVersion: number | undefined;
  cloudCatalogError: string | null | undefined;
}

describe('AppContext Workspace & Auth State Isolation (Failure & Race Injection)', () => {
  let origWindow: any;
  let origDocument: any;
  let origActEnv: any;
  let origGetCatalog: typeof apiClient.getCatalog;
  let origRunAudit: typeof apiClient.runAudit;
  let origApproveAction: typeof apiClient.approveAction;
  let root: Root | null = null;

  beforeEach(() => {
    origWindow = (globalThis as any).window;
    origDocument = (globalThis as any).document;
    origActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    origGetCatalog = apiClient.getCatalog.bind(apiClient);
    origRunAudit = apiClient.runAudit.bind(apiClient);
    origApproveAction = apiClient.approveAction.bind(apiClient);

    const dom = createMinimalDom();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).document = dom.doc;
    (globalThis as any).window = dom.win;
    root = createRoot(dom.container as unknown as Element);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    apiClient.getCatalog = origGetCatalog;
    apiClient.runAudit = origRunAudit;
    apiClient.approveAction = origApproveAction;
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
    if (origDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = origDocument;
    if (origActEnv === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = origActEnv;
  });

  function createTestRig(customStorage?: CatalogStorageAdapter) {
    let latestApp!: AppContextType;
    const renderSnapshots: RenderSnapshot[] = [];
    const storageAdapter =
      customStorage || new CatalogStorageAdapter(new MemoryStorageBackend());

    const Consumer: React.FC<{ expectedWsId: string | null }> = ({ expectedWsId }) => {
      const app = useApp();
      latestApp = app;
      renderSnapshots.push({
        workspaceIdSeen: expectedWsId,
        isCloudWorkspace: app.isCloudWorkspace,
        cloudCatalogStatus: app.cloudCatalogStatus,
        loadedWorkspaceId: app.loadedWorkspaceId,
        productIds: app.products.map(p => p.id),
        findingIds: app.findings.map(f => f.id),
        actionIds: app.actionItems.map(a => a.id),
        storeName: app.storeProfile.name,
        catalogVersion: app.catalogVersion,
        cloudCatalogError: app.cloudCatalogError,
      });
      return React.createElement('div', null, app.loadedWorkspaceId || app.cloudCatalogStatus);
    };

    const renderWithAuth = async (auth: AuthHarnessValue) => {
      await act(async () => {
        const consumerEl = React.createElement(Consumer, {
          expectedWsId: auth.activeWorkspace?.id ?? null,
        });
        const appEl = React.createElement(AppProvider, {
          customStorageAdapter: storageAdapter,
          children: consumerEl,
        });
        root!.render(
          React.createElement(
            AuthContext.Provider,
            { value: buildAuthContextValue(auth) },
            appEl
          )
        );
      });
    };

    return {
      getApp: () => latestApp,
      renderSnapshots,
      renderWithAuth,
      storageAdapter,
    };
  }

  const userA: AuthUser = { id: 'user_a', email: 'a@example.com', fullName: 'User A' };
  const userB: AuthUser = { id: 'user_b', email: 'b@example.com', fullName: 'User B' };
  const wsA: WorkspaceSummary = { id: 'ws_a', name: 'Workspace A', slug: 'ws-a', role: 'owner' };
  const wsB: WorkspaceSummary = { id: 'ws_b', name: 'Workspace B', slug: 'ws-b', role: 'owner' };
  const wsC: WorkspaceSummary = { id: 'ws_c', name: 'Workspace C', slug: 'ws-c', role: 'owner' };
  const wsD: WorkspaceSummary = { id: 'ws_d', name: 'Workspace D', slug: 'ws-d', role: 'owner' };

  test('1. Workspace A -> Workspace B: immediately clears A state on transition and displays only B data', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defB = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      return callIdx === 1 ? defA.promise : defB.promise;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });

    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Store Alpha',
          products: [makeProduct('prod_a1', 'Alpha Product')],
          findings: [makeFinding('find_a1', 'prod_a1', 'Alpha finding')],
          actions: [makeAction('act_a1', 'prod_a1', 'Alpha action')],
          catalogVersion: 11,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_a');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_a1']);
    assert.equal(rig.getApp().storeProfile.name, 'Store Alpha');
    assert.equal(rig.getApp().catalogVersion, 11);

    // Switch to Workspace B while B's request is still pending
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });

    // Every render snapshot for ws_b must NEVER expose prod_a1, find_a1, act_a1, or Store Alpha
    const wsBSnapshotsBeforeResolve = rig.renderSnapshots.filter(s => s.workspaceIdSeen === 'ws_b');
    assert.ok(wsBSnapshotsBeforeResolve.length > 0);
    for (const snap of wsBSnapshotsBeforeResolve) {
      assert.deepEqual(snap.productIds, [], 'Workspace A products must never leak into Workspace B renders');
      assert.deepEqual(snap.findingIds, []);
      assert.deepEqual(snap.actionIds, []);
      assert.notEqual(snap.storeName, 'Store Alpha');
      assert.notEqual(snap.loadedWorkspaceId, 'ws_a');
      assert.equal(snap.cloudCatalogStatus, 'loading');
    }

    await act(async () => {
      defB.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({
          storeName: 'Store Beta',
          products: [makeProduct('prod_b1', 'Beta Product')],
          findings: [makeFinding('find_b1', 'prod_b1', 'Beta finding')],
          actions: [makeAction('act_b1', 'prod_b1', 'Beta action')],
          catalogVersion: 3,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.equal(rig.getApp().cloudCatalogStatus, 'loaded');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_b1']);
    assert.deepEqual(rig.getApp().findings.map(f => f.id), ['find_b1']);
    assert.deepEqual(rig.getApp().actionItems.map(a => a.id), ['act_b1']);
    assert.equal(rig.getApp().storeProfile.name, 'Store Beta');
    assert.equal(rig.getApp().catalogVersion, 3);
  });

  test('2. Workspace switch while loading (reverse-order completion): stale A response is ignored after B resolves first', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defB = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      return callIdx === 1 ? defA.promise : defB.promise;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });
    assert.equal(rig.getApp().cloudCatalogStatus, 'loading');

    // Switch to ws_b BEFORE ws_a resolves
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });

    // Resolve ws_b FIRST
    await act(async () => {
      defB.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({
          storeName: 'Fresh Beta Store',
          products: [makeProduct('prod_b_fresh', 'Fresh Beta Product')],
          catalogVersion: 5,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_b_fresh']);

    // Now resolve stale ws_a SECOND
    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Stale Alpha Store',
          products: [makeProduct('prod_a_stale', 'Stale Alpha Product')],
          catalogVersion: 99,
        }),
      });
      await flushMicrotasks();
    });

    // State must remain strictly ws_b
    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.equal(rig.getApp().cloudCatalogStatus, 'loaded');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_b_fresh']);
    assert.equal(rig.getApp().storeProfile.name, 'Fresh Beta Store');
    assert.equal(rig.getApp().catalogVersion, 5);
  });

  test('3. Workspace B load failure & mismatched workspace response: never retains A data and exposes error state', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defB = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defC = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      if (callIdx === 1) return defA.promise;
      if (callIdx === 2) return defB.promise;
      return defC.promise;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB, wsC], isAuthenticated: true });

    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Store Alpha',
          products: [makeProduct('prod_a_secret', 'Alpha Secret')],
          findings: [makeFinding('find_a_secret', 'prod_a_secret', 'Secret finding')],
          actions: [makeAction('act_a_secret', 'prod_a_secret', 'Secret action')],
          catalogVersion: 4,
        }),
      });
      await flushMicrotasks();
    });
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_a_secret']);

    // Switch to Workspace B and fail
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB, wsC], isAuthenticated: true });
    await act(async () => {
      defB.reject(new Error('503 Upstream catalog unavailable'));
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'error');
    assert.equal(rig.getApp().cloudCatalogError, '503 Upstream catalog unavailable');
    assert.equal(rig.getApp().loadedWorkspaceId, null);
    assert.deepEqual(rig.getApp().products, []);
    assert.deepEqual(rig.getApp().findings, []);
    assert.deepEqual(rig.getApp().actionItems, []);
    assert.equal(rig.getApp().catalogVersion, undefined);

    // Switch to Workspace C and simulate server returning wrong workspaceId ('ws_a')
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsC, workspaces: [wsA, wsB, wsC], isAuthenticated: true });
    await act(async () => {
      defC.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Wrong Alpha Store',
          products: [makeProduct('prod_a_secret', 'Alpha Secret')],
          catalogVersion: 4,
        }),
      });
      await flushMicrotasks();
    });

    assert.deepEqual(rig.getApp().products, []);
    assert.notEqual(rig.getApp().loadedWorkspaceId, 'ws_a');
    assert.notEqual(rig.getApp().storeProfile.name, 'Wrong Alpha Store');
  });

  test('4. Logout after cloud workspace usage: clears cloud state immediately and safely rehydrates local demo state even after prior init', async () => {
    const storageAdapter = new CatalogStorageAdapter(new MemoryStorageBackend());
    const customDemoProd = makeProduct('prod_local_demo', 'Local Demo Ceramic Mug');
    storageAdapter.save({
      products: [customDemoProd],
      variants: [],
      offers: [],
      findings: [],
      actions: [],
      evidence: [],
      storeProfile: { ...initialStoreProfile, name: 'Local Demo Mercantile' },
    });

    apiClient.getCatalog = async () => ({
      workspaceId: 'ws_a',
      catalog: makeCatalogPayload({
        storeName: 'Cloud Tenant Alpha',
        products: [makeProduct('prod_cloud_confidential', 'Confidential Cloud Product')],
        findings: [makeFinding('find_cloud_1', 'prod_cloud_confidential', 'Cloud finding')],
        actions: [makeAction('act_cloud_1', 'prod_cloud_confidential', 'Cloud action')],
        catalogVersion: 77,
      }),
    });

    // Start unauthenticated (sets isInitializedRef = true in real user journey: demo -> login -> logout)
    const rig = createTestRig(storageAdapter);
    await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_local_demo']);

    // Log into cloud workspace
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA], isAuthenticated: true });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_a');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_cloud_confidential']);

    // Logout back to demo mode
    await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });
    await act(async () => {
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().isCloudWorkspace, false);
    assert.equal(rig.getApp().cloudCatalogStatus, 'idle');
    assert.equal(rig.getApp().loadedWorkspaceId, null);
    assert.equal(rig.getApp().catalogVersion, undefined);
    assert.equal(rig.getApp().storeProfile.name, 'Local Demo Mercantile');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_local_demo']);

    // Check synchronous transition snapshots after logout never leaked prod_cloud_confidential
    const logoutSnapshots = rig.renderSnapshots.filter(
      (s, i) => i > 0 && !s.isCloudWorkspace && rig.renderSnapshots[i - 1]?.loadedWorkspaceId === 'ws_a'
    );
    for (const snap of logoutSnapshots) {
      assert.ok(!snap.productIds.includes('prod_cloud_confidential'));
    }

    // Also verify when local storage is empty on logout from cloud, initialProducts seed is restored safely
    storageAdapter.clear();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA], isAuthenticated: true });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_cloud_confidential']);

    await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.deepEqual(
      rig.getApp().products.map(p => p.id),
      initialProducts.map(p => p.id)
    );
    assert.ok(!rig.getApp().products.some(p => p.id === 'prod_cloud_confidential'));
  });

  test('5. Different account login: Account A -> Logout -> Account B completely isolates catalog and even same workspace IDs', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defB = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      return callIdx === 1 ? defA.promise : defB.promise;
    };

    const rig = createTestRig();
    // Account A logs in (use shared workspace id edge case too)
    const sharedWsId: WorkspaceSummary = { id: 'ws_shared', name: 'Shared Slug', slug: 'shared', role: 'owner' };
    await rig.renderWithAuth({ user: userA, activeWorkspace: sharedWsId, workspaces: [sharedWsId], isAuthenticated: true });

    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_shared',
        catalog: makeCatalogPayload({
          storeName: 'Account A Store',
          products: [makeProduct('prod_acct_a', 'Account A Private Product')],
          catalogVersion: 2,
        }),
      });
      await flushMicrotasks();
    });
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_acct_a']);

    // Account A logs out
    await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });

    // Account B logs in while Account B's catalog is loading
    await rig.renderWithAuth({ user: userB, activeWorkspace: sharedWsId, workspaces: [sharedWsId], isAuthenticated: true });
    assert.equal(rig.getApp().cloudCatalogStatus, 'loading');
    assert.ok(!rig.getApp().products.some(p => p.id === 'prod_acct_a'));

    await act(async () => {
      defB.resolve({
        workspaceId: 'ws_shared',
        catalog: makeCatalogPayload({
          storeName: 'Account B Store',
          products: [makeProduct('prod_acct_b', 'Account B Product')],
          catalogVersion: 9,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'loaded');
    assert.equal(rig.getApp().storeProfile.name, 'Account B Store');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_acct_b']);
    assert.ok(!rig.getApp().products.some(p => p.id === 'prod_acct_a'));
  });

  test('6. Late response after logout: in-flight cloud getCatalog & mutation responses cannot repopulate post-logout state', async () => {
    const defInFlightCatalog = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    apiClient.getCatalog = async () => defInFlightCatalog.promise;

    const storageAdapter = new CatalogStorageAdapter(new MemoryStorageBackend());
    const rig = createTestRig(storageAdapter);

    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA], isAuthenticated: true });
    assert.equal(rig.getApp().cloudCatalogStatus, 'loading');

    // Logout BEFORE defInFlightCatalog settles
    await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().isCloudWorkspace, false);
    assert.equal(rig.getApp().cloudCatalogStatus, 'idle');

    // Resolve stale cloud fetch late after logout
    await act(async () => {
      defInFlightCatalog.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Zombie Cloud Store',
          products: [makeProduct('prod_zombie_cloud', 'Zombie Cloud Product')],
          catalogVersion: 99,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().isCloudWorkspace, false);
    assert.equal(rig.getApp().cloudCatalogStatus, 'idle');
    assert.equal(rig.getApp().loadedWorkspaceId, null);
    assert.notEqual(rig.getApp().storeProfile.name, 'Zombie Cloud Store');
    assert.ok(!rig.getApp().products.some(p => p.id === 'prod_zombie_cloud'));

    // Also test late runAudit resolving after workspace switch ws_a -> ws_b
    const defCatA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defCatB = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defAuditA = createDeferred<{ success: boolean; auditRun: any; catalog: StoragePayloadV1 }>();
    let fetchCount = 0;
    apiClient.getCatalog = async () => {
      fetchCount += 1;
      return fetchCount === 1 ? defCatA.promise : defCatB.promise;
    };
    apiClient.runAudit = async () => defAuditA.promise;

    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defCatA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Store Alpha',
          products: [makeProduct('prod_a', 'Alpha')],
          catalogVersion: 1,
        }),
      });
      await flushMicrotasks();
    });

    // Start runAudit in ws_a
    let auditPromise!: Promise<any>;
    await act(async () => {
      auditPromise = rig.getApp().runAudit();
    });

    // Switch to ws_b while runAudit(ws_a) is still pending
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defCatB.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({
          storeName: 'Store Beta',
          products: [makeProduct('prod_b', 'Beta')],
          catalogVersion: 2,
        }),
      });
      await flushMicrotasks();
    });

    // Late runAudit from ws_a resolves now
    await act(async () => {
      defAuditA.resolve({
        success: true,
        auditRun: { productsEvaluated: 1, rulesEvaluated: 5 },
        catalog: makeCatalogPayload({
          storeName: 'Stale Audited Alpha',
          products: [makeProduct('prod_a_audited', 'Audited Alpha')],
          catalogVersion: 8,
        }),
      });
      await auditPromise;
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_b']);
    assert.equal(rig.getApp().storeProfile.name, 'Store Beta');
  });

  test('7. Repeated workspace switching (A -> B -> C -> D -> B): out-of-order resolutions settle strictly on final workspace B', async () => {
    const d1 = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const d2 = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const d3 = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const d4 = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const d5 = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const queue = [d1, d2, d3, d4, d5];
    let idx = 0;

    apiClient.getCatalog = async () => queue[idx++].promise;

    const rig = createTestRig();
    const allWs = [wsA, wsB, wsC, wsD];

    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: allWs, isAuthenticated: true });
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: allWs, isAuthenticated: true });
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsC, workspaces: allWs, isAuthenticated: true });
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsD, workspaces: allWs, isAuthenticated: true });
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: allWs, isAuthenticated: true });

    assert.equal(idx, 5);

    // Resolve earlier stale requests completely out of order
    await act(async () => {
      d3.resolve({
        workspaceId: 'ws_c',
        catalog: makeCatalogPayload({ storeName: 'Store C', products: [makeProduct('prod_c', 'C')], catalogVersion: 3 }),
      });
      d1.reject(new Error('Stale ws_a failed'));
      d4.resolve({
        workspaceId: 'ws_d',
        catalog: makeCatalogPayload({ storeName: 'Store D', products: [makeProduct('prod_d', 'D')], catalogVersion: 4 }),
      });
      d2.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({ storeName: 'Old B Request', products: [makeProduct('prod_old_b', 'Old B')], catalogVersion: 1 }),
      });
      await flushMicrotasks();
    });

    // Must still be loading for d5; stale d2 for same ws_b must ALSO be discarded because reqGen advanced!
    assert.equal(rig.getApp().cloudCatalogStatus, 'loading');
    assert.deepEqual(rig.getApp().products, []);
    assert.equal(rig.getApp().cloudCatalogError, null);

    // Now resolve the latest d5 request
    await act(async () => {
      d5.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({
          storeName: 'Final B Store',
          products: [makeProduct('prod_final_b', 'Final B')],
          catalogVersion: 22,
        }),
      });
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'loaded');
    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.equal(rig.getApp().storeProfile.name, 'Final B Store');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_final_b']);
    assert.equal(rig.getApp().catalogVersion, 22);
  });

  test('8. Request failure followed by retry: reloadWorkspaceCatalog recovers clean workspace B state without leaking A', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defBFail = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defBRetry = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      if (callIdx === 1) return defA.promise;
      if (callIdx === 2) return defBFail.promise;
      return defBRetry.promise;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Alpha Store',
          products: [makeProduct('prod_alpha', 'Alpha Product')],
          catalogVersion: 1,
        }),
      });
      await flushMicrotasks();
    });

    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defBFail.reject(new Error('503 Transient PG Pool Error'));
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'error');
    assert.equal(rig.getApp().cloudCatalogError, '503 Transient PG Pool Error');
    assert.deepEqual(rig.getApp().products, []);
    assert.equal(rig.getApp().loadedWorkspaceId, null);

    // Retry while still on Workspace B
    let retryPromise!: Promise<void>;
    await act(async () => {
      retryPromise = rig.getApp().reloadWorkspaceCatalog();
    });
    assert.equal(rig.getApp().cloudCatalogStatus, 'loading');
    assert.equal(rig.getApp().cloudCatalogError, null);

    await act(async () => {
      defBRetry.resolve({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({
          storeName: 'Recovered Beta Store',
          products: [makeProduct('prod_beta_ok', 'Beta Recovered')],
          findings: [makeFinding('find_beta_ok', 'prod_beta_ok', 'Recovered finding')],
          catalogVersion: 6,
        }),
      });
      await retryPromise;
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'loaded');
    assert.equal(rig.getApp().cloudCatalogError, null);
    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_b');
    assert.equal(rig.getApp().storeProfile.name, 'Recovered Beta Store');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_beta_ok']);
    assert.deepEqual(rig.getApp().findings.map(f => f.id), ['find_beta_ok']);
    assert.equal(rig.getApp().catalogVersion, 6);
  });

  test('9. Task D: Missing, empty, whitespace, or non-string workspaceId in getCatalog / reloadWorkspaceCatalog fails closed and sets error state', async () => {
    const defA = createDeferred<{ workspaceId: string; catalog: StoragePayloadV1 }>();
    const defB = createDeferred<any>();
    let callIdx = 0;

    apiClient.getCatalog = async () => {
      callIdx += 1;
      if (callIdx === 1) return defA.promise;
      return defB.promise;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defA.resolve({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({
          storeName: 'Store Alpha',
          products: [makeProduct('prod_a1', 'Alpha Product')],
          catalogVersion: 10,
        }),
      });
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().loadedWorkspaceId, 'ws_a');

    // Switch to ws_b and test missing, empty, whitespace, and non-string workspaceId
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });
    await act(async () => {
      defB.resolve({
        catalog: makeCatalogPayload({
          storeName: 'Corrupted Missing ID Store',
          products: [makeProduct('prod_corrupt', 'Corrupt Product')],
          catalogVersion: 99,
        }),
      } as any);
      await flushMicrotasks();
    });

    assert.equal(rig.getApp().cloudCatalogStatus, 'error');
    assert.match(rig.getApp().cloudCatalogError || '', /workspaceId/i);
    assert.equal(rig.getApp().loadedWorkspaceId, null);
    assert.deepEqual(rig.getApp().products, []);
    assert.notEqual(rig.getApp().storeProfile.name, 'Corrupted Missing ID Store');

    for (const badWorkspaceId of ['', '   ', 12345, null]) {
      apiClient.getCatalog = async () => ({
        workspaceId: badWorkspaceId as any,
        catalog: makeCatalogPayload({
          storeName: 'Invalid Retry Store',
          products: [makeProduct('prod_bad_retry', 'Bad Retry Product')],
          catalogVersion: 5,
        }),
      });
      await act(async () => {
        await rig.getApp().reloadWorkspaceCatalog();
        await flushMicrotasks();
      });
      assert.equal(rig.getApp().cloudCatalogStatus, 'error');
      assert.equal(rig.getApp().loadedWorkspaceId, null);
      assert.deepEqual(rig.getApp().products, []);
    }
  });

  test('10. Task D: Non-catalog mutation (approveAction) succeeds without response.workspaceId but rejects mismatched workspaceId', async () => {
    apiClient.getCatalog = async () => ({
      workspaceId: 'ws_a',
      catalog: makeCatalogPayload({
        storeName: 'Store Alpha',
        products: [makeProduct('prod_a1', 'Alpha Product')],
        findings: [makeFinding('find_a1', 'prod_a1', 'Missing GTIN')],
        actions: [makeAction('act_a1', 'prod_a1', 'Add GTIN')],
        catalogVersion: 1,
      }),
    });

    let approveMode: 'omit_ws' | 'wrong_ws' = 'omit_ws';
    apiClient.approveAction = async () => {
      if (approveMode === 'omit_ws') {
        return {
          success: true,
          action: { ...makeAction('act_a1', 'prod_a1', 'Add GTIN'), status: 'approved' },
          catalogVersion: 2,
        } as any;
      }
      return {
        workspaceId: 'ws_b',
        success: true,
        action: { ...makeAction('act_a1', 'prod_a1', 'Poison GTIN'), status: 'approved' },
        catalogVersion: 99,
      } as any;
    };

    const rig = createTestRig();
    await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA], isAuthenticated: true });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().catalogVersion, 1);

    // Response omitting workspaceId applies cleanly for non-getCatalog mutations
    await act(async () => {
      await rig.getApp().approveAction('act_a1');
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().catalogVersion, 2);
    assert.equal(rig.getApp().actionItems[0].status, 'approved');

    // Response with explicit mismatched workspaceId is rejected
    approveMode = 'wrong_ws';
    await act(async () => {
      await rig.getApp().approveAction('act_a1');
      await flushMicrotasks();
    });
    assert.equal(rig.getApp().catalogVersion, 2);
    assert.equal(rig.getApp().actionItems[0].title, 'Add GTIN');
    assert.deepEqual(rig.getApp().products.map(p => p.id), ['prod_a1']);
  });

  test('11. Task E: Overlapping runStoreCheck keeps isCheckingStore=true until latest check completes and ignores stale first check', async () => {
    const origFetch = globalThis.fetch;
    const defStore1 = createDeferred<any>();
    const defStore2 = createDeferred<any>();

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('store-one.example.com')) return defStore1.promise;
      if (url.includes('store-two.example.com')) return defStore2.promise;
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as any;

    try {
      const rig = createTestRig();
      await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });

      let check1!: Promise<void>;
      let check2!: Promise<void>;

      // Start Check #1
      await act(async () => {
        check1 = rig.getApp().runStoreCheck('https://store-one.example.com');
      });
      assert.equal(rig.getApp().isCheckingStore, true);

      // Start Check #2 while #1 is still pending
      await act(async () => {
        check2 = rig.getApp().runStoreCheck('https://store-two.example.com');
      });
      assert.equal(rig.getApp().isCheckingStore, true);

      // Check #1 completes FIRST: MUST NOT clear isCheckingStore or apply Store #1 results!
      await act(async () => {
        defStore1.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            products: [{ id: 101, title: 'Store One Item', variants: [{ id: 11, price: '10.00', sku: 'S1' }] }],
          }),
        });
        await check1;
        await flushMicrotasks();
      });

      assert.equal(rig.getApp().isCheckingStore, true, 'Older check #1 resolving must NOT clear isCheckingStore while check #2 is pending');
      assert.equal(rig.getApp().quickCheckResult, null);

      // Check #2 completes SECOND: updates result and clears isCheckingStore
      await act(async () => {
        defStore2.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            products: [{ id: 202, title: 'Store Two Item', variants: [{ id: 22, price: '25.00', sku: 'S2' }] }],
          }),
        });
        await check2;
        await flushMicrotasks();
      });

      assert.equal(rig.getApp().isCheckingStore, false);
      assert.equal(rig.getApp().quickCheckResult?.url, 'https://store-two.example.com');
      assert.equal(rig.getApp().lastIngestionResult?.candidateProducts[0]?.title, 'Store Two Item');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('12. Task E: Stale runStoreCheck failure after newer check or workspace switch does not emit stale error toast or mutate newer state', async () => {
    const origFetch = globalThis.fetch;
    const defStore1 = createDeferred<any>();
    const defStore2 = createDeferred<any>();
    const defWsCheck = createDeferred<any>();

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('slow-fail.example.com')) return defStore1.promise;
      if (url.includes('fast-ok.example.com')) return defStore2.promise;
      if (url.includes('ws-switch.example.com')) return defWsCheck.promise;
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as any;

    try {
      const rig = createTestRig();
      await rig.renderWithAuth({ user: null, activeWorkspace: null, workspaces: [], isAuthenticated: false });

      let checkSlowFail!: Promise<void>;
      let checkFastOk!: Promise<void>;

      await act(async () => {
        checkSlowFail = rig.getApp().runStoreCheck('https://slow-fail.example.com');
      });
      await act(async () => {
        checkFastOk = rig.getApp().runStoreCheck('https://fast-ok.example.com');
      });

      // Check #2 finishes FIRST
      await act(async () => {
        defStore2.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            products: [{ id: 303, title: 'Fast OK Item', variants: [{ id: 33, price: '30.00', sku: 'F1' }] }],
          }),
        });
        await checkFastOk;
        await flushMicrotasks();
      });
      assert.equal(rig.getApp().isCheckingStore, false);
      const toastCountAfterFast = rig.getApp().toasts.length;

      // Stale Check #1 now resolves with network error / HTTP 500 or rejects
      await act(async () => {
        defStore1.reject(new Error('Stale network failure'));
        await checkSlowFail;
        await flushMicrotasks();
      });

      assert.equal(rig.getApp().isCheckingStore, false);
      assert.equal(rig.getApp().quickCheckResult?.url, 'https://fast-ok.example.com');
      assert.equal(rig.getApp().toasts.length, toastCountAfterFast, 'Stale check failure must not emit toast');

      // Also verify workspace switch while store check is in-flight resets isCheckingStore cleanly
      apiClient.getCatalog = async () => ({
        workspaceId: 'ws_a',
        catalog: makeCatalogPayload({ storeName: 'Store Alpha', products: [makeProduct('prod_a1', 'A')], catalogVersion: 1 }),
      });
      await rig.renderWithAuth({ user: userA, activeWorkspace: wsA, workspaces: [wsA, wsB], isAuthenticated: true });
      await act(async () => {
        await flushMicrotasks();
      });

      let wsCheck!: Promise<void>;
      await act(async () => {
        wsCheck = rig.getApp().runStoreCheck('https://ws-switch.example.com');
      });
      assert.equal(rig.getApp().isCheckingStore, true);

      // Switch to wsB while check is running
      apiClient.getCatalog = async () => ({
        workspaceId: 'ws_b',
        catalog: makeCatalogPayload({ storeName: 'Store Beta', products: [makeProduct('prod_b1', 'B')], catalogVersion: 1 }),
      });
      await rig.renderWithAuth({ user: userA, activeWorkspace: wsB, workspaces: [wsA, wsB], isAuthenticated: true });
      assert.equal(rig.getApp().isCheckingStore, false, 'Workspace switch must immediately reset isCheckingStore');

      await act(async () => {
        defWsCheck.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            products: [{ id: 404, title: 'Wrong WS Scan Product', variants: [{ id: 44, price: '40.00', sku: 'W1' }] }],
          }),
        });
        await wsCheck;
        await flushMicrotasks();
      });

      assert.equal(rig.getApp().isCheckingStore, false);
      assert.equal(rig.getApp().quickCheckResult, null, 'Late scan from wsA must never attach to wsB');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
