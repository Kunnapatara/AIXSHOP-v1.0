import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { 
  Settings, 
  Store, 
  Layers, 
  CreditCard, 
  ShieldCheck, 
  Radio, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Database,
  ExternalLink,
  Save,
  Lock,
  Terminal,
  RefreshCw,
  Building2,
  User,
  ArrowRight,
  UploadCloud,
  ShoppingBag,
  Link2,
  Unlink,
  Zap,
  Check
} from 'lucide-react';
import {
  apiClient,
  BillingPlan,
  BillingSubscriptionResponse,
  PlanTier,
  ShopifyStatusResponse,
} from '../api/client';
import {
  isValidBillingRedirectUrl,
  isValidExternalHttpUrl,
  isValidShopifyAuthUrl,
  redirectBrowser,
  validateAndNormalizeShopDomain,
} from '../domain/validation/shopify';
import {
  evaluateDemoOverwriteProtection,
  CloudCatalogLoadStatus,
  DemoOverwriteProtectionEvaluation,
} from '../domain/catalog/demoMigrationProtection';

export interface DemoCatalogMigrationSectionProps {
  isAuthenticated: boolean;
  openAuthModal: (mode?: 'login' | 'register') => void;
  overwriteProtection: DemoOverwriteProtectionEvaluation;
  confirmingDemoOverwrite: boolean;
  setConfirmingDemoOverwrite: (next: boolean) => void;
  isMigratingDemo: boolean;
  setIsMigratingDemo: (next: boolean) => void;
  cloudCatalogStatus?: CloudCatalogLoadStatus;
  catalogVersion?: number;
  migrateDemoDataToCloud: () => Promise<boolean>;
  reloadWorkspaceCatalog: () => Promise<void>;
}

export const DemoCatalogMigrationSection: React.FC<DemoCatalogMigrationSectionProps> = ({
  isAuthenticated,
  openAuthModal,
  overwriteProtection,
  confirmingDemoOverwrite,
  setConfirmingDemoOverwrite,
  isMigratingDemo,
  setIsMigratingDemo,
  cloudCatalogStatus,
  catalogVersion,
  migrateDemoDataToCloud,
  reloadWorkspaceCatalog,
}) => (
  <div className="border border-stone-200 rounded-xl p-4 bg-white space-y-3">
    <div className="flex items-center gap-2">
      <UploadCloud className="w-4 h-4 text-orange-600" />
      <h4 className="text-xs font-bold text-stone-900">Demo Catalog Migration Path</h4>
    </div>
    <p className="text-xs text-stone-600 leading-relaxed">
      Import the verified Solstice Mercantile demo catalog fixtures (184 products, variants, commercial offers, audit findings, remediation actions, and evidence documents) directly into your cloud workspace database for evaluation.
    </p>
    {confirmingDemoOverwrite ? (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2.5">
        {overwriteProtection.isUnknownState ? (
          <p className="text-xs text-amber-900 font-medium leading-relaxed">
            The active cloud workspace catalog state has not finished loading or failed to verify (status:{' '}
            <span className="font-mono">{cloudCatalogStatus ?? 'unknown'}</span>). Proceeding will replace all 6 workspace catalog collections (products, variants, offers, findings, actions, and evidence) with demo fixtures or be rejected with a 409 conflict if the workspace was already initialized. Reload the catalog first or confirm explicit replacement below.
          </p>
        ) : (
          <p className="text-xs text-amber-900 font-medium leading-relaxed">
            {overwriteProtection.nonEmptyCategories.length > 0
              ? `Your active cloud workspace currently contains ${overwriteProtection.nonEmptyCategories
                  .map(c => `${c.count} ${c.label}`)
                  .join(', ')}. `
              : `Your active cloud workspace catalog is already initialized (version ${catalogVersion ?? 1}). `}
            Demo catalog migration replaces all 6 collections (products, variants, offers, findings, actions, and evidence) using optimistic version verification and rejects automatically if another session updates the catalog first.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {overwriteProtection.isUnknownState && (
            <button
              type="button"
              disabled={isMigratingDemo}
              onClick={async () => {
                await reloadWorkspaceCatalog();
              }}
              className="px-3.5 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              Reload Catalog State
            </button>
          )}
          <button
            type="button"
            disabled={isMigratingDemo}
            onClick={async () => {
              setIsMigratingDemo(true);
              try {
                await migrateDemoDataToCloud();
              } finally {
                setIsMigratingDemo(false);
                setConfirmingDemoOverwrite(false);
              }
            }}
            className="px-3.5 py-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isMigratingDemo ? 'Replacing Catalog...' : 'Confirm Replace Workspace Catalog'}
          </button>
          <button
            type="button"
            disabled={isMigratingDemo}
            onClick={() => setConfirmingDemoOverwrite(false)}
            className="px-3.5 py-1.5 bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <button
        type="button"
        disabled={isMigratingDemo}
        onClick={async () => {
          if (!isAuthenticated) {
            openAuthModal('register');
            return;
          }
          if (overwriteProtection.requiresConfirmation) {
            setConfirmingDemoOverwrite(true);
            return;
          }
          setIsMigratingDemo(true);
          try {
            await migrateDemoDataToCloud();
          } finally {
            setIsMigratingDemo(false);
          }
        }}
        className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-2 disabled:opacity-50 cursor-pointer"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isMigratingDemo ? 'animate-spin' : ''}`} />
        <span>{isMigratingDemo ? 'Importing Fixtures...' : 'Import Demo Catalog into Active Workspace'}</span>
      </button>
    )}
  </div>
);

export type SettingsTabId = 'profile' | 'workspace' | 'connectors' | 'subscription' | 'policies' | 'diagnostics';

function resolveInitialSettingsTab(propInitialTab?: SettingsTabId): SettingsTabId {
  if (propInitialTab) {
    return propInitialTab;
  }
  if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
    try {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (
        tabParam === 'profile' ||
        tabParam === 'workspace' ||
        tabParam === 'connectors' ||
        tabParam === 'subscription' ||
        tabParam === 'policies' ||
        tabParam === 'diagnostics'
      ) {
        return tabParam;
      }
      if (params.has('shopify') || params.has('shopify_error')) {
        return 'connectors';
      }
      if (params.has('checkout') || params.has('session_id')) {
        return 'subscription';
      }
    } catch {
      // Ignore query parsing errors in restricted hosts
    }
  }
  return 'profile';
}

function getTierMonthlyPriceLabel(tier?: string, authoritativePlan?: BillingPlan | null): string {
  if (authoritativePlan && typeof authoritativePlan.priceCents === 'number') {
    const amount = authoritativePlan.priceCents / 100;
    const symbol = authoritativePlan.currency?.toUpperCase() === 'EUR' ? '€' : authoritativePlan.currency?.toUpperCase() === 'GBP' ? '£' : '$';
    const formattedAmount = `${symbol}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
    if (authoritativePlan.billingInterval === 'none' || authoritativePlan.priceCents === 0) {
      return formattedAmount;
    }
    const interval = authoritativePlan.billingInterval === 'year' ? 'yr' : 'mo';
    return `${formattedAmount} / ${interval}`;
  }
  const normalized = (tier || '').toLowerCase();
  if (normalized.includes('enterprise')) return '$499 / mo';
  if (normalized.includes('growth')) return '$149 / mo';
  if (normalized.includes('starter')) return '$49 / mo';
  return '$0';
}

function formatSubscriptionDate(iso?: string): string | null {
  if (!iso || typeof iso !== 'string') return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString();
}

export const SettingsPage: React.FC<{ initialTab?: SettingsTabId }> = ({ initialTab }) => {
  const { 
    storeProfile, 
    updateStoreProfile, 
    toggleConnectorSync, 
    addToast,
    isReadOnlyMode,
    isDurableStorage,
    isCloudWorkspace,
    migrateDemoDataToCloud,
    products,
    variantsCount,
    offersCount,
    findings,
    actionItems,
    evidenceCount,
    cloudCatalogStatus,
    catalogVersion,
    demoOverwriteProtection,
    reloadWorkspaceCatalog,
    selectedSettingsTab
  } = useApp();

  const overwriteProtection =
    demoOverwriteProtection ??
    evaluateDemoOverwriteProtection({
      isCloudWorkspace,
      cloudCatalogStatus: cloudCatalogStatus ?? 'idle',
      catalogVersion,
      productsCount: products?.length ?? 0,
      variantsCount: variantsCount ?? 0,
      offersCount: offersCount ?? 0,
      findingsCount: findings?.length ?? 0,
      actionsCount: actionItems?.length ?? 0,
      evidenceCount: evidenceCount ?? 0,
    });

  const {
    user,
    activeWorkspace,
    workspaces,
    isAuthenticated,
    openAuthModal,
    switchWorkspace
  } = useAuth();

  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => resolveInitialSettingsTab(initialTab));
  const [storeName, setStoreName] = useState(storeProfile.name);
  const [storeDomain, setStoreDomain] = useState(storeProfile.domain);
  const [currency, setCurrency] = useState(storeProfile.currency);
  const [strictness, setStrictness] = useState(storeProfile.truthBoundaryStrictness);
  const [isDiagnosticsUnlocked, setIsDiagnosticsUnlocked] = useState(false);
  const [isMigratingDemo, setIsMigratingDemo] = useState(false);
  const [confirmingDemoOverwrite, setConfirmingDemoOverwrite] = useState(false);

  // Shopify Integration State
  const [shopifyStatus, setShopifyStatus] = useState<ShopifyStatusResponse | null>(null);
  const [shopifySyncRuns, setShopifySyncRuns] = useState<any[]>([]);
  const [isLoadingShopify, setIsLoadingShopify] = useState(false);
  const [isConnectingShopify, setIsConnectingShopify] = useState(false);
  const [isSyncingShopify, setIsSyncingShopify] = useState(false);
  const [isResumingShopify, setIsResumingShopify] = useState(false);
  const [isVerifyingWebhooks, setIsVerifyingWebhooks] = useState(false);
  const [isRegisteringWebhooks, setIsRegisteringWebhooks] = useState(false);
  const [isDisconnectingShopify, setIsDisconnectingShopify] = useState(false);
  const [shopifyShopInput, setShopifyShopInput] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectingShopifyRef = useRef<boolean>(false);

  // Billing & Subscription State
  const [billingSubscription, setBillingSubscription] = useState<BillingSubscriptionResponse | null>(null);
  const [billingPlans, setBillingPlans] = useState<BillingPlan[]>([]);
  const [isLoadingBilling, setIsLoadingBilling] = useState(false);
  const [billingLoadError, setBillingLoadError] = useState<string | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [checkoutTierLoading, setCheckoutTierLoading] = useState<PlanTier | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const portalInFlightRef = useRef<boolean>(false);
  const checkoutInFlightRef = useRef<boolean>(false);
  const activeWorkspaceIdRef = useRef<string | undefined>(activeWorkspace?.id);
  activeWorkspaceIdRef.current = activeWorkspace?.id;

  const fetchBillingState = useCallback(async () => {
    const targetWorkspaceId = activeWorkspace?.id;
    setIsLoadingBilling(true);
    setBillingLoadError(null);

    try {
      let plansFetchError: string | null = null;
      const plansPromise = apiClient.getBillingPlans().catch((err: any) => {
        plansFetchError = err?.message || 'Unable to load authoritative billing plans from server.';
        return null;
      });
      const subPromise = isAuthenticated ? apiClient.getBillingSubscription() : Promise.resolve(null);

      const [plansRes, subRes] = await Promise.all([plansPromise, subPromise]);

      if (plansRes?.plans) {
        setBillingPlans(plansRes.plans);
      } else {
        setBillingPlans([]);
        if (plansFetchError) {
          setBillingLoadError(plansFetchError);
        }
      }

      if (isAuthenticated && subRes) {
        if (!targetWorkspaceId || subRes.workspaceId === activeWorkspaceIdRef.current) {
          setBillingSubscription(subRes);
        }
      } else if (!isAuthenticated) {
        setBillingSubscription(null);
      }
    } catch (err: any) {
      setBillingSubscription(null);
      setBillingLoadError(err?.message || 'Failed to load subscription details from server.');
    } finally {
      setIsLoadingBilling(false);
    }
  }, [isAuthenticated, activeWorkspace?.id]);

  // Reset subscription state whenever workspace/auth changes to prevent stale tenant display
  useEffect(() => {
    setBillingSubscription(null);
    setBillingLoadError(null);
    setPortalError(null);
    setCheckoutError(null);
  }, [isAuthenticated, activeWorkspace?.id]);

  useEffect(() => {
    if (activeTab === 'subscription') {
      void fetchBillingState();
    }
  }, [activeTab, fetchBillingState]);

  const [pendingVerifySessionId, setPendingVerifySessionId] = useState<string | null>(null);
  const verifiedCheckoutSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!initialTab && selectedSettingsTab) {
      setActiveTab(selectedSettingsTab);
    }
  }, [initialTab, selectedSettingsTab]);

  // Check URL query parameters for Shopify OAuth and Stripe Checkout return feedback
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location || typeof window.location.search !== 'string') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const shopifyParam = params.get('shopify');
    const shopParam = params.get('shop');
    const errorParam = params.get('shopify_error');
    const checkoutParam = params.get('checkout');
    const sessionIdParam = params.get('session_id');
    const tabParam = params.get('tab');

    let handled = false;

    if (shopifyParam === 'connected') {
      addToast('Shopify Connected', `Successfully connected store ${shopParam || ''} via OAuth 2.0.`, 'success');
      setActiveTab('connectors');
      handled = true;
    } else if (shopifyParam === 'disconnected') {
      addToast('Shopify Disconnected', 'Shopify connection and stored credentials have been revoked.', 'info');
      setActiveTab('connectors');
      handled = true;
    } else if (errorParam) {
      let decodedError = errorParam;
      try {
        decodedError = decodeURIComponent(errorParam);
      } catch {
        // Keep raw string if already decoded
      }
      addToast('Shopify Connection Failed', decodedError, 'error');
      setActiveTab('connectors');
      handled = true;
    } else if (checkoutParam === 'success' || sessionIdParam) {
      addToast(
        'Stripe Checkout Returned',
        'Verifying your subscription status with the billing server...',
        'info'
      );
      if (sessionIdParam && sessionIdParam !== '{CHECKOUT_SESSION_ID}' && sessionIdParam.trim().length > 0) {
        setPendingVerifySessionId(sessionIdParam.trim());
      }
      setActiveTab('subscription');
      handled = true;
    } else if (checkoutParam === 'canceled') {
      addToast(
        'Checkout Canceled',
        'Stripe Checkout was canceled. Your current subscription remains unchanged.',
        'info'
      );
      setActiveTab('subscription');
      handled = true;
    } else if (!initialTab && (tabParam === 'subscription' || tabParam === 'connectors')) {
      setActiveTab(tabParam);
    }

    if (handled && typeof window.history?.replaceState === 'function') {
      const cleanPath = typeof window.location.pathname === 'string' ? window.location.pathname : '/';
      window.history.replaceState({}, typeof document !== 'undefined' ? document.title : '', cleanPath);
    }
  }, [addToast, initialTab]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      !pendingVerifySessionId ||
      verifiedCheckoutSessionsRef.current.has(pendingVerifySessionId) ||
      typeof apiClient.verifyCheckoutSession !== 'function'
    ) {
      return;
    }
    const targetSessionId = pendingVerifySessionId;
    verifiedCheckoutSessionsRef.current.add(targetSessionId);
    let cancelled = false;

    (async () => {
      try {
        const verified = await apiClient.verifyCheckoutSession(targetSessionId);
        if (cancelled) return;
        if (verified?.verified) {
          addToast(
            'Subscription Verified',
            `Your ${verified.subscription?.tier || 'paid'} plan is now active and full audit reports are unlocked.`,
            'success'
          );
          await Promise.all([fetchBillingState(), reloadWorkspaceCatalog()]);
        }
      } catch {
        // Leave authoritative billing state unchanged if server verification fails or session is unverified
        if (!cancelled) {
          await fetchBillingState();
        }
      } finally {
        if (!cancelled) {
          setPendingVerifySessionId(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, pendingVerifySessionId, addToast, fetchBillingState, reloadWorkspaceCatalog]);

  const fetchShopifyStatus = useCallback(async () => {
    if (!isAuthenticated) {
      setShopifyStatus(null);
      return;
    }
    setIsLoadingShopify(true);
    try {
      const [status, runsRes] = await Promise.all([
        apiClient.getShopifyStatus(),
        apiClient.getShopifySyncRuns(10).catch(() => ({ syncRuns: [] as any[] })),
      ]);
      setShopifyStatus(status);
      setShopifySyncRuns((runsRes as any).syncRuns || (runsRes as any).runs || []);
      if (status.shopDomain) {
        setShopifyShopInput(prev => prev || status.shopDomain || '');
      }
    } catch (err: any) {
      console.error('[AIXSHOP] Failed to fetch Shopify status:', err);
    } finally {
      setIsLoadingShopify(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (activeTab === 'connectors' && isAuthenticated) {
      void fetchShopifyStatus();
    }
  }, [activeTab, isAuthenticated, fetchShopifyStatus]);

  const handleConnectShopify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (connectingShopifyRef.current || isConnectingShopify) {
      return;
    }

    setConnectError(null);
    if (!isAuthenticated) {
      openAuthModal('register');
      return;
    }

    const validation = validateAndNormalizeShopDomain(shopifyShopInput);
    if (!validation.valid) {
      setConnectError(validation.error);
      return;
    }

    connectingShopifyRef.current = true;
    setIsConnectingShopify(true);

    try {
      const res = await apiClient.connectShopify(validation.shopDomain);
      if (!res || res.success !== true || !isValidShopifyAuthUrl(res.authUrl)) {
        throw new Error('Server returned an invalid Shopify authorization URL.');
      }
      redirectBrowser(res.authUrl);
    } catch (err: any) {
      setConnectError(err?.message || 'Failed to initiate Shopify OAuth connection.');
    } finally {
      connectingShopifyRef.current = false;
      setIsConnectingShopify(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    if (portalInFlightRef.current || isOpeningPortal) {
      return;
    }
    setPortalError(null);

    if (!isAuthenticated) {
      openAuthModal('login');
      return;
    }

    portalInFlightRef.current = true;
    setIsOpeningPortal(true);

    try {
      let returnUrl: string | undefined;
      if (
        typeof window !== 'undefined' &&
        window.location &&
        typeof window.location.origin === 'string' &&
        isValidExternalHttpUrl(window.location.origin)
      ) {
        returnUrl = `${window.location.origin}/?page=settings&tab=subscription`;
      }

      const res = await apiClient.createPortalSession(returnUrl ? { returnUrl } : undefined);
      if (
        !res ||
        res.success !== true ||
        !isValidBillingRedirectUrl(res.portalUrl, {
          flow: 'portal',
          provider: typeof res.provider === 'string' ? res.provider : undefined,
        })
      ) {
        throw new Error('Customer portal response missing a valid portal URL.');
      }
      redirectBrowser(res.portalUrl);
    } catch (err: any) {
      setPortalError(err?.message || 'Failed to open Stripe Customer Portal.');
    } finally {
      portalInFlightRef.current = false;
      setIsOpeningPortal(false);
    }
  };

  const handleStartUpgradeCheckout = async (tier: PlanTier) => {
    if (isLoadingBilling || billingLoadError || billingPlans.length === 0) {
      setCheckoutError('Authoritative billing plans have not loaded. Retry before starting checkout.');
      return;
    }
    if (checkoutInFlightRef.current || checkoutTierLoading !== null) {
      return;
    }
    setCheckoutError(null);

    if (!isAuthenticated) {
      openAuthModal('register');
      return;
    }

    checkoutInFlightRef.current = true;
    setCheckoutTierLoading(tier);

    try {
      let successUrl: string | undefined;
      let cancelUrl: string | undefined;
      if (
        typeof window !== 'undefined' &&
        window.location &&
        typeof window.location.origin === 'string' &&
        isValidExternalHttpUrl(window.location.origin)
      ) {
        successUrl = `${window.location.origin}/?page=settings&tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
        cancelUrl = `${window.location.origin}/?page=settings&tab=subscription&checkout=canceled`;
      }

      const res = await apiClient.createCheckoutSession({
        tier,
        ...(successUrl ? { successUrl } : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      });
      if (
        !res ||
        res.success !== true ||
        !isValidBillingRedirectUrl(res.checkoutUrl, {
          flow: 'checkout',
          provider: typeof res.provider === 'string' ? res.provider : undefined,
        })
      ) {
        throw new Error('Checkout session response missing a valid checkout URL.');
      }
      redirectBrowser(res.checkoutUrl);
    } catch (err: any) {
      setCheckoutError(err?.message || 'Failed to initiate Stripe checkout session.');
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutTierLoading(null);
    }
  };

  const handleSyncShopify = async () => {
    setIsSyncingShopify(true);
    try {
      const res = await apiClient.syncShopify();
      addToast(
        'Sync Completed',
        res.message || `Successfully synchronized ${res.variantsImported || 0} SKUs from Shopify.`,
        'success'
      );
      await reloadWorkspaceCatalog();
      await fetchShopifyStatus();
    } catch (err: any) {
      addToast('Sync Failed', err.message || 'Failed to sync products from Shopify.', 'error');
    } finally {
      setIsSyncingShopify(false);
    }
  };

  const handleResumeSyncShopify = async (syncRunId?: string) => {
    setIsResumingShopify(true);
    try {
      const res = await apiClient.resumeShopifySync(syncRunId ? { syncRunId } : undefined);
      addToast(
        'Sync Resumed',
        res.message || `Successfully resumed synchronization: imported ${res.variantsImported || 0} additional SKUs.`,
        'success'
      );
      await reloadWorkspaceCatalog();
      await fetchShopifyStatus();
    } catch (err: any) {
      addToast('Resume Failed', err.message || 'Failed to resume Shopify sync.', 'error');
    } finally {
      setIsResumingShopify(false);
    }
  };

  const handleVerifyWebhooks = async () => {
    setIsVerifyingWebhooks(true);
    try {
      const liveStatus = await apiClient.getShopifyStatus({ verify: 'live' });
      setShopifyStatus(liveStatus);
      addToast(
        liveStatus.webhookDetails?.isLiveVerified ? 'Webhooks Live-Verified' : 'Webhook Live Check',
        liveStatus.webhookDetails?.error ||
          (liveStatus.webhookStatus === 'active'
            ? 'All required webhook subscriptions are verified active on Shopify.'
            : `Webhook status: ${liveStatus.webhookStatus}`),
        liveStatus.webhookDetails?.isLiveVerified ? 'success' : 'info'
      );
    } catch (err: any) {
      addToast('Verification Failed', err.message || 'Failed to verify webhooks.', 'error');
    } finally {
      setIsVerifyingWebhooks(false);
    }
  };

  const handleRegisterWebhooks = async () => {
    setIsRegisteringWebhooks(true);
    try {
      const res = await apiClient.registerShopifyWebhooks();
      addToast(
        'Webhooks Registered',
        `Successfully registered ${res.activeWebhooks?.length || 0} webhook topics on Shopify Admin API.`,
        'success'
      );
      await fetchShopifyStatus();
    } catch (err: any) {
      addToast('Registration Failed', err.message || 'Failed to register webhooks.', 'error');
    } finally {
      setIsRegisteringWebhooks(false);
    }
  };

  const handleDisconnectShopify = async () => {
    if (!confirm('Are you sure you want to disconnect Shopify? Webhooks and automated sync will be disabled.')) {
      return;
    }
    setIsDisconnectingShopify(true);
    try {
      await apiClient.disconnectShopify();
      addToast('Shopify Disconnected', 'Shopify connection revoked.', 'info');
      await fetchShopifyStatus();
      await reloadWorkspaceCatalog();
    } catch (err: any) {
      addToast('Disconnect Failed', err.message || 'Failed to disconnect Shopify.', 'error');
    } finally {
      setIsDisconnectingShopify(false);
    }
  };

  React.useEffect(() => {
    setStoreName(storeProfile.name);
    setStoreDomain(storeProfile.domain);
    setCurrency(storeProfile.currency);
    setStrictness(storeProfile.truthBoundaryStrictness);
  }, [storeProfile]);

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeName.trim()) {
      addToast('Validation Error', 'Store name cannot be empty.', 'warning');
      return;
    }
    if (!storeDomain.trim()) {
      addToast('Validation Error', 'Store domain cannot be empty.', 'warning');
      return;
    }
    updateStoreProfile({
      name: storeName.trim(),
      domain: storeDomain.trim(),
      currency: currency,
      truthBoundaryStrictness: strictness,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="pb-4 border-b border-stone-200">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
          Store & Catalog Configuration
        </h1>
        <p className="text-xs text-stone-500 mt-1">
          Store profile, source-of-truth configuration, integration connectors, and truth boundary policies.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-stone-200 overflow-x-auto gap-2">
        <button
          onClick={() => setActiveTab('profile')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'profile'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Store Profile
        </button>

        <button
          onClick={() => setActiveTab('workspace')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'workspace'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          <Building2 className="w-3.5 h-3.5" />
          <span>Workspace & Database</span>
          {isCloudWorkspace ? (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          )}
        </button>

        <button
          onClick={() => setActiveTab('connectors')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'connectors'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Connectors & Feeds ({storeProfile.connectors.length})
        </button>

        <button
          onClick={() => setActiveTab('subscription')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'subscription'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Subscription & SKU Limits
        </button>

        <button
          onClick={() => setActiveTab('policies')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'policies'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Truth & Evidence Policies
        </button>

        <button
          onClick={() => setActiveTab('diagnostics')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'diagnostics'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Admin Diagnostics</span>
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === 'profile' && (
        <form onSubmit={handleSaveProfile} className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-5 max-w-2xl">
          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold text-stone-900 block mb-1">
                Store Identity Name
              </label>
              <input
                type="text"
                value={storeName}
                onChange={e => setStoreName(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-stone-900 block mb-1">
                Store Primary Domain
              </label>
              <input
                type="text"
                value={storeDomain}
                onChange={e => setStoreDomain(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-stone-900 block mb-1">
                  Primary Catalog Currency
                </label>
                <select
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="GBP">GBP (£)</option>
                  <option value="CAD">CAD ($)</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-stone-900 block mb-1">
                  Primary Source of Truth
                </label>
                <input
                  type="text"
                  disabled
                  value={storeProfile.platform}
                  className="w-full px-3.5 py-2.5 bg-stone-100 border border-stone-200 rounded-xl text-xs font-mono text-stone-600 cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-stone-100 flex items-center justify-between">
            <span className="text-xs text-stone-500 font-mono">
              Storage: {isDurableStorage ? 'Persistent Local Storage' : 'Session Memory (Non-durable)'}
            </span>
            <button
              type="submit"
              disabled={isReadOnlyMode}
              className={`px-5 py-2.5 text-white text-xs font-semibold rounded-xl shadow-xs flex items-center gap-1.5 transition-colors ${
                isReadOnlyMode 
                  ? 'bg-stone-400 cursor-not-allowed' 
                  : 'bg-orange-600 hover:bg-orange-700'
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isReadOnlyMode ? 'Locked (Read-Only Mode)' : 'Save Store Profile'}</span>
            </button>
          </div>
        </form>
      )}

      {activeTab === 'workspace' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-6 max-w-3xl">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100">
            <div>
              <h3 className="text-base font-bold text-stone-900 flex items-center gap-2">
                <Building2 className="w-5 h-5 text-orange-600" />
                <span>Multi-Tenant Workspace & Database Status</span>
              </h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Manage workspace tenant boundaries, database persistence, and demo catalog migration.
              </p>
            </div>
            {isCloudWorkspace ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                PostgreSQL Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Demo Mode (Browser Storage)
              </span>
            )}
          </div>

          {/* Account & Active Workspace Card */}
          {isAuthenticated && activeWorkspace ? (
            <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-[10px] uppercase font-bold text-stone-400 tracking-wider">Active Workspace</span>
                  <h4 className="text-sm font-bold text-stone-900 mt-0.5">{activeWorkspace.name}</h4>
                  <p className="text-xs text-stone-500 font-mono">ID: {activeWorkspace.id} · Slug: {activeWorkspace.slug}</p>
                </div>
                <span className="text-xs uppercase font-mono font-bold px-2 py-0.5 bg-stone-200 text-stone-700 rounded-md">
                  Role: {activeWorkspace.role}
                </span>
              </div>

              <div className="pt-3 border-t border-stone-200/60 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-stone-500 block font-medium">Logged in as</span>
                  <span className="text-stone-900 font-semibold">{user?.fullName}</span>
                </div>
                <div>
                  <span className="text-stone-500 block font-medium">Account Email</span>
                  <span className="text-stone-900 font-mono">{user?.email}</span>
                </div>
              </div>

              {workspaces.length > 1 && (
                <div className="pt-3 border-t border-stone-200/60">
                  <span className="text-xs font-semibold text-stone-700 block mb-2">Available Workspaces</span>
                  <div className="flex flex-wrap gap-2">
                    {workspaces.map(ws => (
                      <button
                        key={ws.id}
                        onClick={() => switchWorkspace(ws.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                          ws.id === activeWorkspace.id
                            ? 'bg-orange-50 border-orange-300 text-orange-800'
                            : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-100'
                        }`}
                      >
                        {ws.name} ({ws.role})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-5 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-xs font-bold text-amber-900">Unauthenticated Demo Session</h4>
                  <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                    You are exploring AIXSHOP in browser-only demo mode. Catalog changes and settings are preserved in local browser memory. To activate multi-customer PostgreSQL cloud storage and isolate your catalog into a secure workspace, create an account or sign in.
                  </p>
                </div>
              </div>
              <button
                onClick={() => openAuthModal('register')}
                className="mt-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <span>Create Merchant Workspace Account</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Migration Path: Import Demo Catalog into Workspace */}
          <DemoCatalogMigrationSection
            isAuthenticated={isAuthenticated}
            openAuthModal={openAuthModal}
            overwriteProtection={overwriteProtection}
            confirmingDemoOverwrite={confirmingDemoOverwrite}
            setConfirmingDemoOverwrite={setConfirmingDemoOverwrite}
            isMigratingDemo={isMigratingDemo}
            setIsMigratingDemo={setIsMigratingDemo}
            cloudCatalogStatus={cloudCatalogStatus}
            catalogVersion={catalogVersion}
            migrateDemoDataToCloud={migrateDemoDataToCloud}
            reloadWorkspaceCatalog={reloadWorkspaceCatalog}
          />

          {/* Multi-Tenant Security & Durability Architecture */}
          <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 space-y-3 text-xs">
            <h4 className="font-bold text-stone-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Security Architecture & Tenant Isolation Controls</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-stone-600 leading-relaxed">
              <div className="space-y-1">
                <span className="font-semibold text-stone-800 block">Row-Level Workspace Scoping</span>
                <p>Every SQL query filters strictly by <code className="font-mono text-stone-800">workspace_id</code> derived exclusively from the verified server-side session token. Client-supplied IDs are never trusted as authorization.</p>
              </div>
              <div className="space-y-1">
                <span className="font-semibold text-stone-800 block">Cryptographic Password Hashing</span>
                <p>Passwords are hashed using Node.js <code className="font-mono text-stone-800">crypto.scrypt</code> with a 16-byte random salt and verified with timing-safe comparison to prevent timing side-channel attacks.</p>
              </div>
              <div className="space-y-1">
                <span className="font-semibold text-stone-800 block">Hashed Session Defense</span>
                <p>Session tokens are stored in the database exclusively as SHA-256 hashes. If a database snapshot is disclosed, raw session tokens cannot be extracted.</p>
              </div>
              <div className="space-y-1">
                <span className="font-semibold text-stone-800 block">Monetary Precision Guarantee</span>
                <p>Catalog variant prices are persisted using <code className="font-mono text-stone-800">NUMERIC(14, 2)</code> with strict two-decimal half-up rounding, eliminating floating-point drift.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'connectors' && (
        <div className="space-y-6">
          {/* Primary Shopify Integration Card */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 font-bold">
                  <ShoppingBag className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-stone-900">Official Shopify Admin Integration</h3>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-stone-100 text-stone-600 font-semibold border border-stone-200">
                      GraphQL 2026-10
                    </span>
                  </div>
                  <p className="text-xs text-stone-500 mt-0.5">
                    Read-only Shopify catalog synchronization, webhook listeners, and AES-256-GCM token security.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                {isLoadingShopify ? (
                  <span className="text-xs text-stone-400 flex items-center gap-1.5 font-mono">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Checking...</span>
                  </span>
                ) : shopifyStatus?.connected ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Connected & Active</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-stone-100 text-stone-600 border border-stone-200">
                    <span className="w-2 h-2 rounded-full bg-stone-400" />
                    <span>Not Connected</span>
                  </span>
                )}
              </div>
            </div>

            {/* If Not Authenticated into a Workspace */}
            {!isAuthenticated ? (
              <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-xs font-bold text-amber-900">Merchant Workspace Account Required</h4>
                    <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                      Shopify integration requires an active multi-tenant workspace account so merchant OAuth credentials can be securely encrypted and partitioned to your workspace database.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => openAuthModal('register')}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Sign In or Register Workspace</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : shopifyStatus?.connected ? (
              /* Connected Shopify Merchant Store View */
              <div className="space-y-5">
                {/* Connection Meta */}
                <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                  <div>
                    <span className="text-stone-500 block font-medium">Connected Store</span>
                    <span className="font-mono font-bold text-stone-900 text-sm mt-0.5 block truncate">
                      {shopifyStatus.shopDomain}
                    </span>
                  </div>
                  <div>
                    <span className="text-stone-500 block font-medium">Granted Scopes</span>
                    <span className="font-mono text-stone-800 mt-0.5 block truncate">
                      {shopifyStatus.grantedScopes.join(', ') || 'read_products'}
                    </span>
                  </div>
                  <div>
                    <span className="text-stone-500 block font-medium">Security Encryption</span>
                    <span className="font-mono text-emerald-800 font-semibold mt-0.5 block">
                      AES-256-GCM (v1)
                    </span>
                  </div>
                  <div>
                    <span className="text-stone-500 block font-medium">Connected Since</span>
                    <span className="text-stone-700 mt-0.5 block">
                      {shopifyStatus.installedAt ? new Date(shopifyStatus.installedAt).toLocaleDateString() : 'Active'}
                    </span>
                  </div>
                </div>

                {/* Sync Status & Metrics */}
                <div className="border border-stone-200 rounded-xl p-4 space-y-4">
                  {shopifyStatus.canResumeSync && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <span className="font-bold text-amber-900 block">Catalog Synchronization Incomplete</span>
                        <p className="text-amber-800 text-[11px] mt-0.5">
                          The previous sync run reached its pagination ceiling and recorded cursor <code className="font-mono bg-amber-100 px-1 py-0.5 rounded text-[10px]">{shopifyStatus.latestSync?.cursorResumed ? `${shopifyStatus.latestSync.cursorResumed.slice(0, 24)}...` : 'stored'}</code>. You can resume importing the remaining products without duplicating items.
                        </p>
                      </div>
                      <button
                        disabled={isResumingShopify || isSyncingShopify}
                        onClick={() => handleResumeSyncShopify()}
                        className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-1.5 self-start sm:self-auto shrink-0 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isResumingShopify ? 'animate-spin' : ''}`} />
                        <span>{isResumingShopify ? 'Resuming...' : 'Resume Sync'}</span>
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="text-xs font-bold text-stone-900">Catalog Synchronization Telemetry</h4>
                      <p className="text-[11px] text-stone-500">
                        {shopifyStatus.lastSync?.completedAt
                          ? `Last synchronized: ${new Date(shopifyStatus.lastSync.completedAt).toLocaleString()}`
                          : 'No sync completed yet. Click "Sync Full Catalog" to fetch store products.'}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {shopifyStatus.canResumeSync && (
                        <button
                          disabled={isResumingShopify || isSyncingShopify}
                          onClick={() => handleResumeSyncShopify()}
                          className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isResumingShopify ? 'animate-spin' : ''}`} />
                          <span>{isResumingShopify ? 'Resuming...' : 'Resume Sync'}</span>
                        </button>
                      )}

                      <button
                        disabled={isSyncingShopify || isResumingShopify}
                        onClick={handleSyncShopify}
                        className="px-3.5 py-1.5 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isSyncingShopify ? 'animate-spin' : ''}`} />
                        <span>{isSyncingShopify ? 'Syncing...' : 'Sync Full Catalog'}</span>
                      </button>

                      <button
                        disabled={isDisconnectingShopify}
                        onClick={handleDisconnectShopify}
                        className="px-3.5 py-1.5 bg-white border border-red-200 hover:bg-red-50 text-red-700 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                        <span>{isDisconnectingShopify ? 'Revoking...' : 'Disconnect'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Telemetry Numbers */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200/80">
                      <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider block">Discovered</span>
                      <span className="text-base font-bold text-stone-900 mt-0.5 block">
                        {shopifyStatus.lastSync?.productsDiscovered ?? 0}
                      </span>
                      <span className="text-[10px] text-stone-500">Shopify products</span>
                    </div>

                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200/80">
                      <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider block">Imported SKUs</span>
                      <span className="text-base font-bold text-stone-900 mt-0.5 block">
                        {shopifyStatus.lastSync?.variantsImported ?? 0}
                      </span>
                      <span className="text-[10px] text-stone-500">active variants</span>
                    </div>

                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200/80">
                      <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider block">Plan Quota</span>
                      <span className="text-base font-bold text-stone-900 mt-0.5 block">
                        {shopifyStatus.entitlement?.isUnlimited ? 'Unlimited' : `${shopifyStatus.entitlement?.skuLimit ?? 2500} SKUs`}
                      </span>
                      <span className="text-[10px] text-stone-500">{shopifyStatus.entitlement?.tier ?? 'Growth'} tier</span>
                    </div>

                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200/80">
                      <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider block">Excluded</span>
                      <span className={`text-base font-bold mt-0.5 block ${(shopifyStatus.lastSync?.excludedByPlan ?? 0) > 0 ? 'text-amber-600' : 'text-stone-900'}`}>
                        {shopifyStatus.lastSync?.excludedByPlan ?? 0}
                      </span>
                      <span className="text-[10px] text-stone-500">exceeded quota</span>
                    </div>
                  </div>

                  {/* Webhook Status */}
                  <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        <span className="font-semibold text-stone-800">Shopify Webhook Subscriptions:</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${
                          shopifyStatus.webhookStatus === 'active' && shopifyStatus.webhookDetails?.isLiveVerified
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : shopifyStatus.webhookStatus === 'mismatch' || shopifyStatus.webhookStatus === 'verification_unavailable' || shopifyStatus.webhookStatus === 'verification_incomplete'
                            ? 'bg-red-50 text-red-800 border-red-200'
                            : shopifyStatus.webhookStatus === 'partially_registered' || shopifyStatus.webhookStatus === 'registered_unverified'
                            ? 'bg-amber-50 text-amber-800 border-amber-200'
                            : 'bg-stone-100 text-stone-600 border-stone-200'
                        }`}>
                          {shopifyStatus.webhookStatus === 'active' && shopifyStatus.webhookDetails?.isLiveVerified
                            ? '● Verified Active (Live)'
                            : shopifyStatus.webhookStatus === 'registered_unverified'
                            ? 'Registered (Cached — Live Check Required)'
                            : shopifyStatus.webhookStatus || 'Unverified'}
                        </span>
                        <span className="text-[10px] font-mono text-stone-500">
                          {shopifyStatus.webhookDetails?.webhookLastVerifiedAt
                            ? `Last live webhook check: ${new Date(shopifyStatus.webhookDetails.webhookLastVerifiedAt).toLocaleString()}`
                            : 'Never live-verified'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-5">
                        {['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'].map(topic => {
                          const isSubscribed = (shopifyStatus.activeWebhooks || []).some(w => w.toUpperCase() === topic);
                          const isTopicLiveVerified = (shopifyStatus.webhookDetails?.verifiedTopics || []).some(w => w.toUpperCase() === topic);
                          return (
                            <span
                              key={topic}
                              className={`inline-flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded border font-semibold ${
                                isTopicLiveVerified && shopifyStatus.webhookDetails?.isLiveVerified
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isSubscribed
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-stone-50 text-stone-500 border-stone-200'
                              }`}
                            >
                              {isTopicLiveVerified && shopifyStatus.webhookDetails?.isLiveVerified ? (
                                <Check className="w-2.5 h-2.5 text-emerald-600" />
                              ) : (
                                <span className={`w-1.5 h-1.5 rounded-full ${isSubscribed ? 'bg-amber-500' : 'bg-stone-400'}`} />
                              )}
                              <span>{topic.toLowerCase()}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-start sm:self-auto">
                      <button
                        disabled={isVerifyingWebhooks}
                        onClick={handleVerifyWebhooks}
                        className="px-2.5 py-1 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded-lg shadow-2xs transition-colors flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                        title="Actively inspect live subscriptions on Shopify Admin API"
                      >
                        <RefreshCw className={`w-3 h-3 ${isVerifyingWebhooks ? 'animate-spin' : ''}`} />
                        <span>{isVerifyingWebhooks ? 'Verifying...' : 'Verify Live'}</span>
                      </button>

                      <button
                        disabled={isRegisteringWebhooks}
                        onClick={handleRegisterWebhooks}
                        className="px-2.5 py-1 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded-lg shadow-2xs transition-colors flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                        title="Re-register all webhook topics with Shopify Admin API"
                      >
                        <Zap className="w-3 h-3 text-amber-500" />
                        <span>{isRegisteringWebhooks ? 'Registering...' : 'Register Webhooks'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Operational Sync Run History & Attempt Lineage */}
                  {shopifySyncRuns.length > 0 && (
                    <div className="pt-4 border-t border-stone-100 space-y-2">
                      <h4 className="text-xs font-bold text-stone-900">Recent Sync Runs & Attempt Lineage</h4>
                      <div className="overflow-x-auto border border-stone-200 rounded-lg">
                        <table className="w-full text-left border-collapse text-[11px]">
                          <thead>
                            <tr className="bg-stone-50 border-b border-stone-200 text-stone-600 font-semibold">
                              <th className="py-2 px-3">Run / Attempt</th>
                              <th className="py-2 px-3">Status</th>
                              <th className="py-2 px-3">Variant Completeness</th>
                              <th className="py-2 px-3 text-right">Products / Variants</th>
                              <th className="py-2 px-3 text-right">Started</th>
                              <th className="py-2 px-3 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-stone-100 font-mono tabular-nums">
                            {shopifySyncRuns.slice(0, 6).map((run) => (
                              <tr key={run.id} className="hover:bg-stone-50">
                                <td className="py-2 px-3 text-stone-800">
                                  <div>{run.id.slice(0, 14)}...</div>
                                  <div className="text-[10px] text-stone-500">
                                    Attempt #{run.attemptNumber || 1}
                                    {run.parentSyncRunId ? ` · Parent ${run.parentSyncRunId.slice(0, 10)}` : ''}
                                  </div>
                                </td>
                                <td className="py-2 px-3">
                                  <span className={`font-semibold ${
                                    run.status === 'completed'
                                      ? 'text-emerald-700'
                                      : run.status === 'partially_completed'
                                      ? 'text-amber-700'
                                      : run.status === 'failed'
                                      ? 'text-red-700'
                                      : 'text-stone-700'
                                  }`}>
                                    {run.status}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-stone-600">
                                  {run.variantCompletenessStatus || 'complete'}
                                </td>
                                <td className="py-2 px-3 text-right text-stone-800">
                                  {run.productsImported ?? 0} / {run.variantsImported ?? 0}
                                </td>
                                <td className="py-2 px-3 text-right text-stone-500">
                                  {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                                </td>
                                <td className="py-2 px-3 text-right">
                                  {(run.status === 'partially_completed' || run.status === 'failed') && run.cursorResumed ? (
                                    <button
                                      disabled={isResumingShopify || isSyncingShopify}
                                      onClick={() => handleResumeSyncShopify(run.id)}
                                      className="font-sans text-orange-700 hover:text-orange-800 font-semibold cursor-pointer"
                                    >
                                      Resume
                                    </button>
                                  ) : (
                                    <span className="text-stone-400">—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Disconnected State: Connect Shopify Store Form */
              <div className="space-y-5">
                <form onSubmit={handleConnectShopify} className="space-y-4 max-w-xl">
                  <div>
                    <label className="text-xs font-bold text-stone-900 block mb-1">
                      Shopify Merchant Store Domain
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type="text"
                          placeholder="e.g. solstice-mercantile.myshopify.com"
                          value={shopifyShopInput}
                          onChange={e => {
                            setShopifyShopInput(e.target.value);
                            setConnectError(null);
                          }}
                          className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={isConnectingShopify}
                        className="px-4 py-2.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-colors flex items-center gap-2 shrink-0 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isConnectingShopify ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Connecting...</span>
                          </>
                        ) : (
                          <>
                            <Link2 className="w-3.5 h-3.5" />
                            <span>Connect Store</span>
                          </>
                        )}
                      </button>
                    </div>
                    {connectError && (
                      <p role="alert" className="text-xs text-red-600 mt-1.5 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        <span>{connectError}</span>
                      </p>
                    )}
                    <p className="text-[11px] text-stone-500 mt-1.5">
                      Enter your <code className="font-mono text-stone-700">myshopify.com</code> store handle or canonical hostname. You will be redirected to the secure Shopify authorization screen to grant read permissions.
                    </p>
                  </div>
                </form>

                {/* Technical Architecture Guarantees */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-stone-100 text-xs">
                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80 space-y-1">
                    <span className="font-bold text-stone-900 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Zero Plaintext Storage</span>
                    </span>
                    <p className="text-stone-600 text-[11px] leading-relaxed">
                      Merchant access tokens are encrypted with AES-256-GCM. Unforgeable authentication tags verify ciphertext integrity on every load.
                    </p>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80 space-y-1">
                    <span className="font-bold text-stone-900 flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-blue-600" />
                      <span>Admin GraphQL 2026-10</span>
                    </span>
                    <p className="text-stone-600 text-[11px] leading-relaxed">
                      Queries are pinned to latest stable API version 2026-10 with cursor-based pagination, expiring offline OAuth token lifecycle, and throttle backoff.
                    </p>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80 space-y-1">
                    <span className="font-bold text-stone-900 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-purple-600" />
                      <span>Strict Tenant Isolation</span>
                    </span>
                    <p className="text-stone-600 text-[11px] leading-relaxed">
                      Connections, webhooks, and sync runs are partitioned strictly by workspace ID with timing-safe HMAC signature verification.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Secondary Connectors & Channel Feeds */}
          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Additional Channel Feeds & Marketplaces</h3>
                <p className="text-xs text-stone-500">Auxiliary marketplace feeds and comparison channels</p>
              </div>
              <span className="text-xs font-mono text-stone-400">Auxiliary Connectors</span>
            </div>

            <div className="space-y-4">
              {storeProfile.connectors.map(connector => (
                <div
                  key={connector.id}
                  className="p-4 rounded-xl border border-stone-200 bg-stone-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-stone-900">{connector.name}</span>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold uppercase ${
                        connector.status === 'connected'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : connector.status === 'read_only'
                          ? 'bg-blue-50 text-blue-800 border border-blue-200'
                          : 'bg-stone-200 text-stone-700'
                      }`}>
                        {connector.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 font-mono mt-1 flex flex-wrap gap-3">
                      <span>Synced: {connector.productCountSynced} SKUs</span>
                      <span>·</span>
                      <span>Last Sync: {connector.lastSync}</span>
                      <span>·</span>
                      <span className={connector.writeBackAuthorized ? 'text-emerald-700 font-semibold' : 'text-stone-500'}>
                        Write-Back: {connector.writeBackAuthorized ? 'Authorized' : 'Read-Only (Protected)'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleConnectorSync(connector.id)}
                      className="px-3 py-1.5 bg-white border border-stone-300 hover:border-stone-400 text-xs font-medium text-stone-700 rounded-lg transition-colors cursor-pointer"
                    >
                      {connector.status === 'connected' ? 'Disconnect' : 'Connect & Sync'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3.5 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800">
              <strong className="block mb-0.5">Write-Back & Integration Security Policy:</strong>
              Write-back permissions require explicit OAuth token authorization with catalog write scopes. In this environment, live storefront mutation is protected and connectors default to safe read-only auditing.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'subscription' && (() => {
        const sub = billingSubscription?.subscription;
        const authoritativeProfile = billingSubscription?.storeProfile;
        const effectiveTier = String(sub?.tier || authoritativeProfile?.tier || storeProfile.tier || 'Free Audit');
        const effectiveStatus = String(sub?.status || (isAuthenticated ? 'active' : 'demo'));
        const effectiveProvider = String(sub?.provider || 'none');
        const isFreeOrUnpaidProvider = effectiveProvider === 'none' || effectiveTier === 'Free Audit';
        const hasBillingPortalAccess = Boolean(
          isAuthenticated &&
          sub &&
          effectiveProvider !== 'none'
        );

        const matchedPlan = billingPlans.find(
          p => p.tier.toLowerCase() === effectiveTier.toLowerCase()
        ) || null;
        const paidUpgradePlans = billingPlans.filter(p => p.priceCents > 0);

        const currentSkuCount = typeof authoritativeProfile?.skuCount === 'number'
          ? authoritativeProfile.skuCount
          : typeof storeProfile.skuCount === 'number'
          ? storeProfile.skuCount
          : products.reduce((acc, p) => acc + (p.variants?.length ? p.variants.length : 1), 0);

        const rawLimit =
          authoritativeProfile?.skuLimit !== undefined
            ? authoritativeProfile.skuLimit
            : matchedPlan?.skuLimit !== undefined
            ? matchedPlan.skuLimit
            : storeProfile.skuLimit;

        const isUnlimitedLimit =
          rawLimit === null ||
          typeof rawLimit !== 'number' ||
          !Number.isFinite(rawLimit) ||
          effectiveTier.toLowerCase().includes('enterprise');

        const effectiveLimit = !isUnlimitedLimit && typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : 2500;
        const utilizationPct = isUnlimitedLimit
          ? '0.0'
          : ((currentSkuCount / effectiveLimit) * 100).toFixed(1);

        const periodStartFormatted = formatSubscriptionDate(sub?.currentPeriodStart);
        const periodEndFormatted = formatSubscriptionDate(sub?.currentPeriodEnd);

        const statusBadgeClass =
          effectiveStatus === 'active' || effectiveStatus === 'trialing'
            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
            : effectiveStatus === 'past_due' || effectiveStatus === 'unpaid'
            ? 'bg-amber-50 text-amber-800 border-amber-200'
            : effectiveStatus === 'canceled' || effectiveStatus === 'expired'
            ? 'bg-rose-50 text-rose-800 border-rose-200'
            : 'bg-stone-100 text-stone-700 border-stone-200';

        return (
          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-100">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Subscription & SKU Capacity</h3>
                <p className="text-xs text-stone-500">
                  {isAuthenticated
                    ? 'Authoritative workspace subscription status, billing interval, and SKU capacity limits'
                    : 'Workspace scale limits and demo plan parameters (sign in for server billing)'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono font-bold text-orange-700 bg-orange-50 px-2.5 py-1 rounded border border-orange-200">
                  {effectiveTier}
                </span>
                <span className={`text-xs font-mono font-semibold px-2.5 py-1 rounded border capitalize ${statusBadgeClass}`}>
                  {isFreeOrUnpaidProvider && isAuthenticated ? `${effectiveStatus} (Free / No Paid Plan)` : effectiveStatus}
                </span>
              </div>
            </div>

            {!isAuthenticated && (
              <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900">
                    <span className="font-bold block">Sign In Required for Workspace Billing</span>
                    <span className="text-amber-800">
                      Sign in or register a workspace account to view live subscription status, upgrade plans, or open the Stripe Customer Portal.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openAuthModal('login')}
                  className="px-3.5 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shrink-0 cursor-pointer"
                >
                  Sign In
                </button>
              </div>
            )}

            {isLoadingBilling && (
              <div className="flex items-center gap-2 text-xs text-stone-500 font-mono">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Loading subscription details...</span>
              </div>
            )}

            {billingLoadError && (
              <div
                role="alert"
                className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{billingLoadError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchBillingState()}
                  className="px-3 py-1 bg-white border border-rose-300 hover:bg-rose-100 rounded-lg font-semibold text-rose-800 shrink-0 cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Catalog SKU Utilization */}
            <div className="p-5 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-stone-900">Catalog SKU Utilization</span>
                <span className="font-mono text-stone-600">
                  {isUnlimitedLimit
                    ? `${currentSkuCount} / Unlimited SKUs`
                    : `${currentSkuCount} / ${effectiveLimit} SKUs (${utilizationPct}%)`}
                </span>
              </div>

              {!isUnlimitedLimit && (
                <div className="w-full bg-stone-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-orange-600 h-2.5 rounded-full"
                    style={{ width: `${Math.min(100, (currentSkuCount / effectiveLimit) * 100)}%` }}
                  ></div>
                </div>
              )}

              <p className="text-xs text-stone-500">
                Capacity baseline: {isUnlimitedLimit ? 'Unlimited' : `${effectiveLimit} SKUs`} (1 variant = 1 SKU).
                {sub && effectiveProvider !== 'none' && (effectiveStatus === 'active' || effectiveStatus === 'trialing')
                  ? ' Full audit reports, evidence trails, remediation actions, and feed exports are unlocked by your active paid subscription.'
                  : ' Free Audit allows catalog onboarding and capacity sizing only (non-recurring, no audit findings before payment). Full audits, findings, evidence trails, remediation, and feed exports require an active Starter (250 SKUs), Growth (2,500 SKUs), or Enterprise (Unlimited) plan.'}
              </p>
            </div>

            {/* Subscription Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Billing Cadence</span>
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-stone-100 text-stone-700 border border-stone-200">
                    {matchedPlan?.billingInterval === 'none' || isFreeOrUnpaidProvider
                      ? 'Non-Recurring (Free)'
                      : matchedPlan?.billingInterval === 'year'
                      ? 'Yearly'
                      : 'Monthly'}
                  </span>
                </div>
                <p className="text-base font-bold text-stone-900 font-mono">
                  {getTierMonthlyPriceLabel(effectiveTier, matchedPlan)}
                </p>
                <p className="text-stone-500">
                  {matchedPlan?.billingInterval === 'none' || isFreeOrUnpaidProvider
                    ? 'Non-recurring free workspace tier · No automatic charges or invoices'
                    : periodEndFormatted
                    ? sub?.cancelAtPeriodEnd
                      ? `Cancels on ${periodEndFormatted}`
                      : `Current period ends ${periodEndFormatted}`
                    : periodStartFormatted
                    ? `Period started ${periodStartFormatted}`
                    : 'Authoritative server tier price · Live Stripe checkout depends on server credentials'}
                </p>
              </div>

              <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Audit &amp; Sync</span>
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                    On-Demand
                  </span>
                </div>
                <p className="text-base font-bold text-stone-900 font-mono">On-Demand</p>
                <p className="text-stone-500">Manual audit execution; Shopify webhook handling requires live store credentials</p>
              </div>

              <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Billing Management</span>
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 capitalize">
                    {effectiveProvider === 'none' ? 'Unpaid / Free' : effectiveProvider}
                  </span>
                </div>
                <p className="text-base font-bold text-stone-900 font-mono">
                  {hasBillingPortalAccess ? 'Active Billing Profile' : 'Standard Workspace'}
                </p>
                {sub?.cancelAtPeriodEnd && (
                  <p className="text-amber-700 font-medium">Scheduled to cancel at period end.</p>
                )}
                <p className="text-stone-500">
                  {hasBillingPortalAccess
                    ? 'Manage payment methods, invoices, or cancellation via Stripe Customer Portal.'
                    : 'Select a paid plan below to activate recurring billing.'}
                </p>
              </div>
            </div>

            {/* Period Details & Entitlements */}
            {(periodStartFormatted || periodEndFormatted || (matchedPlan && matchedPlan.features.length > 0)) && (
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3 text-xs">
                {(periodStartFormatted || periodEndFormatted) && (
                  <div className="flex flex-wrap gap-6 pb-2 border-b border-stone-200/80">
                    {periodStartFormatted && (
                      <div>
                        <span className="text-stone-500 block">Period Start</span>
                        <span className="font-mono font-semibold text-stone-900">{periodStartFormatted}</span>
                      </div>
                    )}
                    {periodEndFormatted && (
                      <div>
                        <span className="text-stone-500 block">
                          {sub?.cancelAtPeriodEnd ? 'Access Ends' : 'Current Period End'}
                        </span>
                        <span className="font-mono font-semibold text-stone-900">{periodEndFormatted}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-stone-500 block">Subscription Status</span>
                      <span className="font-mono font-semibold text-stone-900 capitalize">{effectiveStatus}</span>
                    </div>
                  </div>
                )}

                {matchedPlan && matchedPlan.features.length > 0 && (
                  <div>
                    <span className="font-semibold text-stone-800 block mb-1.5">Plan Entitlements</span>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-stone-600">
                      {matchedPlan.features.map((feat, idx) => (
                        <li key={idx} className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>{feat}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Manage Billing Action (for workspaces with an active/existing billing provider record) */}
            {hasBillingPortalAccess && (
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs">
                  <span className="font-bold text-stone-900 block">Stripe Customer Portal</span>
                  <span className="text-stone-600">
                    Update payment details, view invoices, or modify your {effectiveTier} subscription.
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isOpeningPortal}
                  onClick={() => void handleOpenBillingPortal()}
                  className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center gap-2 shrink-0 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isOpeningPortal ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Opening Portal...</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>Manage Billing</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {portalError && (
              <div role="alert" className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{portalError}</span>
              </div>
            )}

            {checkoutError && (
              <div role="alert" className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{checkoutError}</span>
              </div>
            )}

            {/* Upgrade / Subscribe Plans for Free or Canceled/Expired Workspaces */}
            {isAuthenticated && (isFreeOrUnpaidProvider || effectiveStatus === 'canceled' || effectiveStatus === 'expired') && paidUpgradePlans.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-stone-100">
                <div>
                  <h4 className="text-xs font-bold text-stone-900">Available Paid Plans</h4>
                  <p className="text-xs text-stone-500">
                    Upgrade your workspace capacity through Stripe Checkout. Subscriptions activate only after verified server payment confirmation.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {paidUpgradePlans.map(plan => {
                    const isLoadingThis = checkoutTierLoading === plan.tier;
                    const isAnyLoading = checkoutTierLoading !== null;
                    return (
                      <div key={plan.id} className="p-4 rounded-xl border border-stone-200 bg-stone-50 flex flex-col justify-between gap-3">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-stone-900">{plan.name}</span>
                            <span className="text-xs font-mono font-bold text-stone-900">
                              {getTierMonthlyPriceLabel(plan.tier, plan)}
                            </span>
                          </div>
                          <p className="text-[11px] text-stone-500 mt-1">
                            {plan.skuLimit === null || !Number.isFinite(plan.skuLimit)
                              ? 'Unlimited SKUs'
                              : `Up to ${plan.skuLimit.toLocaleString()} SKUs`}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={isAnyLoading || isLoadingBilling || Boolean(billingLoadError)}
                          onClick={() => void handleStartUpgradeCheckout(plan.tier)}
                          className="w-full py-2 px-3 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {isLoadingThis ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Redirecting...</span>
                            </>
                          ) : (
                            <span>Upgrade to {plan.tier}</span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-600">
              <strong className="block mb-0.5 text-stone-800">Integration Notice:</strong>
              Server billing services (authoritative tier pricing, SKU quota enforcement, Stripe checkout/webhook signature handlers, and leased webhook idempotency) are implemented in the backend, while this panel displays your workspace SKU capacity. Live Stripe payments remain unconfigured and unverified until <code className="font-mono">STRIPE_SECRET_KEY</code>, <code className="font-mono">STRIPE_WEBHOOK_SECRET</code>, and Stripe Price IDs are provisioned.
            </div>
          </div>
        );
      })()}

      {activeTab === 'policies' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-5">
          <div className="pb-3 border-b border-stone-100">
            <h3 className="text-sm font-bold text-stone-900">Truth & Evidence Policy Engine</h3>
            <p className="text-xs text-stone-500">Define strictness criteria for marketing claims, GTIN verification, and provenance checks</p>
          </div>

          <div className="space-y-4">
            <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-stone-900">Truth Boundary Strictness</span>
                <select
                  value={strictness}
                  onChange={e => setStrictness(e.target.value as any)}
                  className="px-3 py-1.5 bg-white border border-stone-300 rounded-lg text-xs font-medium text-stone-900"
                >
                  <option value="strict">Strict (Flag any unverified eco/origin claim)</option>
                  <option value="standard">Standard (Flag missing GTIN and conflicting claims)</option>
                  <option value="relaxed">Relaxed (Informational notices only)</option>
                </select>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Under Strict policy, claims mentioning "organic", "fair trade", "biodegradable", or "medical grade" without a verified certificate ID in the Evidence Registry are flagged as High Severity.
              </p>
            </div>

            <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-1.5 text-xs text-stone-700">
              <span className="font-bold text-stone-900">Standard Schema.org JSON-LD Enforcement</span>
              <p className="text-stone-600 leading-relaxed">
                AIXSHOP automatically validates that all published product feeds inject structured <code className="font-mono text-stone-800">Offer</code> objects with price, priceCurrency, and availability tags to satisfy schema crawlers.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'diagnostics' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-orange-600" />
              <h3 className="text-sm font-bold text-stone-900">Permission-Controlled Admin Diagnostics</h3>
            </div>
            <span className="text-xs font-mono text-stone-400">Merchant admin role required</span>
          </div>

          {!isDiagnosticsUnlocked ? (
            <div className="p-8 text-center bg-stone-50 rounded-xl border border-stone-200 space-y-3">
              <Lock className="w-8 h-8 text-stone-400 mx-auto" />
              <p className="text-xs font-bold text-stone-900">Protected Diagnostic Console</p>
              <p className="text-xs text-stone-500 max-w-sm mx-auto">
                Contains technical schema payloads, sample crawl trace headers, and simulated demo diagnostic records.
              </p>
              <button
                onClick={() => setIsDiagnosticsUnlocked(true)}
                className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg shadow-xs"
              >
                Authenticate & Unlock Diagnostics
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="p-4 bg-stone-900 text-stone-100 rounded-xl font-mono text-xs space-y-2 overflow-x-auto">
                <p className="text-stone-400"># AIXSHOP Internal Schema & Sync Log (Simulated Demo Fixture)</p>
                <p className="text-emerald-400">✓ [2026-10-11T04:30:12Z] Feed Ingest: 184 products parsed from Shopify GraphQL (Demo)</p>
                <p className="text-emerald-400">✓ [2026-10-11T04:30:14Z] Schema.org Validator: 184/184 Product entities verified</p>
                <p className="text-amber-400">⚠ [2026-10-11T04:30:15Z] GTIN Validator: 1/184 variants missing EAN/UPC (var_candle_8oz)</p>
                <p className="text-rose-400">✖ [2026-10-11T04:30:16Z] Claim Conflict: SLA mismatch detected between Storefront (2d) and GMC (3-5d)</p>
                <p className="text-stone-400"># End of diagnostic dump</p>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setIsDiagnosticsUnlocked(false)}
                  className="px-3 py-1.5 text-xs text-stone-600 hover:text-stone-900 font-medium"
                >
                  Lock Diagnostics Console
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
