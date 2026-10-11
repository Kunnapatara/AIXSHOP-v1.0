import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  ArrowRight, 
  SearchCheck, 
  Layers, 
  CheckSquare, 
  AlertTriangle, 
  ShieldCheck, 
  FileText, 
  Store, 
  Package, 
  ExternalLink,
  ChevronRight,
  Sparkles,
  Info
} from 'lucide-react';

export const HomePage: React.FC = () => {
  const { 
    storeProfile, 
    products, 
    findings, 
    actionItems, 
    navigateTo, 
    viewProductDetail 
  } = useApp();

  const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
  const totalOffers = products.reduce((sum, p) => sum + p.offers.length, 0);
  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const pendingActions = actionItems.filter(a => a.status === 'pending_review');
  const recentFindings = findings.slice(0, 4);

  return (
    <div className="space-y-8">
      {/* Store Identity & Banner */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-orange-100 border border-orange-200 flex items-center justify-center text-orange-700 shrink-0">
            <Store className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
                {storeProfile.name}
              </h1>
              <span className="text-xs font-mono font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                Connector Active
              </span>
            </div>
            <p className="text-xs text-stone-500 font-mono mt-0.5">
              {storeProfile.platform} · {storeProfile.domain}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => navigateTo('audit')}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors flex items-center gap-1.5 min-h-[38px]"
          >
            <SearchCheck className="w-3.5 h-3.5 text-stone-600" />
            <span>Store Audit</span>
          </button>
          <button
            onClick={() => navigateTo('actions')}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs min-h-[38px]"
          >
            <span>Action Queue ({pendingActions.length})</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tri-Partite Intelligence Metrics (Strict Semantic Separation) */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500">
            Catalog Intelligence & Discovery Metrics
          </h2>
          <span className="text-xs text-stone-400 font-mono">
            Derived from active store feed
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          {/* 1. Catalog Completeness */}
          <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs relative flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-600">
                  1. Catalog Completeness
                </span>
                <span className="text-xs font-mono text-stone-400">Internal Richness</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl sm:text-4xl font-extrabold font-mono text-stone-950 tabular-nums">
                  {storeProfile.catalogCompletenessAvg}%
                </span>
                <span className="text-xs text-stone-500 font-mono">/ 100</span>
              </div>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                Measures field population, attribute granularity (materials, dimensions, allergens), and structured schema.org data.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs text-stone-500 font-mono">
              <span>{products.length} Products</span>
              <span>{totalVariants} Variants</span>
            </div>
          </div>

          {/* 2. Evidence Coverage */}
          <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs relative flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-600">
                  2. Evidence Coverage
                </span>
                <span className="text-xs font-mono text-stone-400">Claim Backing</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl sm:text-4xl font-extrabold font-mono text-stone-950 tabular-nums">
                  {storeProfile.evidenceCoverageAvg}%
                </span>
                <span className="text-xs text-stone-500 font-mono">/ 100</span>
              </div>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                Measures specifications substantiated by verifiable documents (lab cupping sheets, OEKO-TEX licenses, GTIN barcodes).
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs text-stone-500 font-mono">
              <span>Strict Truth Policy</span>
              <span className="text-amber-700">1 Unverified Claim</span>
            </div>
          </div>

          {/* 3. External AI Discovery Observations */}
          <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs relative flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-600">
                  3. External AI Observations
                </span>
                <span className="text-xs font-mono text-stone-400">Empirical Sample</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl sm:text-4xl font-extrabold font-mono text-stone-950 tabular-nums">
                  75%
                </span>
                <span className="text-xs text-stone-500 font-mono">observed in probe</span>
              </div>
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                Sample queries where products were observed in search grounding. Clearly labeled as sample observation, not guaranteed ranking.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs text-stone-500">
              <span className="text-stone-400 font-mono">Sample Size: 24 queries</span>
              <span className="text-stone-500">No ranking guarantee</span>
            </div>
          </div>
        </div>
      </div>

      {/* Commercial Offers vs Products Distinction */}
      <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-600">
              Canonical Model: Product ≠ Commercial Offer
            </h3>
            <p className="text-xs text-stone-600 mt-1">
              Your store maintains <strong className="text-stone-900">{products.length} canonical products</strong> with <strong className="text-stone-900">{totalVariants} variants</strong> distributed across <strong className="text-stone-900">{totalOffers} commercial offers</strong> (Direct Storefront, Google Shopping Feed, B2B).
            </p>
          </div>
          <button
            onClick={() => navigateTo('products')}
            className="px-3 py-1.5 bg-white border border-stone-300 hover:border-stone-400 text-xs font-medium text-stone-800 rounded-lg shrink-0 flex items-center gap-1.5 min-h-[36px]"
          >
            <span>Explore Catalog</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Two Column Section: Priority Findings & Recommended Next Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Priority Findings Feed (7 Cols) */}
        <div className="lg:col-span-7 bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div>
              <h2 className="text-base font-bold text-stone-950">
                Priority Catalog Findings
              </h2>
              <p className="text-xs text-stone-500">
                {criticalFindings.length} critical issues limiting discovery
              </p>
            </div>
            <button
              onClick={() => navigateTo('audit')}
              className="text-xs font-semibold text-orange-600 hover:text-orange-700 flex items-center gap-1"
            >
              <span>View All ({findings.length})</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {recentFindings.map(finding => {
              const severityStyles = {
                critical: 'text-rose-700 bg-rose-50 border-rose-200',
                high: 'text-amber-700 bg-amber-50 border-amber-200',
                medium: 'text-stone-700 bg-stone-100 border-stone-200',
                low: 'text-stone-600 bg-stone-50 border-stone-200',
              };

              return (
                <div
                  key={finding.id}
                  className="p-3.5 rounded-xl border border-stone-200/90 hover:border-stone-300 transition-colors bg-stone-50/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] font-semibold font-mono uppercase px-2 py-0.5 rounded border ${severityStyles[finding.severity]}`}>
                        {finding.severity}
                      </span>
                      <span className="text-xs text-stone-500 font-mono capitalize">
                        {finding.scope} scope
                      </span>
                    </div>
                    {finding.productId && (
                      <button
                        onClick={() => viewProductDetail(finding.productId!, 'home')}
                        className="text-xs text-stone-500 hover:text-stone-900 font-medium underline flex items-center gap-1"
                      >
                        <span>Product</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  <h3 className="text-sm font-bold text-stone-900 mt-2 leading-snug">
                    {finding.title}
                  </h3>

                  <p className="text-xs text-stone-600 mt-1 line-clamp-2 leading-relaxed">
                    {finding.description}
                  </p>

                  <div className="mt-2.5 pt-2 border-t border-stone-200/60 flex items-center justify-between text-xs">
                    <span className="text-stone-500 italic">
                      Why it matters: {finding.whyItMatters.substring(0, 70)}...
                    </span>
                    <button
                      onClick={() => navigateTo('actions')}
                      className="text-xs font-semibold text-orange-600 hover:text-orange-700 shrink-0 ml-2"
                    >
                      Remediate →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Recommended Next Actions Queue (5 Cols) */}
        <div className="lg:col-span-5 bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div>
                <h2 className="text-base font-bold text-stone-950">
                  Recommended Next Actions
                </h2>
                <p className="text-xs text-stone-500">
                  {pendingActions.length} items awaiting review
                </p>
              </div>
              <button
                onClick={() => navigateTo('actions')}
                className="text-xs font-semibold text-orange-600 hover:text-orange-700 flex items-center gap-1"
              >
                <span>Action Center</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {pendingActions.slice(0, 3).map(action => (
                <div key={action.id} className="p-3 bg-stone-50 rounded-xl border border-stone-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-stone-900 leading-snug">
                      {action.title}
                    </span>
                    <span className="text-[10px] font-mono font-medium text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                      {action.severity}
                    </span>
                  </div>
                  <p className="text-xs font-mono text-stone-500 mt-1">
                    {action.proposedChange.field}: {action.proposedChange.to}
                  </p>
                  <div className="mt-2 flex items-center justify-between pt-2 border-t border-stone-200/60">
                    <span className="text-[11px] text-stone-500">
                      {action.evidenceRequired ? 'Evidence required' : 'Self-certifiable'}
                    </span>
                    <button
                      onClick={() => navigateTo('actions')}
                      className="text-xs font-semibold text-stone-900 hover:text-orange-600"
                    >
                      Review & Approve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Shortcuts to Primary Destinations */}
          <div className="pt-4 border-t border-stone-100 grid grid-cols-2 gap-2 text-xs">
            <button
              onClick={() => navigateTo('audit')}
              className="p-3 bg-stone-50 hover:bg-stone-100 rounded-xl border border-stone-200 text-left font-medium text-stone-800 flex flex-col justify-between"
            >
              <SearchCheck className="w-4 h-4 text-orange-600 mb-1" />
              <span>Full Audit Findings</span>
            </button>
            <button
              onClick={() => navigateTo('products')}
              className="p-3 bg-stone-50 hover:bg-stone-100 rounded-xl border border-stone-200 text-left font-medium text-stone-800 flex flex-col justify-between"
            >
              <Layers className="w-4 h-4 text-orange-600 mb-1" />
              <span>Manage Products</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
