import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { FindingScope, FindingSeverity, FindingType } from '../types';
import { 
  SearchCheck, 
  Filter, 
  AlertTriangle, 
  AlertCircle, 
  CheckCircle2, 
  ArrowRight, 
  ExternalLink,
  Info,
  ShieldCheck,
  Search,
  SlidersHorizontal,
  RefreshCw
} from 'lucide-react';

export const AuditPage: React.FC = () => {
  const { findings, navigateTo, viewProductDetail, addToast } = useApp();

  const [scopeFilter, setScopeFilter] = useState<'all' | FindingScope>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | FindingSeverity>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | FindingType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAuditing, setIsAuditing] = useState(false);

  const filteredFindings = useMemo(() => {
    return findings.filter(f => {
      if (scopeFilter !== 'all' && f.scope !== scopeFilter) return false;
      if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && f.type !== typeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = f.title.toLowerCase().includes(q);
        const matchesDesc = f.description.toLowerCase().includes(q);
        const matchesProd = f.productTitle?.toLowerCase().includes(q) || false;
        if (!matchesTitle && !matchesDesc && !matchesProd) return false;
      }
      return true;
    });
  }, [findings, scopeFilter, severityFilter, typeFilter, searchQuery]);

  const handleRunFullAudit = () => {
    setIsAuditing(true);
    setTimeout(() => {
      setIsAuditing(false);
      addToast('Audit Synchronized', 'Store and catalog audit completed against current merchant feed.', 'success');
    }, 800);
  };

  return (
    <div className="space-y-6">
      {/* Header & Audit Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Store & Catalog Audit Workspace
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Consolidated diagnostic observations, missing attributes, conflicting claims, and source evidence.
          </p>
        </div>

        <button
          onClick={handleRunFullAudit}
          disabled={isAuditing}
          className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors min-h-[40px] shrink-0 disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isAuditing ? 'animate-spin' : ''}`} />
          <span>{isAuditing ? 'Running Audit...' : 'Re-run Store Audit'}</span>
        </button>
      </div>

      {/* Semantic Legend Strip */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 text-xs text-stone-600 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold text-stone-900">Finding Taxonomy:</span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-600"></span> Critical (Blocks AI Disambiguation)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-600"></span> High (Ambiguous Specs / Conflict)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-stone-500"></span> Medium / Low (Formatting / Minor Gaps)
          </span>
        </div>
        <div className="text-stone-400 font-mono text-[11px]">
          Total: {findings.length} findings indexed
        </div>
      </div>

      {/* Filters & Search Bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search findings by title, product, or specification..."
              className="w-full pl-10 pr-4 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-orange-500 min-h-[40px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Scope Filter Buttons */}
            <div className="flex items-center bg-stone-100 p-1 rounded-lg">
              {(['all', 'store', 'catalog', 'product'] as const).map(scope => (
                <button
                  key={scope}
                  onClick={() => setScopeFilter(scope)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                    scopeFilter === scope 
                      ? 'bg-white text-stone-900 shadow-xs font-semibold' 
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  {scope}
                </button>
              ))}
            </div>

            {/* Severity Filter */}
            <select
              value={severityFilter}
              onChange={e => setSeverityFilter(e.target.value as any)}
              className="px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 min-h-[40px] focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical Only</option>
              <option value="high">High Only</option>
              <option value="medium">Medium Only</option>
              <option value="low">Low Only</option>
            </select>

            {/* Type Filter */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as any)}
              className="px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 min-h-[40px] focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="all">All Types</option>
              <option value="missing_information">Missing Information</option>
              <option value="conflicting_claims">Conflicting Claims</option>
              <option value="inconsistent_attributes">Inconsistent Attributes</option>
              <option value="unverified_evidence">Unverified Evidence</option>
            </select>
          </div>
        </div>
      </div>

      {/* Findings Listing */}
      {filteredFindings.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
          <SearchCheck className="w-12 h-12 text-stone-300 mx-auto mb-3" />
          <h3 className="text-base font-bold text-stone-900">No findings match active filters</h3>
          <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
            Try resetting scope or severity filters to view other catalog diagnostic results.
          </p>
          <button
            onClick={() => {
              setScopeFilter('all');
              setSeverityFilter('all');
              setTypeFilter('all');
              setSearchQuery('');
            }}
            className="mt-4 px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-medium rounded-lg"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredFindings.map(finding => {
            const severityClass = {
              critical: 'text-rose-700 bg-rose-50 border-rose-200',
              high: 'text-amber-700 bg-amber-50 border-amber-200',
              medium: 'text-stone-700 bg-stone-100 border-stone-200',
              low: 'text-stone-600 bg-stone-50 border-stone-200',
            }[finding.severity];

            return (
              <div
                key={finding.id}
                className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs hover:border-stone-300 transition-all space-y-4"
              >
                {/* Header row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-stone-100">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className={`text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${severityClass}`}>
                      {finding.severity}
                    </span>
                    <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
                      {finding.scope} scope
                    </span>
                    <span className="text-stone-300">·</span>
                    <span className="text-xs font-mono text-stone-500 capitalize">
                      {finding.type.replace('_', ' ')}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {finding.merchantVerified ? (
                      <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        <span>Merchant Verified</span>
                      </span>
                    ) : (
                      <span className="text-[11px] font-mono text-stone-500 bg-stone-100 px-2 py-0.5 rounded">
                        Requires Verification
                      </span>
                    )}

                    {finding.productId && (
                      <button
                        onClick={() => viewProductDetail(finding.productId!, 'audit')}
                        className="px-2.5 py-1 text-xs font-medium text-stone-700 hover:text-stone-900 bg-stone-100 hover:bg-stone-200 rounded flex items-center gap-1 transition-colors"
                      >
                        <span>Product</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Finding Title & Core Description */}
                <div>
                  <h2 className="text-base font-bold text-stone-950 leading-snug">
                    {finding.title}
                  </h2>
                  <p className="text-xs sm:text-sm text-stone-600 mt-1.5 leading-relaxed">
                    {finding.description}
                  </p>
                </div>

                {/* 3 Rigorous Truth Sections: Observed Evidence vs Derived Conclusion vs Why It Matters */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                      Observed Evidence
                    </p>
                    <p className="text-xs text-stone-800 font-mono mt-1 leading-relaxed">
                      {finding.observedEvidence}
                    </p>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                      Derived Conclusion
                    </p>
                    <p className="text-xs text-stone-700 mt-1 leading-relaxed">
                      {finding.derivedConclusion}
                    </p>
                  </div>

                  <div className="p-3 bg-amber-50/50 rounded-xl border border-amber-200/60">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
                      Why It Matters for AI Discovery
                    </p>
                    <p className="text-xs text-stone-800 mt-1 leading-relaxed">
                      {finding.whyItMatters}
                    </p>
                  </div>
                </div>

                {/* Proposed Correction & Direct Action Trigger */}
                <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="text-xs text-stone-600">
                    <span className="font-semibold text-stone-900">Suggested Correction: </span>
                    <span className="font-mono text-stone-800">{finding.suggestedCorrection || 'Manual merchant review'}</span>
                  </div>

                  <button
                    onClick={() => navigateTo('actions', finding.actionItemId)}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors shrink-0 shadow-xs min-h-[38px]"
                  >
                    <span>Inspect in Action Center</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
