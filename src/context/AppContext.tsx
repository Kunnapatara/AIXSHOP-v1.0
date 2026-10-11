import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
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
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
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
    // Simulate real network analysis with explicit demo notification
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
    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    setActionItems(prev => prev.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'approved',
          approvedAt: new Date().toISOString(),
          verificationStatus: 'verified_in_catalog',
          recheckNotes: 'Merchant approved in AIXSHOP. Internal catalog model updated.',
        };
      }
      return act;
    }));

    // Update corresponding finding
    setFindings(prev => prev.map(f => {
      if (f.actionItemId === actionId) {
        return { ...f, merchantVerified: true };
      }
      return f;
    }));

    addToast(
      'Remediation Approved',
      `Approved change for ${item.title}. AIXSHOP internal catalog updated. Note: External live write-back requires connector authorization.`,
      'success'
    );
  };

  const dismissAction = (actionId: string) => {
    setActionItems(prev => prev.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'dismissed',
          dismissedAt: new Date().toISOString(),
          verificationStatus: 'unverified',
        };
      }
      return act;
    }));

    addToast('Action Dismissed', 'Item moved to dismissed queue.', 'info');
  };

  const recheckAction = (actionId: string) => {
    const item = actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status === 'approved') {
      setActionItems(prev => prev.map(act => {
        if (act.id === actionId) {
          return {
            ...act,
            verificationStatus: 'verified_in_catalog',
            lastRecheckTimestamp: new Date().toISOString(),
            recheckNotes: 'Re-check validated against local catalog schema rules: All format requirements met.',
          };
        }
        return act;
      }));
      addToast(
        'Re-check Verified',
        `Catalog consistency confirmed for "${item.title}". Meets schema requirements.`,
        'success'
      );
    } else {
      setActionItems(prev => prev.map(act => {
        if (act.id === actionId) {
          return {
            ...act,
            verificationStatus: 'recheck_required',
            lastRecheckTimestamp: new Date().toISOString(),
            recheckNotes: 'Re-check failed: Action has not been approved or applied yet. Human review required.',
          };
        }
        return act;
      }));
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

    setProducts(prev => prev.map(p => {
      if (p.id === productId) {
        return {
          ...p,
          lastAudited: new Date().toISOString(),
        };
      }
      return p;
    }));

    addToast(
      'Catalog Re-check Executed',
      `Re-analyzed schema consistency for "${prod.title}". Findings updated.`,
      'info'
    );
  };

  const updateStoreProfile = (updates: Partial<StoreProfile>) => {
    setStoreProfile(prev => ({ ...prev, ...updates }));
    addToast('Store Settings Saved', 'Store configuration updated.', 'success');
  };

  const toggleConnectorSync = (connectorId: string) => {
    setStoreProfile(prev => ({
      ...prev,
      connectors: prev.connectors.map(c => {
        if (c.id === connectorId) {
          const newStatus = c.status === 'connected' ? 'disconnected' : 'connected';
          return {
            ...c,
            status: newStatus,
            lastSync: newStatus === 'connected' ? 'Just now' : c.lastSync,
          };
        }
        return c;
      }),
    }));
    addToast('Connector Updated', 'Connector status was modified.', 'info');
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
