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
import { isValidGtin13 } from '../domain/validation/gtin';

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
  isCheckingStore: boolean;
  selectedProduct: Product | null;
  mobileMenuOpen: boolean;
  isReadOnlyMode: boolean;
  readOnlyReason: string | null;
  storageLoadResult: StorageLoadResult | null;
  isDurableStorage: boolean;
  setMobileMenuOpen: (open: boolean) => void;
  setSelectedActionId: (id: string | null) => void;
  navigateTo: (page: NavigationPage, entityId?: string, fromPage?: NavigationPage) => void;
  viewProductDetail: (productId: string, fromPage?: NavigationPage) => void;
  returnFromProductDetail: () => void;
  runStoreCheck: (url: string) => Promise<void>;
  approveAction: (actionId: string, customApprovedValue?: string) => void;
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
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
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
      addToast('Session Restored', 'Your verified catalog workspace has been loaded.', 'info');
    } else if (result.type === 'not_found') {
      // First boot: save initial seed envelope
      persistState(initialProducts, initialFindings, initialActionItems, initialStoreProfile);
    } else if (result.type === 'corrupt') {
      // Technical diagnostic in console for developers
      console.warn(`[AIXSHOP Storage] Corrupted local data detected and preserved in backup: ${result.backupKey}`);
      addToast(
        'Workspace Restored',
        'A problem was detected with local session data. Your workspace has been safely restored with default catalog items.',
        'warning'
      );
    } else if (result.type === 'unsupported_version') {
      // Technical diagnostic in console for developers
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
  }, []);

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

  const approveAction = (actionId: string, customApprovedValue?: string) => {
    if (isReadOnlyMode) {
      addToast('Action Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
      return;
    }

    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status !== 'pending_review') {
      addToast('Action Ineligible', `Action "${item.title}" is already ${item.status.replace(/_/g, ' ')}.`, 'info');
      return;
    }

    const valueToApply = customApprovedValue !== undefined && customApprovedValue.trim() !== ''
      ? customApprovedValue
      : item.proposedChange.to;

    const nextActions = actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'approved' as const,
          approvedAt: new Date().toISOString(),
          proposedChange: {
            ...act.proposedChange,
            to: valueToApply,
          },
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

    // Update target product specification in the catalog if action targets a product
    let nextProducts = products;
    if (item.productId) {
      const targetExists = products.some(prod => prod.id === item.productId);
      if (!targetExists) {
        addToast(
          'Target Not Found',
          `Cannot approve action: Target product "${item.productId}" was not found in catalog.`,
          'error'
        );
        return;
      }

      nextProducts = products.map(prod => {
        if (prod.id !== item.productId) return prod;

        const updatedProd = { ...prod };
        const changeField = item.proposedChange.field;

        if (changeField.startsWith('variants[') && changeField.includes('barcode')) {
          // Parse index if specified, e.g. variants[0].barcode
          const match = changeField.match(/variants\[(\d+)\]/);
          const targetIndex = match ? parseInt(match[1], 10) : 0;
          updatedProd.variants = prod.variants.map((v, idx) => {
            if (idx === targetIndex || (!v.barcode && idx === 0)) {
              return { ...v, barcode: valueToApply };
            }
            return v;
          });
        } else if (changeField.startsWith('attributes.')) {
          const attrKey = changeField.replace('attributes.', '');
          updatedProd.attributes = {
            ...prod.attributes,
            [attrKey]: valueToApply,
          };
        } else if (changeField.includes('title')) {
          // Marketing claim reconciliation
          updatedProd.attributes = {
            ...prod.attributes,
            verifiedBurnTime: valueToApply,
          };
        }

        // Increment completeness score upon verified remediation without exceeding 100
        updatedProd.completenessScore = Math.min(100, prod.completenessScore + 6);
        return updatedProd;
      });
      setProducts(nextProducts);
    }

    setActionItems(nextActions);
    setFindings(nextFindings);
    const saveRes = persistState(nextProducts, nextFindings, nextActions, storeProfile);

    if (saveRes && !saveRes.success) {
      addToast(
        'Action Approved (Session Only)',
        `Approved ${item.title}. Warning: Persistence to storage failed (${saveRes.error}).`,
        'warning'
      );
    } else {
      addToast(
        'Remediation Approved',
        `Approved change for ${item.title}. AIXSHOP internal catalog updated. Note: External live write-back requires connector authorization.`,
        'success'
      );
    }
  };

  const dismissAction = (actionId: string) => {
    if (isReadOnlyMode) {
      addToast('Action Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
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
    if (isReadOnlyMode) {
      addToast('Re-check Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
      return;
    }

    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status !== 'approved') {
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
      return;
    }

    // Execute genuine validation against catalog data
    let isValid = true;
    let failureReason = '';

    if (item.productId) {
      const targetProd = products.find(p => p.id === item.productId);
      if (!targetProd) {
        isValid = false;
        failureReason = `Target product "${item.productId}" not found in catalog.`;
      } else {
        const changeField = item.proposedChange.field;
        const expectedValue = item.proposedChange.to;

        if (changeField.startsWith('variants[') && changeField.includes('barcode')) {
          const match = changeField.match(/variants\[(\d+)\]/);
          const targetIndex = match ? parseInt(match[1], 10) : 0;
          const targetVariant = targetProd.variants[targetIndex] || targetProd.variants[0];

          if (!targetVariant || targetVariant.barcode !== expectedValue) {
            isValid = false;
            failureReason = `Variant barcode does not match approved value (${targetVariant?.barcode || 'empty'}).`;
          } else if (!isValidGtin13(targetVariant.barcode)) {
            isValid = false;
            failureReason = `Variant barcode "${targetVariant.barcode}" fails GTIN-13 check digit validation.`;
          }
        } else if (changeField.startsWith('attributes.')) {
          const attrKey = changeField.replace('attributes.', '');
          const currentVal = targetProd.attributes[attrKey];
          if (currentVal !== expectedValue) {
            isValid = false;
            failureReason = `Attribute "${attrKey}" does not match approved value.`;
          }
        } else if (changeField.includes('title')) {
          if (targetProd.attributes.verifiedBurnTime !== expectedValue) {
            isValid = false;
            failureReason = 'Specification claim reconciliation not found in attributes.';
          }
        }
      }
    }

    const nextVerificationStatus = isValid ? ('verified_in_catalog' as const) : ('verification_failed' as const);
    const recheckNotes = isValid
      ? 'Re-check validated against local catalog schema rules: All format requirements met.'
      : `Re-check failed: ${failureReason}`;

    const nextActions = actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          verificationStatus: nextVerificationStatus,
          lastRecheckTimestamp: new Date().toISOString(),
          recheckNotes,
        };
      }
      return act;
    });

    setActionItems(nextActions);
    persistState(products, findings, nextActions, storeProfile);

    if (isValid) {
      addToast(
        'Re-check Verified',
        `Catalog consistency confirmed for "${item.title}". Meets schema requirements.`,
        'success'
      );
    } else {
      addToast(
        'Re-check Failed',
        `Verification failed for "${item.title}": ${failureReason}`,
        'error'
      );
    }
  };

  const recheckProduct = (productId: string) => {
    if (isReadOnlyMode) {
      addToast('Re-check Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
      return;
    }

    const prod = products.find(p => p.id === productId);
    if (!prod) {
      addToast('Error', 'Product not found for re-check', 'error');
      return;
    }

    const hasInvalidBarcode = prod.variants.some(v => v.barcode && !isValidGtin13(v.barcode));
    const hasMissingBarcode = prod.variants.some(v => !v.barcode);

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

    if (hasInvalidBarcode) {
      addToast(
        'Validation Warning',
        `Variant on "${prod.title}" has invalid GTIN check digit.`,
        'warning'
      );
    } else if (hasMissingBarcode) {
      addToast(
        'Catalog Re-check Executed',
        `Re-analyzed schema consistency for "${prod.title}". Missing GTIN detected on variant.`,
        'info'
      );
    } else {
      addToast(
        'Catalog Re-check Executed',
        `Re-analyzed schema consistency for "${prod.title}". All variant identifiers valid.`,
        'success'
      );
    }
  };

  const updateStoreProfile = (updates: Partial<StoreProfile>) => {
    if (isReadOnlyMode) {
      addToast('Settings Locked', 'Store settings cannot be changed while read-only mode is active.', 'warning');
      return;
    }
    const nextProfile = { ...storeProfile, ...updates };
    setStoreProfile(nextProfile);
    persistState(products, findings, actionItems, nextProfile);
    addToast('Store Settings Saved', 'Store configuration updated and persisted.', 'success');
  };

  const toggleConnectorSync = (connectorId: string) => {
    if (isReadOnlyMode) {
      addToast('Connector Locked', 'Connectors cannot be modified while read-only mode is active.', 'warning');
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
        isCheckingStore,
        selectedProduct,
        mobileMenuOpen,
        isReadOnlyMode,
        readOnlyReason,
        storageLoadResult,
        isDurableStorage: storageAdapter.isDurable(),
        setMobileMenuOpen,
        setSelectedActionId,
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
