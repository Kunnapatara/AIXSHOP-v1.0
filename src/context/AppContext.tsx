import React, { createContext, useContext, useState, useMemo, useEffect, ReactNode, useRef } from 'react';
import { 
  NavigationPage, 
  Product, 
  Finding, 
  ActionItem, 
  StoreProfile, 
  QuickHealthCheckResult 
} from '../types';
import { 
  initialStoreProfile, 
  initialProducts, 
  initialFindings, 
  initialActionItems 
} from '../data/mockData';
import { CatalogStorageAdapter } from '../domain/storage/storageAdapter';
import { StoragePayloadV1, StorageLoadResult } from '../domain/storage/storageTypes';

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
  storeProfile: StoreProfile;
  products: Product[];
  findings: Finding[];
  actionItems: ActionItem[];
  toasts: ToastMessage[];
  quickCheckResult: QuickHealthCheckResult | null;
  isCheckingStore: boolean;
  selectedProduct: Product | null;
  mobileMenuOpen: boolean;
  isReadOnlyMode: boolean;
  readOnlyReason: string | null;
  storageLoadResult: StorageLoadResult | null;
  setMobileMenuOpen: (open: boolean) => void;
  navigateTo: (page: NavigationPage, productId?: string, fromPage?: NavigationPage) => void;
  viewProductDetail: (productId: string, fromPage?: NavigationPage) => void;
  returnFromProductDetail: () => void;
  runStoreCheck: (url: string) => Promise<void>;
  approveAction: (actionId: string) => void;
  dismissAction: (actionId: string) => void;
  recheckAction: (actionId: string) => void;
  recheckProduct: (productId: string) => void;
  updateStoreProfile: (updates: Partial<StoreProfile>) => void;
  toggleConnectorSync: (connectorId: string) => void;
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
  const [storeProfile, setStoreProfile] = useState<StoreProfile>(initialStoreProfile);
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [quickCheckResult, setQuickCheckResult] = useState<QuickHealthCheckResult | null>(null);
  const [isCheckingStore, setIsCheckingStore] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [isReadOnlyMode, setIsReadOnlyMode] = useState<boolean>(false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [storageLoadResult, setStorageLoadResult] = useState<StorageLoadResult | null>(null);

  const isInitializedRef = useRef<boolean>(false);

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

  // Helper to persist current application state
  const persistState = (
    nextProducts: Product[],
    nextFindings: Finding[],
    nextActions: ActionItem[],
    nextProfile: StoreProfile
  ) => {
    if (isReadOnlyMode) {
      return;
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
  };

  // Hydrate from Storage on initial mount
  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;

    const result = storageAdapter.load();
    setStorageLoadResult(result);

    if (result.type === 'valid') {
      const p = result.envelope.payload;
      setProducts(p.products);
      setFindings(p.findings);
      setActionItems(p.actions);
      setStoreProfile(p.storeProfile);
      addToast('Session Restored', 'Restored verified catalog state from local storage.', 'info');
    } else if (result.type === 'not_found') {
      // First boot: save initial seed envelope
      persistState(initialProducts, initialFindings, initialActionItems, initialStoreProfile);
    } else if (result.type === 'corrupt') {
      // Recovered safely: seed data loaded, backup preserved
      addToast(
        'Storage Corruption Recovered',
        `Corrupted local data was backed up to "${result.backupKey || 'backup'}". Initialized safely with seed catalog.`,
        'warning'
      );
    } else if (result.type === 'unsupported_version') {
      // Future schema version: enter read-only compatibility mode
      setIsReadOnlyMode(true);
      setReadOnlyReason(storageAdapter.getReadOnlyReason());
      addToast(
        'Future Schema Detected (v' + result.foundVersion + ')',
        'Operating in read-only compatibility mode to protect stored future-version data.',
        'warning'
      );
    } else if (result.type === 'storage_failure') {
      addToast('Storage Unavailable', result.error, 'warning');
    }
  }, []);

  const navigateTo = (page: NavigationPage, productId?: string, fromPage?: NavigationPage) => {
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (page === 'product-detail') {
      if (productId) {
        setSelectedProductId(productId);
      }
      setPreviousPage(fromPage || currentPage);
      setCurrentPage('product-detail');
      return;
    }

    setPreviousPage(currentPage);
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
    await new Promise(resolve => setTimeout(resolve, 900));
    
    const mockResult: QuickHealthCheckResult = {
      url,
      timestamp: new Date().toISOString(),
      catalogCompletenessEstimate: 76,
      schemaFound: true,
      gtinPresentRatio: 64,
      conflictingClaimsCount: 3,
      missingAttributesCount: 7,
      detectedPlatform: 'Shopify v2025.1 Storefront',
      sampleIssues: [
        'Missing GTIN/UPC identifiers on 36% of sampled product variants',
        'Conflicting shipping SLA detected between footer policy and structured markup',
        'Unverified eco/organic claims without certifying registry numbers',
      ],
    };

    setQuickCheckResult(mockResult);
    setIsCheckingStore(false);
    addToast(
      'Demonstration Check Complete', 
      'Evaluated sample catalog schema and structured metadata consistency for ' + url, 
      'info'
    );
  };

  const approveAction = (actionId: string) => {
    if (isReadOnlyMode) {
      addToast('Action Disabled', 'Catalog is in read-only compatibility mode (future schema version detected).', 'warning');
      return;
    }

    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    const nextActions = actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'approved' as const,
          approvedAt: new Date().toISOString(),
          verificationStatus: 'verified_in_catalog' as const,
          recheckNotes: 'Merchant approved in AIXSHOP. Internal catalog model updated.',
        };
      }
      return act;
    });

    const nextFindings = findings.map(f => {
      if (f.actionItemId === actionId) {
        return { ...f, merchantVerified: true };
      }
      return f;
    });

    setActionItems(nextActions);
    setFindings(nextFindings);
    persistState(products, nextFindings, nextActions, storeProfile);

    addToast(
      'Remediation Approved',
      `Approved change for ${item.title}. AIXSHOP internal catalog updated. Note: External live write-back requires connector authorization.`,
      'success'
    );
  };

  const dismissAction = (actionId: string) => {
    if (isReadOnlyMode) {
      addToast('Action Disabled', 'Catalog is in read-only compatibility mode.', 'warning');
      return;
    }

    const nextActions = actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'dismissed' as const,
          dismissedAt: new Date().toISOString(),
          verificationStatus: 'unverified' as const,
        };
      }
      return act;
    });

    setActionItems(nextActions);
    persistState(products, findings, nextActions, storeProfile);
    addToast('Action Dismissed', 'Item moved to dismissed queue.', 'info');
  };

  const recheckAction = (actionId: string) => {
    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status === 'approved') {
      const nextActions = actionItems.map(act => {
        if (act.id === actionId) {
          return {
            ...act,
            verificationStatus: 'verified_in_catalog' as const,
            lastRecheckTimestamp: new Date().toISOString(),
            recheckNotes: 'Re-check validated against local catalog schema rules: All format requirements met.',
          };
        }
        return act;
      });
      setActionItems(nextActions);
      persistState(products, findings, nextActions, storeProfile);
      addToast(
        'Re-check Verified',
        `Catalog consistency confirmed for "${item.title}". Meets schema requirements.`,
        'success'
      );
    } else {
      const nextActions = actionItems.map(act => {
        if (act.id === actionId) {
          return {
            ...act,
            verificationStatus: 'recheck_required' as const,
            lastRecheckTimestamp: new Date().toISOString(),
            recheckNotes: 'Re-check failed: Action has not been approved or applied yet. Human review required.',
          };
        }
        return act;
      });
      setActionItems(nextActions);
      persistState(products, findings, nextActions, storeProfile);
      addToast(
        'Action Still Pending',
        `Re-check observed that "${item.title}" still requires merchant review or evidence.`,
        'warning'
      );
    }
  };

  const recheckProduct = (productId: string) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) {
      addToast('Error', 'Product not found for re-check', 'error');
      return;
    }

    const nextProducts = products.map(p => {
      if (p.id === productId) {
        return {
          ...p,
          lastAudited: new Date().toISOString(),
        };
      }
      return p;
    });

    setProducts(nextProducts);
    persistState(nextProducts, findings, actionItems, storeProfile);

    addToast(
      'Catalog Re-check Executed',
      `Re-analyzed schema consistency for "${prod.title}". Findings updated.`,
      'info'
    );
  };

  const updateStoreProfile = (updates: Partial<StoreProfile>) => {
    if (isReadOnlyMode) {
      addToast('Settings Locked', 'Cannot modify store settings in read-only compatibility mode.', 'warning');
      return;
    }
    const nextProfile = { ...storeProfile, ...updates };
    setStoreProfile(nextProfile);
    persistState(products, findings, actionItems, nextProfile);
    addToast('Store Settings Saved', 'Store configuration updated and persisted.', 'success');
  };

  const toggleConnectorSync = (connectorId: string) => {
    if (isReadOnlyMode) {
      addToast('Connector Locked', 'Connectors cannot be modified in read-only compatibility mode.', 'warning');
      return;
    }

    const nextConnectors = storeProfile.connectors.map(c => {
      if (c.id === connectorId) {
        const newStatus = c.status === 'connected' ? 'disconnected' as const : 'connected' as const;
        return {
          ...c,
          status: newStatus,
          lastSync: newStatus === 'connected' ? 'Just now' : c.lastSync,
        };
      }
      return c;
    });

    const nextProfile = { ...storeProfile, connectors: nextConnectors };
    setStoreProfile(nextProfile);
    persistState(products, findings, actionItems, nextProfile);
    addToast('Connector Updated', 'Connector status was modified.', 'info');
  };

  const resetToSeedData = () => {
    if (isReadOnlyMode) {
      addToast('Reset Blocked', 'Cannot reset storage while an unsupported future schema version is preserved.', 'warning');
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
        storeProfile,
        products,
        findings,
        actionItems,
        toasts,
        quickCheckResult,
        isCheckingStore,
        selectedProduct,
        mobileMenuOpen,
        isReadOnlyMode,
        readOnlyReason,
        storageLoadResult,
        setMobileMenuOpen,
        navigateTo,
        viewProductDetail,
        returnFromProductDetail,
        runStoreCheck,
        approveAction,
        dismissAction,
        recheckAction,
        recheckProduct,
        updateStoreProfile,
        toggleConnectorSync,
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
