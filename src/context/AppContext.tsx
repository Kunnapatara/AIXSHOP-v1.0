import React, { createContext, useContext, useState, useMemo, useEffect, ReactNode, useRef } from 'react';
import { 
  NavigationPage, 
  Product, 
  Variant,
  Offer,
  EvidenceDocument,
  Finding, 
  ActionItem, 
  StoreProfile, 
  QuickHealthCheckResult,
  StoreIngestionResult,
  CatalogImportResult
} from '../types';
import { 
  initialStoreProfile, 
  initialProducts, 
  initialFindings, 
  initialActionItems 
} from '../data/mockData';
import { CatalogStorageAdapter } from '../domain/storage/storageAdapter';
import { StoragePayloadV1, StorageLoadResult } from '../domain/storage/storageTypes';
import {
  executeActionApproval,
  executeActionDismissal,
  executeActionRecheck,
  executeProductRecheck,
  calculateStoreCompletenessAvg,
  executeCatalogImport,
} from '../domain/catalog/catalogMutationService';
import { ingestAndAnalyzeStore } from '../domain/ingestion/storeIngestion';
import { 
  validateAndApplyProfileUpdate, 
  applyConnectorToggle 
} from '../domain/settings/settingsService';
import { executeCatalogAudit } from '../domain/audit/auditEngine';
import {
  evaluateDemoOverwriteProtection,
  CloudCatalogLoadStatus,
  DemoOverwriteProtectionEvaluation,
} from '../domain/catalog/demoMigrationProtection';
import { useAuth } from './AuthContext';
import { apiClient, PreliminaryAuditSummary, ReportEntitlement } from '../api/client';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export interface AppContextType {
  currentPage: NavigationPage;
  previousPage: NavigationPage;
  selectedProductId: string | null;
  selectedActionId: string | null;
  storeProfile: StoreProfile;
  products: Product[];
  variantsCount: number;
  offersCount: number;
  findings: Finding[];
  actionItems: ActionItem[];
  evidenceCount: number;
  toasts: ToastMessage[];
  quickCheckResult: QuickHealthCheckResult | null;
  lastIngestionResult: StoreIngestionResult | null;
  isCheckingStore: boolean;
  selectedProduct: Product | null;
  mobileMenuOpen: boolean;
  isReadOnlyMode: boolean;
  readOnlyReason: string | null;
  storageLoadResult: StorageLoadResult | null;
  isDurableStorage: boolean;
  isCloudWorkspace: boolean;
  cloudCatalogStatus: CloudCatalogLoadStatus;
  loadedWorkspaceId?: string | null;
  cloudCatalogError?: string | null;
  catalogVersion?: number;
  reportEntitlement?: ReportEntitlement | null;
  preliminarySummary?: PreliminaryAuditSummary | null;
  selectedSettingsTab?: 'profile' | 'workspace' | 'connectors' | 'subscription' | 'policies' | 'diagnostics' | null;
  demoOverwriteProtection: DemoOverwriteProtectionEvaluation;
  setMobileMenuOpen: (open: boolean) => void;
  setSelectedActionId: (id: string | null) => void;
  navigateTo: (page: NavigationPage, entityId?: string, fromPage?: NavigationPage) => void;
  viewProductDetail: (productId: string, fromPage?: NavigationPage) => void;
  returnFromProductDetail: () => void;
  runStoreCheck: (url: string) => Promise<void>;
  importDiscoveredProducts: () => Promise<CatalogImportResult | null>;
  approveAction: (actionId: string, customApprovedValue?: string) => Promise<void> | void;
  dismissAction: (actionId: string) => Promise<void> | void;
  recheckAction: (actionId: string) => Promise<void> | void;
  recheckProduct: (productId: string) => void;
  updateStoreProfile: (updates: Partial<StoreProfile>) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  toggleConnectorSync: (connectorId: string) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
  migrateDemoDataToCloud: () => Promise<boolean>;
  runAudit: () => Promise<any>;
  addToast: (title: string, message: string, type?: ToastMessage['type']) => void;
  removeToast: (id: string) => void;
  resetToSeedData: () => void;
  reloadWorkspaceCatalog: () => Promise<void>;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

function buildEmptyCloudStoreProfile(workspace?: { name?: string; slug?: string } | null): StoreProfile {
  return {
    name: workspace?.name ? `${workspace.name} Store` : '',
    domain: workspace?.slug ? `${workspace.slug}.myshopify.com` : '',
    currency: 'USD',
    skuCount: 0,
    skuLimit: 2500,
    catalogCompletenessAvg: 0,
    truthBoundaryStrictness: 'standard',
    tier: 'Free Audit',
    connectors: [],
  };
}

function resolveInitialPageFromLocation(): NavigationPage {
  if (typeof window === 'undefined' || !window.location) {
    return 'home';
  }
  try {
    const pathname = typeof window.location.pathname === 'string' ? window.location.pathname : '';
    if (pathname === '/settings') {
      return 'settings';
    }
    const search = typeof window.location.search === 'string' ? window.location.search : '';
    if (search) {
      const params = new URLSearchParams(search);
      const pageParam = params.get('page');
      if (
        pageParam === 'landing' ||
        pageParam === 'home' ||
        pageParam === 'audit' ||
        pageParam === 'products' ||
        pageParam === 'actions' ||
        pageParam === 'ai-discovery' ||
        pageParam === 'feed-readiness' ||
        pageParam === 'business-profile' ||
        pageParam === 'ai-visibility' ||
        pageParam === 'settings'
      ) {
        return pageParam;
      }
      if (params.has('shopify') || params.has('shopify_error')) {
        return 'settings';
      }
    }
  } catch {
    // Fallback safely in restricted DOM environments
  }
  return 'home';
}

export const AppProvider: React.FC<{ children: ReactNode; customStorageAdapter?: CatalogStorageAdapter }> = ({ 
  children, 
  customStorageAdapter 
}) => {
  const storageAdapterRef = useRef<CatalogStorageAdapter>(customStorageAdapter || new CatalogStorageAdapter());
  const storageAdapter = storageAdapterRef.current;

  const [currentPage, setCurrentPage] = useState<NavigationPage>(() => resolveInitialPageFromLocation());
  const [previousPage, setPreviousPage] = useState<NavigationPage>('home');
  const [selectedProductId, setSelectedProductId] = useState<string | null>('prod_solstice_01');
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [storeProfile, setStoreProfile] = useState<StoreProfile>(initialStoreProfile);
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [variants, setVariants] = useState<Variant[]>(() => initialProducts.flatMap(p => p.variants || []));
  const [offers, setOffers] = useState<Offer[]>(() => initialProducts.flatMap(p => p.offers || []));
  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [evidence, setEvidence] = useState<EvidenceDocument[]>(() => initialProducts.flatMap(p => p.evidenceDocuments || []));
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [quickCheckResult, setQuickCheckResult] = useState<QuickHealthCheckResult | null>(null);
  const [lastIngestionResult, setLastIngestionResult] = useState<StoreIngestionResult | null>(null);
  const [isCheckingStore, setIsCheckingStore] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [isReadOnlyMode, setIsReadOnlyMode] = useState<boolean>(false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [storageLoadResult, setStorageLoadResult] = useState<StorageLoadResult | null>(null);
  const [cloudCatalogStatus, setCloudCatalogStatus] = useState<CloudCatalogLoadStatus>('idle');
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null);
  const [loadedCloudIdentity, setLoadedCloudIdentity] = useState<string | null>(null);
  const [cloudCatalogError, setCloudCatalogError] = useState<string | null>(null);
  const [cloudCatalogErrorIdentity, setCloudCatalogErrorIdentity] = useState<string | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<number | undefined>(undefined);
  const [reportEntitlement, setReportEntitlement] = useState<ReportEntitlement | null>(null);
  const [preliminarySummary, setPreliminarySummary] = useState<PreliminaryAuditSummary | null>(null);
  const [selectedSettingsTab, setSelectedSettingsTab] = useState<
    'profile' | 'workspace' | 'connectors' | 'subscription' | 'policies' | 'diagnostics' | null
  >(null);

  const isInitializedRef = useRef<boolean>(false);
  const wasCloudSessionRef = useRef<boolean>(false);
  const catalogVersionRef = useRef<number | undefined>(undefined);
  const cloudRequestGenRef = useRef<number>(0);
  const storeCheckGenRef = useRef<number>(0);
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Check auth context safely (null if outside AuthProvider in test environments)
  let authContext: any = null;
  try {
    authContext = useAuth();
  } catch {
    authContext = null;
  }

  const isCloudWorkspace = Boolean(authContext?.isAuthenticated && authContext?.activeWorkspace);
  const activeWorkspaceId: string | undefined = authContext?.activeWorkspace?.id;
  const activeUserId: string | undefined = authContext?.user?.id;
  const currentCloudIdentity =
    isCloudWorkspace && activeWorkspaceId ? `${activeUserId ?? ''}:${activeWorkspaceId}` : null;

  const activeIdentityRef = useRef<{
    isCloudWorkspace: boolean;
    workspaceId?: string;
    userId?: string;
    identity: string | null;
  }>({
    isCloudWorkspace,
    workspaceId: activeWorkspaceId,
    userId: activeUserId,
    identity: currentCloudIdentity,
  });
  activeIdentityRef.current = {
    isCloudWorkspace,
    workspaceId: activeWorkspaceId,
    userId: activeUserId,
    identity: currentCloudIdentity,
  };

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const addToast = (title: string, message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    setToasts(prev => [...prev, { id, title, message, type }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(timer);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
    if (typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
    toastTimersRef.current.add(timer);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Helper to persist current application state to local storage when in unauthenticated / demo mode
  const persistState = (
    nextProducts: Product[],
    nextFindings: Finding[],
    nextActions: ActionItem[],
    nextProfile: StoreProfile
  ) => {
    if (isReadOnlyMode) {
      return {
        success: false,
        error: 'Storage is in read-only compatibility mode.',
        isBlockedByReadOnly: true,
        isDurable: storageAdapter.isDurable(),
      };
    }

    const payload: StoragePayloadV1 = {
      products: nextProducts,
      variants: nextProducts.flatMap(p => p.variants || []),
      offers: nextProducts.flatMap(p => p.offers || []),
      findings: nextFindings,
      actions: nextActions,
      evidence: nextProducts.flatMap(p => p.evidenceDocuments || []),
      storeProfile: nextProfile,
    };

    const res = storageAdapter.save(payload);
    if (!res.success && res.isQuotaExceeded) {
      addToast('Storage Quota Full', 'Local browser storage quota exceeded. State is preserved in memory only.', 'warning');
    }
    return res;
  };

  const hasValidMatchingWorkspaceId = (
    responseWorkspaceId: unknown,
    expectedWorkspaceId: string
  ): boolean =>
    typeof responseWorkspaceId === 'string' &&
    responseWorkspaceId.trim().length > 0 &&
    responseWorkspaceId === expectedWorkspaceId;

  const isCurrentCloudRequest = (
    reqGen: number,
    expectedWorkspaceId?: string,
    expectedUserId?: string,
    responseWorkspaceId?: unknown,
    options?: { requireResponseWorkspaceId?: boolean }
  ): boolean => {
    if (reqGen !== cloudRequestGenRef.current) return false;
    const active = activeIdentityRef.current;
    if (!active.isCloudWorkspace || !active.workspaceId) return false;
    if (expectedWorkspaceId !== active.workspaceId) return false;
    if (expectedUserId !== active.userId) return false;
    if (options?.requireResponseWorkspaceId) {
      return hasValidMatchingWorkspaceId(responseWorkspaceId, active.workspaceId);
    }
    if (responseWorkspaceId !== undefined && responseWorkspaceId !== null) {
      return hasValidMatchingWorkspaceId(responseWorkspaceId, active.workspaceId);
    }
    return true;
  };

  const clearCloudCatalogState = (workspace?: { name?: string; slug?: string } | null) => {
    storeCheckGenRef.current += 1;
    catalogVersionRef.current = undefined;
    setCatalogVersion(undefined);
    setReportEntitlement(null);
    setPreliminarySummary(null);
    setLoadedWorkspaceId(null);
    setLoadedCloudIdentity(null);
    setProducts([]);
    setVariants([]);
    setOffers([]);
    setFindings([]);
    setActionItems([]);
    setEvidence([]);
    setStoreProfile(buildEmptyCloudStoreProfile(workspace));
    setSelectedProductId(null);
    setSelectedActionId(null);
    setQuickCheckResult(null);
    setLastIngestionResult(null);
    setIsCheckingStore(false);
    setIsReadOnlyMode(false);
    setReadOnlyReason(null);
    setCurrentPage(prev => (prev === 'product-detail' ? 'products' : prev));
  };

  const applyCatalogSnapshot = (
    cat: StoragePayloadV1,
    ownerWorkspaceId?: string,
    ownerUserId?: string
  ) => {
    catalogVersionRef.current = cat.catalogVersion;
    setCatalogVersion(cat.catalogVersion);
    setProducts(cat.products);
    setVariants(cat.variants && cat.variants.length > 0 ? cat.variants : cat.products.flatMap(p => p.variants || []));
    setOffers(cat.offers && cat.offers.length > 0 ? cat.offers : cat.products.flatMap(p => p.offers || []));
    setFindings(cat.findings);
    setActionItems(cat.actions);
    setEvidence(cat.evidence && cat.evidence.length > 0 ? cat.evidence : cat.products.flatMap(p => p.evidenceDocuments || []));
    setStoreProfile(cat.storeProfile);
    setSelectedProductId(prev =>
      prev && cat.products.some(p => p.id === prev) ? prev : (cat.products[0]?.id ?? null)
    );
    if (ownerWorkspaceId) {
      setLoadedWorkspaceId(ownerWorkspaceId);
      setLoadedCloudIdentity(`${ownerUserId ?? ''}:${ownerWorkspaceId}`);
    }
    setCloudCatalogError(null);
    setCloudCatalogErrorIdentity(null);
  };

  const hydrateLocalDemoCatalog = (isLogoutTransition: boolean) => {
    storeCheckGenRef.current += 1;
    setIsReadOnlyMode(false);
    setReadOnlyReason(null);
    setSelectedActionId(null);
    setQuickCheckResult(null);
    setLastIngestionResult(null);
    setIsCheckingStore(false);
    setCurrentPage(prev => (prev === 'product-detail' ? 'products' : prev));

    const result = storageAdapter.load();
    setStorageLoadResult(result);

    if (result.type === 'valid') {
      const p = result.envelope.payload;
      setProducts(p.products);
      setVariants(p.variants && p.variants.length > 0 ? p.variants : p.products.flatMap(pr => pr.variants || []));
      setOffers(p.offers && p.offers.length > 0 ? p.offers : p.products.flatMap(pr => pr.offers || []));
      setFindings(p.findings);
      setActionItems(p.actions);
      setEvidence(p.evidence && p.evidence.length > 0 ? p.evidence : p.products.flatMap(pr => pr.evidenceDocuments || []));
      setStoreProfile(p.storeProfile);
      setSelectedProductId(p.products[0]?.id ?? null);
      if (!isLogoutTransition) {
        addToast('Demo Session Loaded', 'Your local demo workspace catalog has been loaded.', 'info');
      }
      return;
    }

    // Explicitly restore default demo seed fixtures so prior cloud workspace data can never linger
    setProducts(initialProducts);
    setVariants(initialProducts.flatMap(pr => pr.variants || []));
    setOffers(initialProducts.flatMap(pr => pr.offers || []));
    setFindings(initialFindings);
    setActionItems(initialActionItems);
    setEvidence(initialProducts.flatMap(pr => pr.evidenceDocuments || []));
    setStoreProfile(initialStoreProfile);
    setSelectedProductId(initialProducts[0]?.id ?? 'prod_solstice_01');

    if (result.type === 'not_found') {
      storageAdapter.save({
        products: initialProducts,
        variants: initialProducts.flatMap(pr => pr.variants || []),
        offers: initialProducts.flatMap(pr => pr.offers || []),
        findings: initialFindings,
        actions: initialActionItems,
        evidence: initialProducts.flatMap(pr => pr.evidenceDocuments || []),
        storeProfile: initialStoreProfile,
      });
    } else if (result.type === 'corrupt') {
      console.warn(`[AIXSHOP Storage] Corrupted local data detected and preserved in backup: ${result.backupKey}`);
      addToast(
        'Workspace Restored',
        'A problem was detected with local session data. Restored with default catalog items.',
        'warning'
      );
    } else if (result.type === 'unsupported_version') {
      console.warn(`[AIXSHOP Storage] Future schema version (${result.foundVersion}) detected. Enabling read-only mode.`);
      setIsReadOnlyMode(true);
      setReadOnlyReason(storageAdapter.getReadOnlyReason());
      addToast(
        'Read-Only Mode Active',
        'This catalog was updated in a newer version. Editing is temporarily paused to protect your store data.',
        'warning'
      );
    } else if (result.type === 'storage_failure') {
      console.warn(`[AIXSHOP Storage] Storage error: ${result.error}`);
      addToast('Storage Restricted', 'Local storage is currently restricted. Your catalog is available for this session.', 'warning');
    }
  };

  // Hydrate: Cloud API if authenticated in active workspace; otherwise local storage adapter
  useEffect(() => {
    const reqGen = ++cloudRequestGenRef.current;

    if (!isCloudWorkspace) {
      const hadCloudSession = wasCloudSessionRef.current;
      wasCloudSessionRef.current = false;

      catalogVersionRef.current = undefined;
      setCatalogVersion(undefined);
      setReportEntitlement(null);
      setPreliminarySummary(null);
      setLoadedWorkspaceId(null);
      setLoadedCloudIdentity(null);
      setCloudCatalogStatus('idle');
      setCloudCatalogError(null);
      setCloudCatalogErrorIdentity(null);

      if (!isInitializedRef.current || hadCloudSession) {
        isInitializedRef.current = true;
        hydrateLocalDemoCatalog(hadCloudSession);
      }
      return;
    }

    // Authenticated Cloud Workspace mode: Immediately clear previous workspace/demo state before fetching
    wasCloudSessionRef.current = true;
    const targetWorkspaceId = activeWorkspaceId!;
    const targetUserId = activeUserId;
    const targetIdentity = currentCloudIdentity!;
    const targetWorkspaceName = authContext?.activeWorkspace?.name || 'Workspace';

    clearCloudCatalogState(authContext?.activeWorkspace);
    setCloudCatalogError(null);
    setCloudCatalogErrorIdentity(null);
    setCloudCatalogStatus('loading');

    let isCancelled = false;
    async function loadCloudCatalog() {
      try {
        const res = await apiClient.getCatalog();
        if (
          isCancelled ||
          !isCurrentCloudRequest(reqGen, targetWorkspaceId, targetUserId)
        ) {
          return;
        }
        if (
          !isCurrentCloudRequest(reqGen, targetWorkspaceId, targetUserId, res?.workspaceId, {
            requireResponseWorkspaceId: true,
          })
        ) {
          throw new Error('Workspace catalog response failed validation (missing or mismatched workspaceId).');
        }
        applyCatalogSnapshot(res.catalog, targetWorkspaceId, targetUserId);
        setReportEntitlement(res.reportEntitlement ?? null);
        setPreliminarySummary(res.preliminarySummary ?? null);
        setCloudCatalogStatus('loaded');
        setIsReadOnlyMode(false);
        setReadOnlyReason(null);
        addToast(
          'Workspace Connected',
          `Loaded catalog for workspace "${targetWorkspaceName}". Data is durably persisted to PostgreSQL.`,
          'success'
        );
      } catch (err: any) {
        if (
          isCancelled ||
          !isCurrentCloudRequest(reqGen, targetWorkspaceId, targetUserId)
        ) {
          return;
        }
        clearCloudCatalogState(authContext?.activeWorkspace);
        const errMessage = err?.message || 'Failed to load catalog from server.';
        setCloudCatalogError(errMessage);
        setCloudCatalogErrorIdentity(targetIdentity);
        setCloudCatalogStatus('error');
        console.error('[AIXSHOP Cloud] Failed to load workspace catalog:', err);
        addToast(
          'Cloud Catalog Error',
          errMessage,
          'error'
        );
      }
    }

    loadCloudCatalog();
    return () => {
      isCancelled = true;
      cloudRequestGenRef.current += 1;
    };
  }, [isCloudWorkspace, activeWorkspaceId, activeUserId]);

  const navigateTo = (page: NavigationPage, entityId?: string, fromPage?: NavigationPage) => {
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (page === 'product-detail') {
      if (entityId) {
        setSelectedProductId(entityId);
      }
      setPreviousPage(fromPage || currentPage);
      setCurrentPage('product-detail');
      return;
    }

    if (page === 'actions' && entityId) {
      setSelectedActionId(entityId);
    }

    if (
      page === 'settings' &&
      (entityId === 'profile' ||
        entityId === 'workspace' ||
        entityId === 'connectors' ||
        entityId === 'subscription' ||
        entityId === 'policies' ||
        entityId === 'diagnostics')
    ) {
      setSelectedSettingsTab(entityId);
    } else if (page !== 'settings') {
      setSelectedSettingsTab(null);
    }

    setPreviousPage(fromPage || currentPage);
    setCurrentPage(page);
  };

  const viewProductDetail = (productId: string, fromPage?: NavigationPage) => {
    setPreviousPage(fromPage || currentPage);
    setSelectedProductId(productId);
    setCurrentPage('product-detail');
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const returnFromProductDetail = () => {
    const target = previousPage === 'product-detail' ? 'products' : previousPage;
    setCurrentPage(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const selectedProduct = useMemo(() => {
    if (!selectedProductId) return null;
    return products.find(p => p.id === selectedProductId) || null;
  }, [selectedProductId, products]);

  const runStoreCheck = async (url: string) => {
    const myCheckGen = ++storeCheckGenRef.current;
    const startIdentity = activeIdentityRef.current.identity;
    const startCloudGen = cloudRequestGenRef.current;
    const isStillCurrentCheck = () =>
      storeCheckGenRef.current === myCheckGen &&
      activeIdentityRef.current.identity === startIdentity &&
      cloudRequestGenRef.current === startCloudGen;

    setIsCheckingStore(true);
    try {
      const result = await ingestAndAnalyzeStore(url, { existingCatalog: products });
      if (!isStillCurrentCheck()) {
        return;
      }
      setQuickCheckResult(result);
      if (result.ingestionResult) {
        setLastIngestionResult(result.ingestionResult);
      }

      const canShowMetrics = Boolean(isCloudWorkspace && reportEntitlement?.hasFullReportAccess);
      if (result.scanStatus === 'demo_fixture') {
        addToast(
          'Demo Storefront Discovered',
          canShowMetrics
            ? `Evaluated Solstice Mercantile demo catalog (${result.catalogCompletenessEstimate}% completeness, ${result.gtinPresentRatio}% GTIN coverage).`
            : 'Discovered Solstice Mercantile demo storefront catalog. Upgrade to a paid plan to run and view full audit reports.',
          'info'
        );
      } else if (result.scanStatus === 'real_scan') {
        addToast(
          'Public Storefront Catalog Discovered',
          canShowMetrics
            ? `Parsed public product feed (${result.catalogCompletenessEstimate}% completeness, ${result.gtinPresentRatio}% GTIN coverage).`
            : `Discovered ${result.ingestionResult?.candidateProducts?.length ?? 0} candidate products from public storefront feed. Upgrade to unlock audit findings.`,
          'success'
        );
      } else if (result.scanStatus === 'network_failure') {
        addToast(
          'Direct Browser Access Restricted',
          'Store CORS policy blocked public feed fetch. Connect your store in Settings for full sync.',
          'warning'
        );
      } else {
        addToast(
          'Store Not Directly Scannable',
          result.notice || 'Store does not expose an open public JSON catalog feed.',
          'warning'
        );
      }
    } catch (e) {
      if (!isStillCurrentCheck()) {
        return;
      }
      addToast('Scan Error', (e as Error).message || 'Failed to inspect store.', 'error');
    } finally {
      if (isStillCurrentCheck()) {
        setIsCheckingStore(false);
      }
    }
  };

  const importDiscoveredProducts = async (): Promise<CatalogImportResult | null> => {
    if (!lastIngestionResult || !lastIngestionResult.candidateProducts.length) {
      addToast('No Products Discovered', 'Run a store check first to discover products for import.', 'warning');
      return null;
    }

    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.importCatalog(lastIngestionResult.candidateProducts);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return null;
        if (res.success && res.result) {
          const catRes = await apiClient.getCatalog();
          if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return null;
          if (
            !isCurrentCloudRequest(reqGen, targetWsId, targetUserId, catRes?.workspaceId, {
              requireResponseWorkspaceId: true,
            })
          ) {
            throw new Error('Workspace catalog response failed validation (missing or mismatched workspaceId).');
          }
          applyCatalogSnapshot(catRes.catalog, targetWsId, targetUserId);
          setReportEntitlement(catRes.reportEntitlement ?? null);
          setPreliminarySummary(catRes.preliminarySummary ?? null);
          setCloudCatalogStatus('loaded');
          addToast('Catalog Import Complete', res.result.message, 'success');
          return res.result;
        }
        return null;
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return null;
        addToast('Import Failed (Rolled Back)', err.message || 'Server rejected catalog import. Catalog preserved.', 'error');
        return null;
      }
    }

    if (isReadOnlyMode) {
      addToast('Import Disabled', 'Storage is in read-only compatibility mode.', 'warning');
      return null;
    }

    const res = executeCatalogImport(lastIngestionResult.candidateProducts, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: isReadOnlyMode,
    });

    if (!res.success) {
      addToast('Import Failed', res.message, 'error');
      return res;
    }

    if (res.importedCount === 0) {
      addToast('Import Information', res.message, 'info');
      return res;
    }

    // Atomic persistence through storage adapter
    const saveRes = persistState(
      res.nextProducts,
      findings,
      actionItems,
      res.nextStoreProfile
    );

    if (!saveRes.success) {
      addToast(
        'Persistence Failed (Rolled Back)',
        `Could not persist imported products: ${saveRes.error}. Catalog preserved.`,
        'error'
      );
      return { ...res, success: false };
    }

    // Persist succeeded: commit in-memory state
    setProducts(res.nextProducts);
    setStoreProfile(res.nextStoreProfile);

    // Update lastIngestionResult details
    setLastIngestionResult(prev => {
      if (!prev) return null;
      return {
        ...prev,
        evaluationDetails: res.details,
      };
    });

    addToast('Catalog Import Complete', res.message, 'success');
    return res;
  };

  const approveAction = async (actionId: string, customApprovedValue?: string) => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.approveAction(actionId, customApprovedValue);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId, (res as any)?.workspaceId)) return;
        if (res.success && res.action) {
          if (typeof res.catalogVersion === 'number') {
            catalogVersionRef.current = res.catalogVersion;
            setCatalogVersion(res.catalogVersion);
          } else {
            await reloadWorkspaceCatalog();
            if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
          }
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          if (res.product) {
            setProducts(prev => prev.map(p => p.id === res.product!.id ? res.product! : p));
          }
          addToast('Remediation Approved', 'Action successfully approved and durably persisted to PostgreSQL.', 'success');
        }
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
        if (err?.code === 'REPORT_PAYMENT_REQUIRED') {
          if (err.reportEntitlement) setReportEntitlement(err.reportEntitlement);
          addToast('Paid Plan Required', err.message || 'Upgrade to an active paid plan to approve remediation actions.', 'warning');
          return;
        }
        addToast('Action Failed (Rolled Back)', err.message || 'Failed to approve action on server.', 'error');
      }
      return;
    }

    const res = executeActionApproval(actionId, customApprovedValue, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: isReadOnlyMode,
    });

    if (!res.success) {
      addToast(
        res.errorCode === 'READ_ONLY_MODE' ? 'Action Disabled' : 'Action Failed',
        res.message,
        res.errorCode === 'READ_ONLY_MODE' ? 'warning' : 'error'
      );
      return;
    }

    // Persist state atomically
    const saveRes = persistState(
      res.nextProducts,
      res.nextFindings,
      res.nextActions,
      res.nextStoreProfile
    );

    if (!saveRes.success) {
      // ATOMIC ROLLBACK: do not mutate local memory if storage write failed
      addToast(
        'Persistence Failed (Rolled Back)',
        `Could not save approval to storage (${saveRes.error}). State has been preserved safely without partial mutation.`,
        'error'
      );
      return;
    }

    // Storage write succeeded: commit in-memory state
    setProducts(res.nextProducts);
    setFindings(res.nextFindings);
    setActionItems(res.nextActions);
    setStoreProfile(res.nextStoreProfile);

    addToast(
      'Remediation Approved',
      res.message + ' Note: External store live write-back requires connector authorization in Settings.',
      'success'
    );
  };

  const dismissAction = async (actionId: string) => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.dismissAction(actionId);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId, (res as any)?.workspaceId)) return;
        if (res.success && res.action) {
          if (typeof res.catalogVersion === 'number') {
            catalogVersionRef.current = res.catalogVersion;
            setCatalogVersion(res.catalogVersion);
          } else {
            await reloadWorkspaceCatalog();
            if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
          }
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          addToast('Action Dismissed', 'Action dismissed and durably persisted.', 'info');
        }
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
        if (err?.code === 'REPORT_PAYMENT_REQUIRED') {
          if (err.reportEntitlement) setReportEntitlement(err.reportEntitlement);
          addToast('Paid Plan Required', err.message || 'Upgrade to an active paid plan to dismiss remediation actions.', 'warning');
          return;
        }
        addToast('Dismiss Failed', err.message || 'Failed to dismiss action on server.', 'error');
      }
      return;
    }

    const res = executeActionDismissal(actionId, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: isReadOnlyMode,
    });

    if (!res.success) {
      addToast('Action Disabled', res.message, 'warning');
      return;
    }

    const saveRes = persistState(
      res.nextProducts,
      res.nextFindings,
      res.nextActions,
      res.nextStoreProfile
    );

    if (!saveRes.success) {
      addToast('Persistence Failed', `Could not persist dismissal: ${saveRes.error}`, 'error');
      return;
    }

    setProducts(res.nextProducts);
    setFindings(res.nextFindings);
    setActionItems(res.nextActions);
    setStoreProfile(res.nextStoreProfile);
    addToast('Action Dismissed', res.message, 'info');
  };

  const recheckAction = async (actionId: string) => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.recheckAction(actionId);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId, (res as any)?.workspaceId)) return;
        if (res.success && res.action) {
          if (typeof res.catalogVersion === 'number') {
            catalogVersionRef.current = res.catalogVersion;
            setCatalogVersion(res.catalogVersion);
          } else {
            await reloadWorkspaceCatalog();
            if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
          }
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          addToast('Action Re-checked', 'Action evaluated and durably updated.', 'info');
        }
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
        if (err?.code === 'REPORT_PAYMENT_REQUIRED') {
          if (err.reportEntitlement) setReportEntitlement(err.reportEntitlement);
          addToast('Paid Plan Required', err.message || 'Upgrade to an active paid plan to re-check remediation actions.', 'warning');
          return;
        }
        addToast('Re-check Failed', err.message || 'Failed to re-check action on server.', 'error');
      }
      return;
    }

    const res = executeActionRecheck(actionId, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: isReadOnlyMode,
    });

    if (!res.success) {
      addToast(
        res.errorCode === 'READ_ONLY_MODE' ? 'Re-check Disabled' : 'Re-check Failed',
        res.message,
        res.errorCode === 'READ_ONLY_MODE' ? 'warning' : 'error'
      );
      return;
    }

    const saveRes = persistState(products, res.nextFindings, res.nextActions, storeProfile);
    if (!saveRes.success) {
      addToast('Persistence Failed', `Could not persist re-check results: ${saveRes.error}`, 'error');
      return;
    }

    setActionItems(res.nextActions);
    setFindings(res.nextFindings);

    if (res.isVerified) {
      addToast('Re-check Verified', res.message, 'success');
    } else if (res.errorCode === 'ACTION_PENDING') {
      addToast('Action Still Pending', res.message, 'warning');
    } else {
      addToast('Re-check Failed', res.message, 'error');
    }
  };

  const recheckProduct = async (productId: string) => {
    const res = executeProductRecheck(productId, {
      products,
      findings,
      actionItems,
      storeProfile,
      isReadOnly: isReadOnlyMode,
    });

    if (!res.success) {
      addToast('Re-check Warning', res.message, 'warning');
      return;
    }

    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const expectedVersion = catalogVersionRef.current;
        const saveRes = await apiClient.saveCatalog(
          {
            products: res.nextProducts,
            variants: res.nextProducts.flatMap(p => p.variants || []),
            offers: res.nextProducts.flatMap(p => p.offers || []),
            findings,
            actions: actionItems,
            evidence: res.nextProducts.flatMap(p => p.evidenceDocuments || []),
            storeProfile,
            catalogVersion: expectedVersion,
          },
          expectedVersion
        );
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
        if (!saveRes.success) {
          addToast('Persistence Failed', 'Could not persist product audit to cloud database.', 'error');
          return;
        }
        if (typeof saveRes.catalogVersion === 'number') {
          catalogVersionRef.current = saveRes.catalogVersion;
          setCatalogVersion(saveRes.catalogVersion);
        }
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return;
        if (err.status === 409 || err.code === 'CATALOG_VERSION_CONFLICT') {
          await reloadWorkspaceCatalog();
          addToast(
            'Catalog Updated Remotely',
            'Another change updated this workspace catalog. Reloaded the latest server state—please retry.',
            'warning'
          );
          return;
        }
        addToast('Persistence Failed', err.message || 'Could not persist product audit to cloud database.', 'error');
        return;
      }
    } else {
      const saveRes = persistState(res.nextProducts, findings, actionItems, storeProfile);
      if (!saveRes.success) {
        addToast('Persistence Failed', `Could not persist product audit: ${saveRes.error}`, 'error');
        return;
      }
    }

    setProducts(res.nextProducts);
    if (res.hasInvalidBarcode) {
      addToast('Validation Warning', res.message, 'warning');
    } else if (res.hasMissingBarcode) {
      addToast('Catalog Re-check Executed', res.message, 'info');
    } else {
      addToast('Catalog Re-check Executed', res.message, 'success');
    }
  };

  const updateStoreProfile = async (updates: Partial<StoreProfile>): Promise<{ success: boolean; error?: string }> => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.updateStoreProfile(updates);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
          return { success: false, error: 'Workspace session changed' };
        }
        if (res.success && res.store) {
          setStoreProfile(res.store);
          addToast('Store Settings Saved', 'Store configuration updated and durably persisted to PostgreSQL.', 'success');
          return { success: true };
        }
        return { success: false, error: 'Failed to update store profile' };
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
          return { success: false, error: 'Workspace session changed' };
        }
        addToast('Settings Save Failed', err.message || 'Failed to update store profile on server.', 'error');
        return { success: false, error: err.message };
      }
    }

    const valRes = validateAndApplyProfileUpdate(storeProfile, updates, isReadOnlyMode);
    if (!valRes.success || !valRes.nextProfile) {
      addToast(
        valRes.errorCode === 'READ_ONLY_MODE' ? 'Settings Locked' : 'Validation Error',
        valRes.message,
        'warning'
      );
      return { success: false, error: valRes.message };
    }

    const proposedProfile = valRes.nextProfile;

    // Failure-safe persistence: attempt to persist before updating in-memory React state
    const saveRes = persistState(products, findings, actionItems, proposedProfile);
    if (!saveRes.success) {
      addToast(
        'Settings Save Failed',
        `Could not persist store settings: ${saveRes.error}`,
        'error'
      );
      return { success: false, error: saveRes.error };
    }

    // Commit new in-memory state ONLY after persistence succeeds
    setStoreProfile(proposedProfile);

    // Truthful durability messaging
    if (saveRes.isDurable) {
      addToast('Store Settings Saved', 'Store configuration updated and durably persisted.', 'success');
    } else {
      addToast('Store Settings Updated (Session Only)', 'Store configuration updated in memory. Persistent local storage is restricted.', 'info');
    }

    return { success: true };
  };

  const toggleConnectorSync = async (connectorId: string): Promise<{ success: boolean; error?: string }> => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.toggleConnector(connectorId);
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
          return { success: false, error: 'Workspace session changed' };
        }
        if (res.success && res.store) {
          setStoreProfile(res.store);
          addToast('Connector Status Updated', 'Connector configuration updated and durably persisted.', 'info');
          return { success: true };
        }
        return { success: false, error: 'Failed to toggle connector' };
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
          return { success: false, error: 'Workspace session changed' };
        }
        addToast('Connector Update Failed', err.message || 'Failed to toggle connector on server.', 'error');
        return { success: false, error: err.message };
      }
    }

    const toggleRes = applyConnectorToggle(storeProfile, connectorId, isReadOnlyMode);
    if (!toggleRes.success || !toggleRes.nextProfile) {
      addToast(
        toggleRes.errorCode === 'READ_ONLY_MODE' ? 'Connector Locked' : 'Integration Unavailable',
        toggleRes.message,
        'warning'
      );
      return { success: false, error: toggleRes.message };
    }

    const proposedProfile = toggleRes.nextProfile;

    // Failure-safe persistence: attempt to persist before updating in-memory React state
    const saveRes = persistState(products, findings, actionItems, proposedProfile);
    if (!saveRes.success) {
      addToast(
        'Connector Update Failed',
        `Could not persist connector status: ${saveRes.error}`,
        'error'
      );
      return { success: false, error: saveRes.error };
    }

    // Commit new in-memory state ONLY after persistence succeeds
    setStoreProfile(proposedProfile);

    if (saveRes.isDurable) {
      addToast('Connector Disconnected', `${toggleRes.message} State durably persisted.`, 'info');
    } else {
      addToast('Connector Disconnected (Session Only)', `${toggleRes.message} Persistent local storage is restricted.`, 'info');
    }

    return { success: true };
  };

  const migrateDemoDataToCloud = async (): Promise<boolean> => {
    if (!isCloudWorkspace) {
      authContext?.openAuthModal?.('register');
      return false;
    }

    const reqGen = cloudRequestGenRef.current;
    const targetWsId = activeWorkspaceId;
    const targetUserId = activeUserId;
    const targetWsName = authContext?.activeWorkspace?.name || 'Workspace';

    try {
      const expectedVersion = catalogVersionRef.current;
      const res = await apiClient.migrateDemoData(expectedVersion);
      if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return false;
      if (res.success) {
        const catRes = await apiClient.getCatalog();
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return false;
        if (
          !isCurrentCloudRequest(reqGen, targetWsId, targetUserId, catRes?.workspaceId, {
            requireResponseWorkspaceId: true,
          })
        ) {
          throw new Error('Workspace catalog response failed validation (missing or mismatched workspaceId).');
        }
        applyCatalogSnapshot(catRes.catalog, targetWsId, targetUserId);
        setReportEntitlement(catRes.reportEntitlement ?? null);
        setPreliminarySummary(catRes.preliminarySummary ?? null);
        const nextVer =
          typeof res.catalogVersion === 'number'
            ? res.catalogVersion
            : catRes.catalog.catalogVersion;
        catalogVersionRef.current = nextVer;
        setCatalogVersion(nextVer);
        setCloudCatalogStatus('loaded');
        addToast(
          'Demo Catalog Imported',
          `Successfully migrated ${res.skuCount} demo products into your cloud workspace "${targetWsName}".`,
          'success'
        );
        return true;
      }
      return false;
    } catch (err: any) {
      if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return false;
      if (err?.status === 409 || err?.code === 'CATALOG_VERSION_CONFLICT') {
        await reloadWorkspaceCatalog();
        addToast(
          'Catalog Version Conflict',
          'Another update modified this workspace catalog before demo migration could apply. The latest server catalog has been reloaded without overwriting data.',
          'warning'
        );
        return false;
      }
      addToast('Migration Failed', err.message || 'Failed to migrate demo data to workspace.', 'error');
      return false;
    }
  };

  const runAudit = async (): Promise<any> => {
    if (isCloudWorkspace) {
      const reqGen = cloudRequestGenRef.current;
      const targetWsId = activeWorkspaceId;
      const targetUserId = activeUserId;
      try {
        const res = await apiClient.runAudit();
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId, (res as any)?.workspaceId)) return null;
        if (res.success && res.catalog) {
          applyCatalogSnapshot(res.catalog, targetWsId, targetUserId);
          setReportEntitlement(res.reportEntitlement ?? null);
          setPreliminarySummary(res.preliminarySummary ?? null);
          setCloudCatalogStatus('loaded');
          const accessNote =
            res.reportEntitlement && !res.reportEntitlement.hasFullReportAccess
              ? ' Preliminary summary ready — upgrade plan to unlock full findings & remediation.'
              : ' Results durably persisted.';
          addToast(
            'Audit Completed',
            `Audit evaluated ${res.auditRun.productsEvaluated} products across ${res.auditRun.rulesEvaluated} rule checks.${accessNote}`,
            res.reportEntitlement && !res.reportEntitlement.hasFullReportAccess ? 'info' : 'success'
          );
          return res.auditRun;
        }
      } catch (err: any) {
        if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) return null;
        if (err?.code === 'REPORT_PAYMENT_REQUIRED' || err?.status === 403) {
          if (err?.reportEntitlement) {
            setReportEntitlement(err.reportEntitlement);
          }
          setPreliminarySummary(null);
          addToast(
            'Paid Plan Required',
            err.message || 'An active paid subscription is required before executing or viewing audit reports.',
            'warning'
          );
          throw err;
        }
        addToast('Audit Failed', err.message || 'Failed to execute audit on server.', 'error');
        throw err;
      }
    }

    // Local / Demo Workspace Mode: Execute domain audit engine on local state
    const auditResult = executeCatalogAudit(products, storeProfile, actionItems);
    const updatedStoreProfile = auditResult.updatedStoreProfile;

    const saveRes = persistState(
      auditResult.updatedProducts,
      auditResult.findings,
      auditResult.actionItems,
      updatedStoreProfile
    );

    if (!saveRes.success) {
      addToast('Persistence Failed', `Could not persist audit results: ${saveRes.error}`, 'error');
      throw new Error(saveRes.error || 'Failed to persist audit results');
    }

    setProducts(auditResult.updatedProducts);
    setFindings(auditResult.findings);
    setActionItems(auditResult.actionItems);
    setStoreProfile(updatedStoreProfile);

    addToast(
      'Audit Synchronized',
      `Audit completed against current catalog (${auditResult.summary.totalProducts} products, ${auditResult.summary.totalFindingsCount} findings indexed).`,
      'success'
    );

    return {
      status: 'COMPLETED',
      productsEvaluated: auditResult.summary.totalProducts,
      rulesEvaluated: auditResult.summary.rulesEvaluated,
      findingsCount: auditResult.summary.totalFindingsCount,
      summary: auditResult.summary,
    };
  };

  const resetToSeedData = () => {
    if (isReadOnlyMode) {
      addToast('Reset Unavailable', 'Catalog cannot be reset while read-only mode is active.', 'warning');
      return;
    }
    storageAdapter.clear();
    setProducts(initialProducts);
    setVariants(initialProducts.flatMap(p => p.variants || []));
    setOffers(initialProducts.flatMap(p => p.offers || []));
    setFindings(initialFindings);
    setActionItems(initialActionItems);
    setEvidence(initialProducts.flatMap(p => p.evidenceDocuments || []));
    setStoreProfile(initialStoreProfile);
    persistState(initialProducts, initialFindings, initialActionItems, initialStoreProfile);
    addToast('Catalog Reset', 'Reset all catalog data to default Solstice seed fixtures.', 'info');
  };

  const reloadWorkspaceCatalog = async () => {
    if (!isCloudWorkspace || !activeWorkspaceId) return;

    const reqGen = ++cloudRequestGenRef.current;
    const targetWsId = activeWorkspaceId;
    const targetUserId = activeUserId;
    const targetIdentity = currentCloudIdentity!;

    setCloudCatalogError(null);
    setCloudCatalogErrorIdentity(null);
    setCloudCatalogStatus('loading');
    try {
      const res = await apiClient.getCatalog();
      if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
        return;
      }
      if (
        !isCurrentCloudRequest(reqGen, targetWsId, targetUserId, res?.workspaceId, {
          requireResponseWorkspaceId: true,
        })
      ) {
        throw new Error('Workspace catalog response failed validation (missing or mismatched workspaceId).');
      }
      applyCatalogSnapshot(res.catalog, targetWsId, targetUserId);
      setReportEntitlement(res.reportEntitlement ?? null);
      setPreliminarySummary(res.preliminarySummary ?? null);
      setCloudCatalogStatus('loaded');
    } catch (err: any) {
      if (!isCurrentCloudRequest(reqGen, targetWsId, targetUserId)) {
        return;
      }
      clearCloudCatalogState(authContext?.activeWorkspace);
      const errMessage = err?.message || 'Failed to reload workspace catalog.';
      setCloudCatalogError(errMessage);
      setCloudCatalogErrorIdentity(targetIdentity);
      setCloudCatalogStatus('error');
      console.error('[AIXSHOP] Failed to reload workspace catalog:', err);
    }
  };

  // Render-time workspace isolation guard: never expose prior workspace/account state
  // even for a single synchronous render frame before useEffect finishes transitioning.
  const isCloudTransitionMismatch =
    isCloudWorkspace && loadedCloudIdentity !== currentCloudIdentity;
  const isLogoutTransitionMismatch = !isCloudWorkspace && loadedCloudIdentity !== null;
  const isStateWorkspaceMismatch = isCloudTransitionMismatch || isLogoutTransitionMismatch;

  const effectiveProducts = isStateWorkspaceMismatch ? [] : products;
  const effectiveVariants = isStateWorkspaceMismatch ? [] : variants;
  const effectiveOffers = isStateWorkspaceMismatch ? [] : offers;
  const effectiveFindings = isStateWorkspaceMismatch ? [] : findings;
  const effectiveActionItems = isStateWorkspaceMismatch ? [] : actionItems;
  const effectiveEvidence = isStateWorkspaceMismatch ? [] : evidence;
  const effectiveStoreProfile = isStateWorkspaceMismatch
    ? buildEmptyCloudStoreProfile(isCloudWorkspace ? authContext?.activeWorkspace : null)
    : storeProfile;
  const effectiveCatalogVersion = isStateWorkspaceMismatch ? undefined : catalogVersion;
  const effectiveLoadedWorkspaceId = isStateWorkspaceMismatch ? null : loadedWorkspaceId;
  const effectiveCloudCatalogError =
    isCloudWorkspace && cloudCatalogErrorIdentity === currentCloudIdentity
      ? cloudCatalogError
      : null;
  const effectiveCloudCatalogStatus: CloudCatalogLoadStatus = isCloudTransitionMismatch
    ? cloudCatalogError && cloudCatalogErrorIdentity === currentCloudIdentity
      ? 'error'
      : 'loading'
    : isLogoutTransitionMismatch
    ? 'idle'
    : cloudCatalogStatus;
  const effectiveSelectedProductId = isStateWorkspaceMismatch ? null : selectedProductId;
  const effectiveSelectedActionId = isStateWorkspaceMismatch ? null : selectedActionId;
  const effectiveSelectedProduct = isStateWorkspaceMismatch ? null : selectedProduct;
  const effectiveQuickCheckResult = isStateWorkspaceMismatch ? null : quickCheckResult;
  const effectiveLastIngestionResult = isStateWorkspaceMismatch ? null : lastIngestionResult;

  const demoOverwriteProtection = useMemo(
    () =>
      evaluateDemoOverwriteProtection({
        isCloudWorkspace,
        cloudCatalogStatus: effectiveCloudCatalogStatus,
        catalogVersion: effectiveCatalogVersion,
        productsCount: effectiveProducts.length,
        variantsCount: effectiveVariants.length,
        offersCount: effectiveOffers.length,
        findingsCount: effectiveFindings.length,
        actionsCount: effectiveActionItems.length,
        evidenceCount: effectiveEvidence.length,
      }),
    [
      isCloudWorkspace,
      effectiveCloudCatalogStatus,
      effectiveCatalogVersion,
      effectiveProducts.length,
      effectiveVariants.length,
      effectiveOffers.length,
      effectiveFindings.length,
      effectiveActionItems.length,
      effectiveEvidence.length,
    ]
  );

  return (
    <AppContext.Provider
      value={{
        currentPage,
        previousPage,
        selectedProductId: effectiveSelectedProductId,
        selectedActionId: effectiveSelectedActionId,
        storeProfile: effectiveStoreProfile,
        products: effectiveProducts,
        variantsCount: effectiveVariants.length,
        offersCount: effectiveOffers.length,
        findings: effectiveFindings,
        actionItems: effectiveActionItems,
        evidenceCount: effectiveEvidence.length,
        toasts,
        quickCheckResult: effectiveQuickCheckResult,
        lastIngestionResult: effectiveLastIngestionResult,
        isCheckingStore,
        selectedProduct: effectiveSelectedProduct,
        mobileMenuOpen,
        isReadOnlyMode,
        readOnlyReason,
        storageLoadResult,
        isDurableStorage: isCloudWorkspace ? true : storageAdapter.isDurable(),
        isCloudWorkspace,
        cloudCatalogStatus: effectiveCloudCatalogStatus,
        loadedWorkspaceId: effectiveLoadedWorkspaceId,
        cloudCatalogError: effectiveCloudCatalogError,
        catalogVersion: effectiveCatalogVersion,
        reportEntitlement: isStateWorkspaceMismatch ? null : reportEntitlement,
        preliminarySummary: isStateWorkspaceMismatch ? null : preliminarySummary,
        selectedSettingsTab,
        demoOverwriteProtection,
        setMobileMenuOpen,
        setSelectedActionId,
        navigateTo,
        viewProductDetail,
        returnFromProductDetail,
        runStoreCheck,
        importDiscoveredProducts,
        approveAction,
        dismissAction,
        recheckAction,
        recheckProduct,
        updateStoreProfile,
        toggleConnectorSync,
        migrateDemoDataToCloud,
        runAudit,
        addToast,
        removeToast,
        resetToSeedData,
        reloadWorkspaceCatalog,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
