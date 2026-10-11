import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
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
  RefreshCw
} from 'lucide-react';

export const LandingPage: React.FC = () => {
  const { 
    navigateTo, 
    runStoreCheck, 
    quickCheckResult, 
    isCheckingStore, 
    storeProfile 
  } = useApp();

  const [urlInput, setUrlInput] = useState('https://solsticecraftgoods.store');
  const [urlError, setUrlError] = useState<string | null>(null);

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
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">100%</p>
                <p className="text-xs text-stone-500 mt-0.5">Evidence-Gated Checks</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">Product ≠ Offer</p>
                <p className="text-xs text-stone-500 mt-0.5">Canonical Data Model</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-mono text-stone-900 tabular-nums">Zero Claims</p>
                <p className="text-xs text-stone-500 mt-0.5">No Fake AI Ranking Hype</p>
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
              <span>Evaluates: Schema.org JSON-LD · Variant GTIN/UPC completeness · Attribute conflicts</span>
              <span className="font-mono text-stone-400">Demonstration analysis preview mode</span>
            </div>
          </form>

          {/* Quick Health Check Result */}
          {quickCheckResult && (
            <div className="mt-8 bg-white border border-stone-200 rounded-2xl p-6 shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-stone-100 gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-stone-100 text-stone-700">
                      Quick Health Check Result
                    </span>
                    <span className="text-xs text-stone-500 font-mono">
                      {quickCheckResult.detectedPlatform}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-stone-950 mt-1 font-mono truncate">
                    {quickCheckResult.url}
                  </h3>
                </div>

                <button
                  onClick={() => navigateTo('audit')}
                  className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors shrink-0"
                >
                  <span>Review Full Audit</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

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
                  Enter Solstice Workspace
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
            AI shopping models do not guess. If a spec is missing, contradictory, or unevidenced, the assistant drops the product or reports uncertainty.
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
                Unsubstantiated claims (e.g. "organic", "fair trade", "biodegradable") without certifying registry documents trigger greenwashing flags. We attach verified proof to every claim.
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

      {/* Pricing Section with Real SKU Limits */}
      <section id="pricing" className="px-4 sm:px-8 py-16 max-w-7xl mx-auto w-full">
        <div className="max-w-2xl mx-auto text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-950">
            Transparent Pricing by Catalog Capacity
          </h2>
          <p className="text-sm text-stone-600 mt-2">
            Pricing scaled by verified SKU limits with full audit capabilities included across all plans.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white border border-stone-200 rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <span className="text-xs font-semibold text-stone-500">For Boutique Brands</span>
              <h3 className="text-xl font-bold text-stone-900 mt-1">Starter Tier</h3>
              <p className="text-2xl font-bold text-stone-900 mt-3 font-mono">$49<span className="text-xs font-sans text-stone-500 font-normal"> / month</span></p>
              <ul className="mt-6 space-y-2.5 text-xs text-stone-600">
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Up to 250 SKUs</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Daily catalog schema audit</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> GTIN & barcode consistency check</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> 1 Storefront connector (Shopify / Woo)</li>
              </ul>
            </div>
            <button
              onClick={() => navigateTo('home')}
              className="mt-8 w-full py-2.5 text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-900 rounded-xl transition-colors min-h-[44px]"
            >
              Start Free Trial
            </button>
          </div>

          <div className="bg-white border-2 border-orange-600 rounded-2xl p-6 flex flex-col justify-between relative shadow-md">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-orange-600 text-white text-[11px] font-bold rounded-full uppercase tracking-wider">
              Current Active Store Tier
            </div>
            <div>
              <span className="text-xs font-semibold text-orange-700">For Growing Stores</span>
              <h3 className="text-xl font-bold text-stone-900 mt-1">Growth Tier</h3>
              <p className="text-2xl font-bold text-stone-900 mt-3 font-mono">$179<span className="text-xs font-sans text-stone-500 font-normal"> / month</span></p>
              <ul className="mt-6 space-y-2.5 text-xs text-stone-600">
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Up to 2,500 SKUs</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Continuous audit & conflict detection</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Evidence document registry</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Multi-channel feeds (Shopify + Google)</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Merchant remediation queue with re-check</li>
              </ul>
            </div>
            <button
              onClick={() => navigateTo('home')}
              className="mt-8 w-full py-2.5 text-xs font-semibold bg-orange-600 hover:bg-orange-700 text-white rounded-xl transition-colors min-h-[44px]"
            >
              Access Current Account
            </button>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <span className="text-xs font-semibold text-stone-500">For High-Volume Brands</span>
              <h3 className="text-xl font-bold text-stone-900 mt-1">Enterprise Tier</h3>
              <p className="text-2xl font-bold text-stone-900 mt-3 font-mono">$499<span className="text-xs font-sans text-stone-500 font-normal"> / month</span></p>
              <ul className="mt-6 space-y-2.5 text-xs text-stone-600">
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Unlimited SKUs & feeds</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Custom ERP & warehouse API connectors</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Dedicated evidence verification specialist</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> Automated write-back hooks (authorized)</li>
              </ul>
            </div>
            <button
              onClick={() => navigateTo('settings')}
              className="mt-8 w-full py-2.5 text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-900 rounded-xl transition-colors min-h-[44px]"
            >
              Contact Sales
            </button>
          </div>
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
                Approval in AIXSHOP verifies the remediation in your intelligence catalog. Live write-back to Shopify or your ERP requires explicit connector authorization with write permissions configured in Store / Settings.
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
