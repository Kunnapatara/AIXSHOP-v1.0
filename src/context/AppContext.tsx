import React, { createContext, useContext, useState, useMemo, useEffect, ReactNode, useRef } from 'react';
import { 
  NavigationPage, 
  Product, 
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
import { isValidGtin13 } from '../domain/validation/gtin';
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
import { useAuth } from './AuthContext';
import { apiClient } from '../api/client';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

interface AppContextType {
  currentPage: NavigationPage;
  previousPage: NavigationPage;
  selectedProductId: string | null;
  selectedActionId: string | null;
  storeProfile: StoreProfile;
  products: Product[];
  findings: Finding[];
  actionItems: ActionItem[];
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
  addToast: (title: string, message: string, type?: ToastMessage['type']) => void;
  removeToast: (id: string) => void;
  resetToSeedData: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode; customStorageAdapter?: CatalogStorageAdapter }> = ({ 
  children, 
  customStorageAdapter 
}) => {
  const storageAdapterRef = useRef<CatalogStorageAdapter>(customStorageAdapter || new CatalogStorageAdapter());
  const storageAdapter = storageAdapterRef.current;

  const [currentPage, setCurrentPage] = useState<NavigationPage>('home');
  const [previousPage, setPreviousPage] = useState<NavigationPage>('home');
  const [selectedProductId, setSelectedProductId] = useState<string | null>('prod_solstice_01');
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [storeProfile, setStoreProfile] = useState<StoreProfile>(initialStoreProfile);
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [quickCheckResult, setQuickCheckResult] = useState<QuickHealthCheckResult | null>(null);
  const [lastIngestionResult, setLastIngestionResult] = useState<StoreIngestionResult | null>(null);
  const [isCheckingStore, setIsCheckingStore] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [isReadOnlyMode, setIsReadOnlyMode] = useState<boolean>(false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [storageLoadResult, setStorageLoadResult] = useState<StorageLoadResult | null>(null);

  const isInitializedRef = useRef<boolean>(false);

  // Check auth context safely (null if outside AuthProvider in test environments)
  let authContext: any = null;
  try {
    authContext = useAuth();
  } catch {
    authContext = null;
  }

  const isCloudWorkspace = Boolean(authContext?.isAuthenticated && authContext?.activeWorkspace);
  const activeWorkspaceId = authContext?.activeWorkspace?.id;

  const addToast = (title: string, message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    setToasts(prev => [...prev, { id, title, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
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

  // Hydrate: Cloud API if authenticated in active workspace; otherwise local storage adapter
  useEffect(() => {
    if (!isCloudWorkspace) {
      if (!isInitializedRef.current) {
        isInitializedRef.current = true;
        const result = storageAdapter.load();
        setStorageLoadResult(result);

        if (result.type === 'valid') {
          const p = result.envelope.payload;
          setProducts(p.products);
          setFindings(p.findings);
          setActionItems(p.actions);
          setStoreProfile(p.storeProfile);
          addToast('Demo Session Loaded', 'Your local demo workspace catalog has been loaded.', 'info');
        } else if (result.type === 'not_found') {
          persistState(initialProducts, initialFindings, initialActionItems, initialStoreProfile);
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
      }
      return;
    }

    // Authenticated Cloud Workspace mode: Load from backend API
    let isCancelled = false;
    async function loadCloudCatalog() {
      try {
        const res = await apiClient.getCatalog();
        if (isCancelled) return;
        setProducts(res.catalog.products);
        setFindings(res.catalog.findings);
        setActionItems(res.catalog.actions);
        setStoreProfile(res.catalog.storeProfile);
        setIsReadOnlyMode(false);
        setReadOnlyReason(null);
        addToast(
          'Workspace Connected',
          `Loaded catalog for workspace "${authContext.activeWorkspace.name}". Data is durably persisted to PostgreSQL.`,
          'success'
        );
      } catch (err: any) {
        if (isCancelled) return;
        console.error('[AIXSHOP Cloud] Failed to load workspace catalog:', err);
        addToast(
          'Cloud Catalog Error',
          err.message || 'Failed to load catalog from server. Local state preserved.',
          'error'
        );
      }
    }

    loadCloudCatalog();
    return () => {
      isCancelled = true;
    };
  }, [isCloudWorkspace, activeWorkspaceId]);

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
    setIsCheckingStore(true);
    try {
      const result = await ingestAndAnalyzeStore(url, { existingCatalog: products });
      setQuickCheckResult(result);
      if (result.ingestionResult) {
        setLastIngestionResult(result.ingestionResult);
      }

      if (result.scanStatus === 'demo_fixture') {
        addToast(
          'Demo Store Check Complete',
          `Evaluated Solstice Mercantile demo catalog (${result.catalogCompletenessEstimate}% completeness, ${result.gtinPresentRatio}% GTIN coverage).`,
          'info'
        );
      } else if (result.scanStatus === 'real_scan') {
        addToast(
          'Live Store Scan Complete',
          `Parsed public product feed (${result.catalogCompletenessEstimate}% completeness, ${result.gtinPresentRatio}% GTIN coverage).`,
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
      addToast('Scan Error', (e as Error).message || 'Failed to inspect store.', 'error');
    } finally {
      setIsCheckingStore(false);
    }
  };

  const importDiscoveredProducts = async (): Promise<CatalogImportResult | null> => {
    if (!lastIngestionResult || !lastIngestionResult.candidateProducts.length) {
      addToast('No Products Discovered', 'Run a store check first to discover products for import.', 'warning');
      return null;
    }

    if (isCloudWorkspace) {
      try {
        const res = await apiClient.importCatalog(lastIngestionResult.candidateProducts);
        if (res.success && res.result) {
          const catRes = await apiClient.getCatalog();
          setProducts(catRes.catalog.products);
          setFindings(catRes.catalog.findings);
          setActionItems(catRes.catalog.actions);
          setStoreProfile(catRes.catalog.storeProfile);
          addToast('Catalog Import Complete', res.result.message, 'success');
          return res.result;
        }
        return null;
      } catch (err: any) {
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
      try {
        const res = await apiClient.approveAction(actionId, customApprovedValue);
        if (res.success && res.action) {
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          if (res.product) {
            setProducts(prev => prev.map(p => p.id === res.product!.id ? res.product! : p));
          }
          addToast('Remediation Approved', 'Action successfully approved and durably persisted to PostgreSQL.', 'success');
        }
      } catch (err: any) {
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
      try {
        const res = await apiClient.dismissAction(actionId);
        if (res.success && res.action) {
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          addToast('Action Dismissed', 'Action dismissed and durably persisted.', 'info');
        }
      } catch (err: any) {
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
      try {
        const res = await apiClient.recheckAction(actionId);
        if (res.success && res.action) {
          setActionItems(prev => prev.map(a => a.id === actionId ? res.action : a));
          addToast('Action Re-checked', 'Action evaluated and durably updated.', 'info');
        }
      } catch (err: any) {
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

  const recheckProduct = (productId: string) => {
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

    const saveRes = persistState(res.nextProducts, findings, actionItems, storeProfile);
    if (!saveRes.success) {
      addToast('Persistence Failed', `Could not persist product audit: ${saveRes.error}`, 'error');
      return;
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
      try {
        const res = await apiClient.updateStoreProfile(updates);
        if (res.success && res.store) {
          setStoreProfile(res.store);
          addToast('Store Settings Saved', 'Store configuration updated and durably persisted to PostgreSQL.', 'success');
          return { success: true };
        }
        return { success: false, error: 'Failed to update store profile' };
      } catch (err: any) {
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
      try {
        const res = await apiClient.toggleConnector(connectorId);
        if (res.success && res.store) {
          setStoreProfile(res.store);
          addToast('Connector Status Updated', 'Connector configuration updated and durably persisted.', 'info');
          return { success: true };
        }
        return { success: false, error: 'Failed to toggle connector' };
      } catch (err: any) {
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

    try {
      const res = await apiClient.migrateDemoData();
      if (res.success) {
        const catRes = await apiClient.getCatalog();
        setProducts(catRes.catalog.products);
        setFindings(catRes.catalog.findings);
        setActionItems(catRes.catalog.actions);
        setStoreProfile(catRes.catalog.storeProfile);
        addToast(
          'Demo Catalog Imported',
          `Successfully migrated ${res.skuCount} demo products into your cloud workspace "${authContext.activeWorkspace.name}".`,
          'success'
        );
        return true;
      }
      return false;
    } catch (err: any) {
      addToast('Migration Failed', err.message || 'Failed to migrate demo data to workspace.', 'error');
      return false;
    }
  };

  const resetToSeedData = () => {
    if (isReadOnlyMode) {
      addToast('Reset Unavailable', 'Catalog cannot be reset while read-only mode is active.', 'warning');
      return;
    }
    storageAdapter.clear();
    setProducts(initialProducts);
    setFindings(initialFindings);
    setActionItems(initialActionItems);
    setStoreProfile(initialStoreProfile);
    persistState(initialProducts, initialFindings, initialActionItems, initialStoreProfile);
    addToast('Catalog Reset', 'Reset all catalog data to default Solstice seed fixtures.', 'info');
  };

  return (
    <AppContext.Provider
      value={{
        currentPage,
        previousPage,
        selectedProductId,
        selectedActionId,
        storeProfile,
        products,
        findings,
        actionItems,
        toasts,
        quickCheckResult,
        lastIngestionResult,
        isCheckingStore,
        selectedProduct,
        mobileMenuOpen,
        isReadOnlyMode,
        readOnlyReason,
        storageLoadResult,
        isDurableStorage: isCloudWorkspace ? true : storageAdapter.isDurable(),
        isCloudWorkspace,
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
        addToast,
        removeToast,
        resetToSeedData,
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
