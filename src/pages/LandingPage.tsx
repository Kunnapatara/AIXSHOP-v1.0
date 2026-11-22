import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { AuthContext } from '../context/AuthContext';
import { apiClient, BillingPlan, PlanTier } from '../api/client';
import { isValidBillingRedirectUrl, isValidExternalHttpUrl, redirectBrowser } from '../domain/validation/shopify';
import { 
  ArrowRight, 
  Search, 
  ShieldCheck, 
  CheckCircle2, 
  AlertTriangle, 
  Info, 
  Layers, 
  SlidersHorizontal, 
  Sparkles, 
  ChevronRight,
  Database,
  Lock,
  FileCheck,
  Building2,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronUp,
  Check
} from 'lucide-react';

const SSR_DEFAULT_PAID_PLANS: BillingPlan[] = [
  {
    id: 'plan_starter',
    tier: 'Starter',
    name: 'Starter Plan',
    priceCents: 4900,
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: 250,
    features: [
      'Up to 250 SKUs',
      'On-demand catalog schema audit',
      'GTIN & barcode consistency check',
      'Read-only Shopify OAuth catalog sync',
    ],
  },
  {
    id: 'plan_growth',
    tier: 'Growth',
    name: 'Growth Plan',
    priceCents: 14900,
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: 2500,
    features: [
      'Up to 2,500 SKUs',
      'Rule-based audit & conflict detection',
      'Evidence document registry',
      'Google Merchant Center feed readiness',
      'Merchant remediation queue with re-check',
    ],
  },
  {
    id: 'plan_enterprise',
    tier: 'Enterprise',
    name: 'Enterprise Plan',
    priceCents: 49900,
    currency: 'USD',
    billingInterval: 'month',
    skuLimit: null,
    features: [
      'Unlimited SKUs & catalog audits',
      'Workspace-isolated PostgreSQL storage',
      'Historical audit snapshot & diff reports',
      'CSV & structured feed export',
    ],
  },
];

const PLAN_PRESENTATION_META: Record<string, { subtitle: string; badge?: string; ctaLabel: string }> = {
  Starter: {
    subtitle: 'For Boutique Brands',
    ctaLabel: 'Select Starter Plan',
  },
  Growth: {
    subtitle: 'For Growing Stores',
    badge: 'Demo Reference Tier',
    ctaLabel: 'Select Growth Plan',
  },
  Enterprise: {
    subtitle: 'For High-Volume Brands',
    ctaLabel: 'Select Enterprise Plan',
  },
};

function formatPlanPrice(priceCents: number, currency: string): string {
  const symbol = currency?.toUpperCase() === 'EUR' ? '€' : currency?.toUpperCase() === 'GBP' ? '£' : '$';
  const amount = priceCents / 100;
  return `${symbol}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatSkuCapacityLine(skuLimit: number | null): string {
  if (skuLimit === null || typeof skuLimit !== 'number' || !Number.isFinite(skuLimit)) {
    return 'Unlimited SKUs & catalog audits';
  }
  return `Up to ${skuLimit.toLocaleString()} verified SKUs`;
}

export const LandingPage: React.FC = () => {
  const { 
    navigateTo, 
    runStoreCheck, 
    quickCheckResult, 
    lastIngestionResult,
    importDiscoveredProducts,
    isReadOnlyMode,
    isCheckingStore, 
    storeProfile,
    isCloudWorkspace,
    reportEntitlement,
  } = useApp();
  const canViewQuickCheckMetrics = Boolean(isCloudWorkspace && reportEntitlement?.hasFullReportAccess);

  const authContext = useContext(AuthContext);
  const isAuthenticated = Boolean(authContext?.isAuthenticated);
  const authModalOpen = Boolean(authContext?.authModalOpen);
  const openAuthModal = authContext?.openAuthModal;

  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const [urlInput, setUrlInput] = useState('https://solsticecraftgoods.store');
  const [urlError, setUrlError] = useState<string | null>(null);

  // Authoritative Billing Plans & Checkout State
  const [paidPlans, setPaidPlans] = useState<BillingPlan[]>(SSR_DEFAULT_PAID_PLANS);
  const [freePlan, setFreePlan] = useState<BillingPlan | null>(null);
  const [plansLoading, setPlansLoading] = useState<boolean>(false);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [plansLoadedFromBackend, setPlansLoadedFromBackend] = useState<boolean>(false);
  const [checkoutLoadingTier, setCheckoutLoadingTier] = useState<PlanTier | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pendingPlanTier, setPendingPlanTier] = useState<PlanTier | null>(null);

  const checkoutInFlightRef = useRef<boolean>(false);
  const prevAuthModalOpenRef = useRef<boolean>(authModalOpen);

  const canStartPaidCheckout =
    plansLoadedFromBackend && !plansLoading && !plansError && paidPlans.length > 0;

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError(null);
    try {
      const res = await apiClient.getBillingPlans();
      const paid = res.plans.filter(p => p.priceCents > 0);
      const free = res.plans.find(p => p.priceCents === 0) || null;
      if (paid.length === 0) {
        throw new Error('Server returned no purchasable paid billing plans.');
      }
      setPaidPlans(paid);
      setFreePlan(free);
      setPlansLoadedFromBackend(true);
    } catch (err: any) {
      setPlansLoadedFromBackend(false);
      setPendingPlanTier(null);
      setPlansError(err?.message || 'Unable to load authoritative plans from server.');
    } finally {
      setPlansLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const initiateCheckout = useCallback(async (tier: PlanTier) => {
    if (!plansLoadedFromBackend || plansLoading || plansError) {
      setCheckoutError(
        'Authoritative plan pricing could not be verified from the server. Retry loading plans before starting checkout.'
      );
      return;
    }
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setCheckoutLoadingTier(tier);
    setCheckoutError(null);

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

      const session = await apiClient.createCheckoutSession({
        tier,
        ...(successUrl ? { successUrl } : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      });

      if (
        !session ||
        session.success !== true ||
        !isValidBillingRedirectUrl(session.checkoutUrl, {
          flow: 'checkout',
          provider: typeof session.provider === 'string' ? session.provider : undefined,
        })
      ) {
        throw new Error('Checkout session response missing a valid checkout URL.');
      }

      redirectBrowser(session.checkoutUrl);
    } catch (err: any) {
      setCheckoutError(err?.message || 'Failed to initiate Stripe checkout session.');
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutLoadingTier(null);
    }
  }, [plansLoadedFromBackend, plansLoading, plansError]);

  // Resume pending plan checkout immediately once authentication completes and plans are authoritative
  useEffect(() => {
    if (isAuthenticated && pendingPlanTier && canStartPaidCheckout) {
      const targetTier = pendingPlanTier;
      setPendingPlanTier(null);
      void initiateCheckout(targetTier);
    }
  }, [isAuthenticated, pendingPlanTier, canStartPaidCheckout, initiateCheckout]);

  // Clear pending plan if user closes AuthModal without signing in
  useEffect(() => {
    const wasOpen = prevAuthModalOpenRef.current;
    prevAuthModalOpenRef.current = authModalOpen;
    if (wasOpen && !authModalOpen && !isAuthenticated && pendingPlanTier) {
      setPendingPlanTier(null);
    }
  }, [authModalOpen, isAuthenticated, pendingPlanTier]);

  const handleSelectPlan = (tier: PlanTier) => {
    if (!canStartPaidCheckout) {
      setCheckoutError(
        'Authoritative plan pricing has not been loaded from the server. Please wait or retry loading plans before starting checkout.'
      );
      return;
    }
    if (checkoutInFlightRef.current || checkoutLoadingTier !== null) {
      return;
    }
    setCheckoutError(null);

    if (!isAuthenticated) {
      setPendingPlanTier(tier);
      if (openAuthModal) {
        openAuthModal('register');
      } else {
        setCheckoutError('Please sign in to subscribe to a paid plan.');
      }
      return;
    }

    void initiateCheckout(tier);
  };

  const handleStoreCheckSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError(null);

    const trimmed = urlInput.trim();
    if (!trimmed) {
      setUrlError('Please enter a store URL to inspect.');
      return;
    }

    try {
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      if (!parsed.hostname.includes('.')) {
        setUrlError('Please enter a valid store domain (e.g., yourstore.com).');
        return;
      }
    } catch {
      setUrlError('Please enter a valid store URL format.');
      return;
    }

    runStoreCheck(trimmed);
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#FAF8F5] text-stone-900 font-sans selection:bg-orange-500 selection:text-white">
      {/* Top Bar - 3 Zone Contract */}
      <header className="sticky top-0 z-30 bg-[#FAF8F5]/90 backdrop-blur border-b border-stone-200/80 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-8 max-w-7xl w-full mx-auto">
        {/* Zone 1: Wordmark */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm shadow-xs">
            AX
          </div>
          <span className="font-bold text-lg tracking-tight text-stone-950 whitespace-nowrap">
            AIXSHOP
          </span>
          <span className="text-xs font-mono text-stone-400 hidden sm:inline">v1.0</span>
        </div>

        {/* Zone 2: Navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-stone-600">
          <a href="#store-check" className="hover:text-stone-950 transition-colors whitespace-nowrap shrink-0">
            Store Check
          </a>
          <a href="#how-it-works" className="hover:text-stone-950 transition-colors whitespace-nowrap shrink-0">
            How It Works
          </a>
          <a href="#pricing" className="hover:text-stone-950 transition-colors whitespace-nowrap shrink-0">
            Pricing
          </a>
          <a href="#faq" className="hover:text-stone-950 transition-colors whitespace-nowrap shrink-0">
            Trust & Scope
          </a>
        </nav>

        {/* Zone 3: Primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => navigateTo('home')}
            className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-xs min-h-[40px] flex items-center gap-1.5"
          >
            <span>Enter Merchant App</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="px-4 sm:px-8 pt-12 pb-16 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 space-y-6">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-orange-800 bg-orange-100/80 px-3 py-1 rounded-md">
              <Sparkles className="w-3.5 h-3.5 text-orange-600" />
              <span>AI Commerce Visibility & Product Catalog Intelligence</span>
            </div>

            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-stone-950 leading-[1.15] text-balance">
              Turn incomplete product data into evidence-backed commerce intelligence.
            </h1>

            <p className="text-base sm:text-lg text-stone-600 leading-relaxed max-w-2xl">
              AI shopping assistants and search agents require structured facts, unambiguous specifications, and verifiable evidence. AIXSHOP pinpoints missing attributes, conflicting claims, and catalog discrepancies before they limit customer discovery.
            </p>

            {/* Quick Proof Strip */}
            <div className="pt-2 grid grid-cols-3 gap-4 border-t border-stone-200/80">
              <div>
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">Rule + Review</p>
                <p className="text-xs text-stone-500 mt-0.5">Automated + Evidence Checks</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">Product ≠ Offer</p>
                <p className="text-xs text-stone-500 mt-0.5">Canonical Data Model</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">No Ranking Claims</p>
                <p className="text-xs text-stone-500 mt-0.5">Strict Discovery Boundary</p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="relative rounded-2xl overflow-hidden border border-stone-200/90 shadow-md bg-stone-100">
              <img
                src="/src/assets/images/hero_commerce_catalog_1791719382300.jpg"
                alt="AIXSHOP commerce catalog intelligence visual"
                className="w-full h-80 sm:h-96 object-cover"
                referrerPolicy="no-referrer"
              />
              <div className="p-4 bg-white/95 border-t border-stone-200 backdrop-blur">
                <div className="flex items-center justify-between text-xs text-stone-500">
                  <span className="font-semibold text-stone-900">Solstice Craft Goods</span>
                  <span className="font-mono text-stone-500">Catalog Health: 84%</span>
                </div>
                <p className="text-xs text-stone-600 mt-1">
                  184 products indexed · 9 priority remediation items ready for merchant review.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Embedded Store Check Section (Mandatory inside Landing) */}
      <section id="store-check" className="bg-white border-y border-stone-200 px-4 sm:px-8 py-16">
        <div className="max-w-4xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-950">
              Run a Free Store Catalog Health Check
            </h2>
            <p className="text-sm text-stone-600 mt-2 leading-relaxed">
              Analyze public catalog metadata, schema markup completeness, GTIN consistency, and attribute conflicts across your product feed.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleStoreCheckSubmit} className="bg-stone-50 border border-stone-200 rounded-2xl p-4 sm:p-6 shadow-xs">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-5 h-5 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={e => {
                    setUrlInput(e.target.value);
                    if (urlError) setUrlError(null);
                  }}
                  placeholder="https://yourstore.com"
                  className="w-full pl-11 pr-4 py-3 bg-white border border-stone-300 rounded-xl text-sm font-medium text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-orange-500 min-h-[44px]"
                  aria-label="Online store URL"
                />
              </div>
              <button
                type="submit"
                disabled={isCheckingStore}
                className="px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl transition-all shadow-xs flex items-center justify-center gap-2 min-h-[44px] shrink-0 disabled:opacity-60"
              >
                {isCheckingStore ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Analyzing Schema...</span>
                  </>
                ) : (
                  <>
                    <span>Inspect Catalog</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>

            {urlError && (
              <p className="text-xs text-rose-600 mt-2 font-medium flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{urlError}</span>
              </p>
            )}

            <div className="mt-4 pt-3 border-t border-stone-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-stone-500">
              <span>Evaluates: Variant GTIN/UPC completeness · Attribute &amp; schema gaps · Claim conflicts</span>
              <span className="font-mono text-stone-400">Checks 25-product /products.json public feed sample (not a full site crawl) or demo fixture</span>
            </div>
          </form>

          {/* Quick Health Check Result */}
          {quickCheckResult && (
            <div className="mt-8 bg-white border border-stone-200 rounded-2xl p-6 shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-stone-100 gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-stone-100 text-stone-700">
                      {canViewQuickCheckMetrics ? 'Quick Health Check Result' : 'Catalog Source Inspected'}
                    </span>
                    <span className="text-xs text-stone-500 font-mono">
                      {quickCheckResult.detectedPlatform}
                      {quickCheckResult.ingestionResult?.source?.classification === 'public_feed'
                        ? ' · Public Feed (25-product sample)'
                        : quickCheckResult.ingestionResult?.source?.classification === 'demo'
                        ? ' · Demo Fixture'
                        : ''}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-stone-950 mt-1 font-mono truncate">
                    {quickCheckResult.url}
                  </h3>
                </div>

                {canViewQuickCheckMetrics ? (
                  <button
                    onClick={() => navigateTo('audit')}
                    className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors shrink-0"
                  >
                    <span>Review Full Audit</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <a
                    href="#pricing"
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors shrink-0"
                  >
                    <span>Choose Paid Plan to Unlock Audit</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>

              {canViewQuickCheckMetrics ? (
                <>
                  {/* Metric Breakdown */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200/80">
                      <p className="text-xs text-stone-500 font-medium">Catalog Completeness</p>
                      <p className="text-2xl font-bold font-mono text-stone-900 mt-1 tabular-nums">
                        {quickCheckResult.catalogCompletenessEstimate}%
                      </p>
                    </div>
                    <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200/80">
                      <p className="text-xs text-stone-500 font-medium">GTIN / UPC Coverage</p>
                      <p className="text-2xl font-bold font-mono text-stone-900 mt-1 tabular-nums">
                        {quickCheckResult.gtinPresentRatio}%
                      </p>
                    </div>
                    <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200/80">
                      <p className="text-xs text-stone-500 font-medium">Conflicting Claims</p>
                      <p className="text-2xl font-bold font-mono text-rose-600 mt-1 tabular-nums">
                        {quickCheckResult.conflictingClaimsCount}
                      </p>
                    </div>
                    <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200/80">
                      <p className="text-xs text-stone-500 font-medium">Missing Attributes</p>
                      <p className="text-2xl font-bold font-mono text-amber-600 mt-1 tabular-nums">
                        {quickCheckResult.missingAttributesCount}
                      </p>
                    </div>
                  </div>

                  {/* Sample Issues */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-stone-700 uppercase tracking-wider">
                      Sample High-Priority Gaps Detected
                    </p>
                    <div className="space-y-2">
                      {quickCheckResult.sampleIssues.map((issue, idx) => (
                        <div key={idx} className="flex items-start gap-2.5 text-xs text-stone-700 bg-amber-50/60 p-3 rounded-lg border border-amber-200/60">
                          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <span>{issue}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl flex items-start gap-3">
                  <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs">
                    <p className="font-bold text-amber-950">
                      Audit Findings &amp; Diagnostic Metrics Locked Until Payment
                    </p>
                    <p className="text-amber-900 leading-relaxed">
                      Storefront eligibility and catalog items have been discovered ({quickCheckResult.ingestionResult?.candidateProducts?.length ?? 0} candidate products detected). Paid plan verification is required before computing or displaying catalog completeness scores, GTIN gaps, severity counts, or audit reports.
                    </p>
                  </div>
                </div>
              )}

              {/* Safe Catalog Import Section */}
              {(() => {
                const ingestion = lastIngestionResult || quickCheckResult.ingestionResult;
                if (!ingestion || !ingestion.candidateProducts || ingestion.candidateProducts.length === 0) {
                  return null;
                }

                const eligibleList = ingestion.evaluationDetails.filter(d => d.status === 'eligible');
                const duplicateList = ingestion.evaluationDetails.filter(d => d.status === 'duplicate');
                const conflictList = ingestion.evaluationDetails.filter(d => d.status === 'conflict');
                const rejectedList = ingestion.evaluationDetails.filter(d => d.status === 'rejected');

                const eligibleCount = eligibleList.length;
                const duplicateCount = duplicateList.length;
                const conflictCount = conflictList.length;
                const rejectedCount = rejectedList.length;

                const handleImportClick = async () => {
                  setIsImporting(true);
                  try {
                    await importDiscoveredProducts();
                  } finally {
                    setIsImporting(false);
                  }
                };

                return (
                  <div className="bg-stone-50 border border-stone-200/90 rounded-xl p-5 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Download className="w-4 h-4 text-emerald-600" />
                          <h4 className="text-sm font-bold text-stone-900">
                            Discovered Product Feed ({ingestion.candidateProducts.length} Items)
                          </h4>
                          {ingestion.source.isPartialSample && (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                              25-Product Sample
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-stone-600 mt-1">
                          Review discovered products before safe catalog import. Duplicates and merchant-edited fields are protected from overwrite.
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setIsReviewOpen(!isReviewOpen)}
                          className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-100 rounded-lg flex items-center gap-1.5 transition-colors"
                        >
                          <span>{isReviewOpen ? 'Hide Records' : 'Review Records'}</span>
                          {isReviewOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>

                        <button
                          type="button"
                          onClick={handleImportClick}
                          disabled={isImporting || isReadOnlyMode || eligibleCount === 0}
                          className={`px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors shadow-xs ${
                            isReadOnlyMode
                              ? 'bg-stone-300 text-stone-500 cursor-not-allowed'
                              : eligibleCount > 0
                              ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                              : 'bg-stone-200 text-stone-600 cursor-default'
                          }`}
                        >
                          {isImporting ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Importing...</span>
                            </>
                          ) : eligibleCount > 0 ? (
                            <>
                              <Download className="w-3.5 h-3.5" />
                              <span>Import {eligibleCount} Eligible Products</span>
                            </>
                          ) : (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              <span>All Records In Catalog</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Eligibility Metric Pill Breakdown */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                      <div className="bg-white px-3 py-2 rounded-lg border border-stone-200/80 flex items-center justify-between">
                        <span className="text-xs text-stone-600 font-medium">Eligible for Import</span>
                        <span className="text-xs font-bold font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                          {eligibleCount}
                        </span>
                      </div>
                      <div className="bg-white px-3 py-2 rounded-lg border border-stone-200/80 flex items-center justify-between">
                        <span className="text-xs text-stone-600 font-medium">Already in Catalog</span>
                        <span className="text-xs font-bold font-mono text-stone-700 bg-stone-100 px-2 py-0.5 rounded">
                          {duplicateCount}
                        </span>
                      </div>
                      <div className="bg-white px-3 py-2 rounded-lg border border-stone-200/80 flex items-center justify-between">
                        <span className="text-xs text-stone-600 font-medium">Merchant Conflicts</span>
                        <span className="text-xs font-bold font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                          {conflictCount}
                        </span>
                      </div>
                      <div className="bg-white px-3 py-2 rounded-lg border border-stone-200/80 flex items-center justify-between">
                        <span className="text-xs text-stone-600 font-medium">Incomplete / Rejected</span>
                        <span className="text-xs font-bold font-mono text-rose-700 bg-rose-50 px-2 py-0.5 rounded">
                          {rejectedCount}
                        </span>
                      </div>
                    </div>

                    {/* Collapsible Candidate Records List */}
                    {isReviewOpen && (
                      <div className="mt-3 bg-white border border-stone-200 rounded-xl overflow-hidden shadow-xs">
                        <div className="max-h-72 overflow-y-auto divide-y divide-stone-100">
                          {ingestion.evaluationDetails.map((detail, idx) => {
                            const p = detail.product || ingestion.candidateProducts[idx];
                            const variantCount = p?.variants?.length || 0;
                            const samplePrice = p?.variants?.[0]?.price;

                            return (
                              <div key={idx} className="p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-stone-50">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-semibold text-stone-900 truncate">
                                      {detail.title}
                                    </span>
                                    <span className="text-stone-400 font-mono text-[11px]">
                                      ID: {detail.sourceId || detail.productId}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-3 text-stone-500 text-[11px] mt-0.5 flex-wrap">
                                    <span>Brand: {detail.brand || '(missing)'}</span>
                                    <span>Category: {detail.category || '(missing)'}</span>
                                    <span>{variantCount} variant{variantCount !== 1 ? 's' : ''}</span>
                                    <span className="font-mono font-medium">{samplePrice != null ? `$${samplePrice.toFixed(2)}` : <span className="text-stone-400 italic font-sans">Unpriced</span>}</span>
                                  </div>
                                  {detail.reasons.length > 0 && (
                                    <p className="text-[11px] text-stone-500 mt-1 italic">
                                      {detail.reasons.join(' · ')}
                                    </p>
                                  )}
                                </div>

                                <div className="shrink-0 flex items-center gap-2">
                                  {detail.status === 'eligible' && (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800">
                                      Eligible for Import
                                    </span>
                                  )}
                                  {detail.status === 'duplicate' && (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-stone-100 text-stone-600">
                                      In Catalog (Skipped)
                                    </span>
                                  )}
                                  {detail.status === 'conflict' && (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800">
                                      Merchant Value Preserved
                                    </span>
                                  )}
                                  {detail.status === 'rejected' && (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-100 text-rose-800">
                                      Ineligible (Missing Fields)
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Clear Transition to Full Merchant App */}
              <div className="p-4 bg-orange-50/70 border border-orange-200 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="text-xs text-stone-700">
                  <p className="font-semibold text-stone-900">Ready to audit and remediate catalog issues?</p>
                  <p className="mt-0.5 text-stone-600">Access the Merchant Workspace with complete evidence logs and verified action queue.</p>
                </div>
                <button
                  onClick={() => navigateTo('home')}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors shrink-0 whitespace-nowrap"
                >
                  Open Merchant Workspace
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Value Proposition & How It Works */}
      <section id="how-it-works" className="px-4 sm:px-8 py-16 max-w-7xl mx-auto w-full">
        <div className="max-w-2xl mx-auto text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-950">
            Why Catalog Completeness Governs AI Discovery
          </h2>
          <p className="text-sm text-stone-600 mt-2 leading-relaxed">
            Missing or conflicting product attributes can reduce machine-readable clarity and may result in incomplete product information. AIXSHOP identifies these catalog data-quality issues and provides evidence-backed recommendations.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center text-orange-700 mb-4 font-bold text-sm">
                01
              </div>
              <h3 className="text-base font-bold text-stone-900">
                Product Identity vs Commercial Offer
              </h3>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                We strictly separate product specifications (materials, origin, dimensions) from ephemeral commercial offers (price, stock, marketplace channel). This prevents inconsistent claims across channels.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-stone-100 text-xs font-mono text-stone-500">
              Canonical identity architecture
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-stone-100 flex items-center justify-center text-stone-700 mb-4 font-bold text-sm">
                02
              </div>
              <h3 className="text-base font-bold text-stone-900">
                Evidence-Backed Verification
              </h3>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                Unsubstantiated claims (e.g. &quot;organic&quot;, &quot;fair trade&quot;, &quot;biodegradable&quot;) without certifying registry documents trigger claim-evidence findings. AIXSHOP helps merchants attach supporting documents for manual review.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-stone-100 text-xs font-mono text-stone-500">
              Provenance & lab report binding
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-stone-100 flex items-center justify-center text-stone-700 mb-4 font-bold text-sm">
                03
              </div>
              <h3 className="text-base font-bold text-stone-900">
                Human-Approved Remediation
              </h3>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                No hallucinated automatic writes. Merchants review evidence, inspect proposed corrections, approve changes, and re-check catalog consistency with verified records.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-stone-100 text-xs font-mono text-stone-500">
              Authorized merchant review queue
            </div>
          </div>
        </div>
      </section>

      {/* Honest Boundary: Catalog Completeness vs External AI Discovery */}
      <section className="bg-stone-100/70 border-y border-stone-200 px-4 sm:px-8 py-12">
        <div className="max-w-4xl mx-auto bg-white border border-stone-200 rounded-2xl p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <ShieldCheck className="w-6 h-6 text-orange-600 shrink-0 mt-1" />
            <div className="space-y-2">
              <h3 className="text-base font-bold text-stone-900">
                AIXSHOP Truth Boundary & Integrity Standard
              </h3>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                We never promise or guarantee AI rankings, top recommendations, inclusion in specific LLM shopping responses, or increased sales. External AI assistants operate proprietary indexing models outside merchant control. AIXSHOP focuses strictly on verifiable catalog completeness, schema compliance, attribute consistency, and evidence coverage.
              </p>
              <div className="pt-2 flex flex-wrap gap-4 text-xs font-medium text-stone-500">
                <span>· Completeness is internal data richness</span>
                <span>· Evidence is verified backing</span>
                <span>· Discovery is external observation</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section with Authoritative Server Plans */}
      <section id="pricing" className="px-4 sm:px-8 py-16 max-w-7xl mx-auto w-full">
        <div className="max-w-2xl mx-auto text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-950">
            Transparent Pricing by Catalog Capacity
          </h2>
          <p className="text-sm text-stone-600 mt-2">
            Free Audit enables non-recurring catalog onboarding up to 2,500 SKUs; paid plans unlock catalog audits, full findings, evidence trails, remediation workflows, and feed exports by verified catalog capacity.
          </p>
          <p className="text-xs text-stone-500 mt-1.5">
            {freePlan
              ? `Free Audit ($0, non-recurring): ${freePlan.skuLimit?.toLocaleString() ?? '2,500'}-SKU catalog onboarding capacity (no audit results before payment). `
              : ''}
            Starter (250 verified SKUs), Growth (2,500 verified SKUs), and Enterprise (Unlimited SKUs) unlock full reporting upon verified Stripe payment.
          </p>
        </div>

        {plansLoading && !plansLoadedFromBackend && (
          <div className="mb-6 text-center text-xs text-stone-500 flex items-center justify-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Loading authoritative server pricing...</span>
          </div>
        )}

        {!plansLoadedFromBackend && !plansLoading && !plansError && (
          <div className="mb-6 max-w-2xl mx-auto p-3 bg-stone-100 border border-stone-200 rounded-xl text-xs text-stone-700 text-center">
            Reference pricing preview shown. Paid checkout activates only after authoritative server plans are loaded.
          </div>
        )}

        {plansError && (
          <div
            role="alert"
            className="mb-6 max-w-2xl mx-auto p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  Authoritative billing plans could not be verified. Paid checkout is temporarily disabled.
                </p>
                <p className="mt-0.5 text-amber-800">
                  {plansError} Reference pricing cards remain shown for preview only; Free Audit and Store Check remain available.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadPlans()}
              className="px-3 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 rounded-lg font-semibold text-amber-900 shrink-0 self-start sm:self-center"
            >
              Retry
            </button>
          </div>
        )}

        {checkoutError && (
          <div
            role="alert"
            className="mb-6 max-w-2xl mx-auto p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{checkoutError}</span>
          </div>
        )}

        {pendingPlanTier && !isAuthenticated && canStartPaidCheckout && (
          <div className="mb-6 max-w-2xl mx-auto p-3 bg-orange-50 border border-orange-200 rounded-xl text-xs text-orange-900 text-center">
            Sign in or create a workspace account to continue checkout for <strong>{pendingPlanTier}</strong>.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {paidPlans.map(plan => {
            const meta = PLAN_PRESENTATION_META[plan.tier] || {
              subtitle: 'Catalog Intelligence Plan',
              ctaLabel: `Select ${plan.tier}`,
            };
            const isHighlighted = plan.tier === 'Growth';
            const isSelectingThis = checkoutLoadingTier === plan.tier;
            const isAnyCheckoutLoading = checkoutLoadingTier !== null;
            const isPlanCheckoutDisabled = !canStartPaidCheckout || isAnyCheckoutLoading;
            const intervalLabel =
              plan.billingInterval === 'none'
                ? null
                : plan.billingInterval === 'year'
                ? 'year'
                : 'month';

            return (
              <div
                key={plan.id}
                data-plan-tier={plan.tier}
                className={
                  isHighlighted
                    ? 'bg-white border-2 border-orange-600 rounded-2xl p-6 flex flex-col justify-between relative shadow-md'
                    : 'bg-white border border-stone-200 rounded-2xl p-6 flex flex-col justify-between'
                }
              >
                {meta.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-orange-600 text-white text-[11px] font-bold rounded-full uppercase tracking-wider">
                    {meta.badge}
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-xs font-semibold ${
                        isHighlighted ? 'text-orange-700' : 'text-stone-500'
                      }`}
                    >
                      {meta.subtitle}
                    </span>
                    {!plansLoadedFromBackend && (
                      <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                        Unverified preview
                      </span>
                    )}
                  </div>
                  <h3 className="text-xl font-bold text-stone-900 mt-1">{plan.name}</h3>
                  <p className="text-2xl font-bold text-stone-900 mt-3 font-mono">
                    {formatPlanPrice(plan.priceCents, plan.currency)}
                    {intervalLabel && (
                      <span className="text-xs font-sans text-stone-500 font-normal"> / {intervalLabel}</span>
                    )}
                  </p>
                  <p className="text-xs text-stone-500 mt-1 font-medium">
                    {formatSkuCapacityLine(plan.skuLimit)}
                  </p>
                  <ul className="mt-6 space-y-2.5 text-xs text-stone-600">
                    {plan.features.map((feature, idx) => (
                      <li key={idx} className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-8">
                  <button
                    type="button"
                    disabled={isPlanCheckoutDisabled}
                    aria-disabled={isPlanCheckoutDisabled}
                    onClick={() => handleSelectPlan(plan.tier)}
                    className={`w-full py-2.5 text-xs font-semibold rounded-xl transition-colors min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed ${
                      isHighlighted
                        ? 'bg-orange-600 hover:bg-orange-700 text-white'
                        : 'bg-stone-100 hover:bg-stone-200 text-stone-900'
                    }`}
                  >
                    {isSelectingThis ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Starting Checkout...</span>
                      </>
                    ) : (
                      <span>{meta.ctaLabel}</span>
                    )}
                  </button>
                  {!canStartPaidCheckout && !isSelectingThis && (
                    <p className="mt-2 text-center text-[11px] font-medium text-amber-700">
                      {plansLoading
                        ? 'Verifying authoritative server pricing...'
                        : 'Checkout disabled until server pricing is verified'}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Frequently Asked Questions */}
      <section id="faq" className="bg-stone-50 border-t border-stone-200 px-4 sm:px-8 py-16">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="text-center mb-8">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-950">
              Questions & Scope Boundaries
            </h2>
          </div>

          <div className="space-y-4">
            <div className="p-5 bg-white rounded-xl border border-stone-200">
              <h3 className="text-sm font-bold text-stone-900">
                Does AIXSHOP guarantee my products will appear in ChatGPT or Google AI shopping?
              </h3>
              <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
                No. No ethical platform can guarantee inclusion in external LLM answers. AIXSHOP ensures that when AI crawlers query your catalog, your specifications are complete, evidenced, and free of contradictions that lead to exclusion.
              </p>
            </div>

            <div className="p-5 bg-white rounded-xl border border-stone-200">
              <h3 className="text-sm font-bold text-stone-900">
                What is the difference between a Product and an Offer?
              </h3>
              <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
                A Product is the invariant item (origin, dimensions, ingredients, roast profile). An Offer is a specific commercial transaction context (price on direct website vs price on wholesale portal, availability in stock). AIXSHOP keeps these distinct to prevent feed mismatches.
              </p>
            </div>

            <div className="p-5 bg-white rounded-xl border border-stone-200">
              <h3 className="text-sm font-bold text-stone-900">
                Does approving a correction write directly to my live store?
              </h3>
              <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
                Approval in AIXSHOP updates your verified workspace intelligence catalog and audit trail only. Live write-back to Shopify or external ERPs is not implemented in this version; Shopify integration operates in read-only catalog sync mode.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-200 bg-white px-4 sm:px-8 py-8 text-xs text-stone-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-bold text-stone-900">AIXSHOP v1.0</span>
            <span>· AI Commerce Visibility & Product Catalog Intelligence</span>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => navigateTo('home')} className="hover:text-stone-900">Merchant Home</button>
            <button onClick={() => navigateTo('audit')} className="hover:text-stone-900">Audit</button>
            <button onClick={() => navigateTo('products')} className="hover:text-stone-900">Products</button>
            <button onClick={() => navigateTo('actions')} className="hover:text-stone-900">Actions</button>
            <button onClick={() => navigateTo('settings')} className="hover:text-stone-900">Settings</button>
          </div>
        </div>
      </footer>
    </div>
  );
};
