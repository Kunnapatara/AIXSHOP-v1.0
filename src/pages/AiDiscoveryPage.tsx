import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../api/client';
import {
  evaluateDiscoveryReadiness,
  buildBusinessHubChecklist,
  DiscoveryAuditResult,
  DiscoveryDimensionScore,
} from '../domain/aiDiscovery/discoveryEngine';
import { BusinessHubChecklistResult } from '../domain/businessProfile/types';
import {
  Compass,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Download,
  RefreshCw,
  Search,
  ExternalLink,
  Info,
} from 'lucide-react';

export const AiDiscoveryPage: React.FC = () => {
  const { products, storeProfile, navigateTo, viewProductDetail, addToast } = useApp();
  const { isAuthenticated } = useAuth();

  const [readiness, setReadiness] = useState<DiscoveryAuditResult | null>(null);
  const [hubChecklist, setHubChecklist] = useState<BusinessHubChecklistResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDimension, setSelectedDimension] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSection, setActiveSection] = useState<'dimensions' | 'findings' | 'business-hub'>('dimensions');

  const loadDiscoveryAudit = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isAuthenticated) {
        const res = await apiClient.getDiscoveryAudit();
        setReadiness(res.readiness);
        setHubChecklist(res.hubChecklist);
      } else {
        const localReadiness = evaluateDiscoveryReadiness(products, storeProfile.domain);
        const localChecklist = buildBusinessHubChecklist(null, products.length, localReadiness.overallScore);
        setReadiness(localReadiness);
        setHubChecklist(localChecklist);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to evaluate AI Discovery readiness');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, products, storeProfile.domain]);

  useEffect(() => {
    loadDiscoveryAudit();
  }, [loadDiscoveryAudit]);

  const filteredFindings = useMemo(() => {
    if (!readiness) return [];
    return readiness.findings.filter((f) => {
      if (selectedDimension !== 'all' && f.dimension !== selectedDimension) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          f.title.toLowerCase().includes(q) ||
          f.productTitle.toLowerCase().includes(q) ||
          f.evidence.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [readiness, selectedDimension, searchQuery]);

  const handleDownloadHubPackage = () => {
    if (!hubChecklist?.exportableMerchantPackage) return;
    const blob = new Blob([JSON.stringify(hubChecklist.exportableMerchantPackage, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aixshop_merchant_hub_package_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addToast('Package Exported', 'Merchant readiness JSON package downloaded.', 'success');
  };

  const dimensionList: DiscoveryDimensionScore[] = readiness
    ? Object.values(readiness.dimensions)
    : [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            AI Discovery Readiness
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Deterministic 8-dimension catalog evaluation for conversational shopping assistants and structured commerce discovery.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={loadDiscoveryAudit}
            disabled={loading}
            className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Evaluating...' : 'Re-run Evaluation'}</span>
          </button>
        </div>
      </div>

      {!isAuthenticated && (
        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Viewing deterministic audit of local browser demo catalog. Sign in to evaluate your persisted PostgreSQL catalog and Business Profile.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !readiness ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-white border border-stone-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : readiness ? (
        <>
          {/* Summary KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Deterministic Score</span>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono tabular-nums text-stone-950">
                  {readiness.overallScore}
                </span>
                <span className="text-xs font-mono text-stone-400">/ 100</span>
              </div>
              <span className="text-[11px] font-mono text-stone-500 mt-1 block">
                Ruleset {readiness.ruleVersion}
              </span>
            </div>

            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Catalog Coverage</span>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono tabular-nums text-stone-950">
                  {readiness.totalProductsAssessed}
                </span>
                <span className="text-xs text-stone-500">products</span>
              </div>
              <span className="text-[11px] font-mono tabular-nums text-stone-500 mt-1 block">
                {readiness.totalVariantsAssessed} variants evaluated
              </span>
            </div>

            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Open Discovery Findings</span>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono tabular-nums text-stone-950">
                  {readiness.findings.length}
                </span>
                <span className="text-xs text-stone-500">items</span>
              </div>
              <span className="text-[11px] font-mono tabular-nums text-amber-700 mt-1 block">
                {readiness.findings.filter((f) => f.needsMerchantInput).length} require merchant input
              </span>
            </div>

            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Business Hub Readiness</span>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono tabular-nums text-stone-950">
                  {hubChecklist?.overallReadinessScore ?? 0}%
                </span>
              </div>
              <span className="text-[11px] text-stone-500 mt-1 block">
                {hubChecklist?.checklistItems.filter((i) => i.status === 'ready').length || 0} of{' '}
                {hubChecklist?.checklistItems.length || 0} checks complete
              </span>
            </div>
          </div>

          {/* Section Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg w-fit border border-stone-200">
            <button
              onClick={() => setActiveSection('dimensions')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeSection === 'dimensions'
                  ? 'bg-white text-stone-950 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              8-Dimension Breakdown
            </button>
            <button
              onClick={() => setActiveSection('findings')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeSection === 'findings'
                  ? 'bg-white text-stone-950 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Findings ({readiness.findings.length})
            </button>
            <button
              onClick={() => setActiveSection('business-hub')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeSection === 'business-hub'
                  ? 'bg-white text-stone-950 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Business Hub Preparation
            </button>
          </div>

          {/* Dimensions View */}
          {activeSection === 'dimensions' && (
            <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
              {dimensionList.map((dim) => {
                const pct = dim.maxScore > 0 ? Math.round((dim.score / dim.maxScore) * 100) : 0;
                return (
                  <div key={dim.dimension} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1 max-w-xl">
                      <div className="flex items-center gap-2 text-sm font-semibold text-stone-900">
                        <span>{dim.name}</span>
                        <span className="text-xs font-mono text-stone-400">·</span>
                        <span className="text-xs font-mono tabular-nums text-stone-500">
                          Weight {dim.weight}%
                        </span>
                      </div>
                      <div className="text-xs text-stone-500 flex flex-wrap items-center gap-2 font-mono tabular-nums">
                        <span className="text-emerald-700">{dim.passedCount} passed</span>
                        <span aria-hidden="true">·</span>
                        <span className={dim.failedCount > 0 ? 'text-amber-700' : 'text-stone-500'}>
                          {dim.failedCount} failed
                        </span>
                        {dim.notAssessedCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{dim.notAssessedCount} unassessed</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 min-w-[240px]">
                      <div className="flex-1 bg-stone-100 h-2 rounded-full overflow-hidden">
                        <div
                          className={`h-2 rounded-full ${
                            pct >= 80 ? 'bg-emerald-600' : pct >= 50 ? 'bg-amber-500' : 'bg-red-600'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono tabular-nums font-semibold text-stone-900 w-16 text-right">
                        {dim.score} / {dim.maxScore}
                      </span>
                      {dim.failedCount > 0 && (
                        <button
                          onClick={() => {
                            setSelectedDimension(dim.dimension);
                            setActiveSection('findings');
                          }}
                          className="text-xs font-medium text-orange-700 hover:text-orange-800 whitespace-nowrap cursor-pointer"
                        >
                          Inspect
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Findings View */}
          {activeSection === 'findings' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter findings by product title or evidence..."
                    className="w-full pl-9 pr-3 py-2 bg-white border border-stone-200 rounded-lg text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <select
                  value={selectedDimension}
                  onChange={(e) => setSelectedDimension(e.target.value)}
                  className="px-3 py-2 bg-white border border-stone-200 rounded-lg text-xs font-medium text-stone-800"
                >
                  <option value="all">All Dimensions</option>
                  {dimensionList.map((d) => (
                    <option key={d.dimension} value={d.dimension}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              {filteredFindings.length === 0 ? (
                <div className="bg-white border border-stone-200 rounded-xl p-10 text-center space-y-2">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
                  <p className="text-sm font-semibold text-stone-900">No matching discovery findings</p>
                  <p className="text-xs text-stone-500">
                    All evaluated products meet the deterministic requirements for the selected filter.
                  </p>
                </div>
              ) : (
                <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
                  {filteredFindings.slice(0, 50).map((finding) => (
                    <div key={finding.id} className="p-4 flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                          <span
                            className={`font-semibold uppercase font-mono ${
                              finding.severity === 'critical'
                                ? 'text-red-700'
                                : finding.severity === 'high'
                                ? 'text-amber-700'
                                : 'text-stone-700'
                            }`}
                          >
                            {finding.severity}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{finding.ruleId}</span>
                          <span aria-hidden="true">·</span>
                          <span>{finding.productTitle}</span>
                          {finding.needsMerchantInput && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-orange-700">Merchant input required</span>
                            </>
                          )}
                        </div>
                        <h3 className="text-sm font-semibold text-stone-900">{finding.title}</h3>
                        <p className="text-xs text-stone-600">{finding.evidence}</p>
                        <p className="text-xs text-stone-500">
                          Action: {finding.recommendation}
                        </p>
                      </div>
                      <button
                        onClick={() => viewProductDetail(finding.productId)}
                        className="px-3 py-1.5 border border-stone-200 hover:bg-stone-50 rounded-lg text-xs font-medium text-stone-700 whitespace-nowrap shrink-0 self-start cursor-pointer"
                      >
                        Open Product
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Business Hub Checklist View */}
          {activeSection === 'business-hub' && hubChecklist && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  {hubChecklist.limitationsNotice ||
                    'Merchant Preparation Checklist Only: Official ChatGPT Business Hub API integration is not connected. Self-declared entries are not independently verified.'}
                </span>
              </div>

              <div className="bg-white border border-stone-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-bold text-stone-900">
                    ChatGPT & AI Commerce Business Hub Preparation Checklist
                  </h2>
                  <p className="text-xs text-stone-500 mt-1">
                    Local merchant preparation checklist for business identity, policy links, and catalog metadata.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => navigateTo('business-profile')}
                    className="px-3.5 py-2 border border-stone-200 hover:bg-stone-50 text-stone-800 text-xs font-semibold rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    Edit Business Profile
                  </button>
                  <button
                    onClick={handleDownloadHubPackage}
                    className="px-3.5 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export Preparation Package</span>
                  </button>
                </div>
              </div>

              <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
                {hubChecklist.checklistItems.map((item) => (
                  <div key={item.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs text-stone-500">
                        <span className="capitalize font-medium">{item.category}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-semibold ${
                            item.status === 'ready' ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {item.status === 'ready'
                            ? item.dataOrigin === 'merchant_self_declared'
                              ? 'Provided (Self-Declared)'
                              : 'Ready (Local Check)'
                            : item.status === 'missing'
                            ? 'Missing'
                            : 'Action Required'}
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-stone-900">{item.title}</h3>
                      <p className="text-xs text-stone-500">{item.requirementDescription}</p>
                    </div>
                    <div className="text-xs font-mono text-stone-700 sm:text-right max-w-xs truncate">
                      {item.currentValue || 'Not provided'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};
