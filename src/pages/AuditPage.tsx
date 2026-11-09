import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../api/client';
import { 
  FindingScope, 
  FindingSeverity, 
  FindingType, 
  Finding 
} from '../types';
import { 
  AuditHistoryItem, 
  HistoricalAuditSnapshot, 
  AuditComparisonResult,
  HistoricalFindingRecord,
  HistoricalEvidenceRecord,
  HistoricalProductRecord
} from '../domain/audit/historicalTypes';
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
  RefreshCw,
  History,
  FileText,
  GitCompare,
  ArrowLeft,
  Calendar,
  Clock,
  ChevronRight,
  ChevronLeft,
  FileCheck,
  PackageCheck,
  Layers,
  Sparkles
} from 'lucide-react';

export const AuditPage: React.FC = () => {
  const { findings, navigateTo, viewProductDetail, addToast, runAudit, storeProfile, products } = useApp();
  const { isAuthenticated, activeWorkspace } = useAuth();

  // Primary workspace mode: 'current' (Phase 1 live audit view), 'history' (list of past runs), 'detail' (inspecting a snapshot), 'compare' (comparing two snapshots)
  const [activeTab, setActiveTab] = useState<'current' | 'history' | 'detail' | 'compare'>('current');

  // Filters for current finding view
  const [scopeFilter, setScopeFilter] = useState<'all' | FindingScope>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | FindingSeverity>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | FindingType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [auditStatus, setAuditStatus] = useState<'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED'>('IDLE');
  const [lastAuditSummary, setLastAuditSummary] = useState<{
    productsEvaluated?: number;
    rulesEvaluated?: number;
    findingsCount?: number;
    completedAt?: string;
  } | null>(null);

  // History List State
  const [historyRuns, setHistoryRuns] = useState<AuditHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // Historical Snapshot Detail State
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [snapshotData, setSnapshotData] = useState<HistoricalAuditSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotDetailTab, setSnapshotDetailTab] = useState<'findings' | 'evidence' | 'products'>('findings');

  // Comparison State
  const [compareBaseId, setCompareBaseId] = useState<string>('');
  const [compareTargetId, setCompareTargetId] = useState<string>('');
  const [comparisonResult, setComparisonResult] = useState<AuditComparisonResult | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  const isAuditing = auditStatus === 'RUNNING';

  // Load audit history list
  const loadHistory = async (cursor?: string) => {
    if (!isAuthenticated) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await apiClient.getAuditHistory({ limit: 15, cursor });
      if (res && res.success) {
        setHistoryRuns(res.items);
        setNextCursor(res.nextCursor);
        if (res.totalCount !== undefined) setTotalCount(res.totalCount);
      }
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load audit history.');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, isAuthenticated, activeWorkspace?.id]);

  // Load historical audit snapshot
  const openAuditDetail = async (runId: string) => {
    setSelectedAuditId(runId);
    setActiveTab('detail');
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const res = await apiClient.getAuditRun(runId);
      setSnapshotData(res);
    } catch (err: any) {
      setSnapshotError(err?.message || 'Failed to load historical audit snapshot.');
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Run audit comparison
  const handleRunComparison = async (baseId: string, targetId: string) => {
    if (!baseId || !targetId || baseId === targetId) {
      setComparisonError('Please select two distinct completed audit runs to compare.');
      return;
    }
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      const res = await apiClient.compareAudits(baseId, targetId);
      if (res && res.success) {
        setComparisonResult(res.comparison);
      }
    } catch (err: any) {
      setComparisonError(err?.message || 'Comparison failed. Verify both audit runs belong to your workspace.');
    } finally {
      setComparisonLoading(false);
    }
  };

  const handleRunFullAudit = async () => {
    if (isAuditing) return;
    setAuditStatus('RUNNING');

    try {
      const result = await runAudit();
      setAuditStatus('COMPLETED');
      setLastAuditSummary({
        productsEvaluated: result?.productsEvaluated ?? products.length,
        rulesEvaluated: result?.rulesEvaluated ?? 12,
        findingsCount: result?.findingsCount ?? findings.length,
        completedAt: new Date().toLocaleTimeString(),
      });
      // Also refresh history if loaded
      if (activeTab === 'history') {
        loadHistory();
      }
    } catch (err: any) {
      setAuditStatus('FAILED');
    }
  };

  const filteredCurrentFindings = useMemo(() => {
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

  return (
    <div className="space-y-6">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Store & Catalog Audit Workspace
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Diagnostic observations, immutable historical execution records, evidence provenance, and catalog drift comparison.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Re-run button */}
          <button
            onClick={handleRunFullAudit}
            disabled={isAuditing}
            className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors min-h-[40px] shrink-0 disabled:opacity-60 shadow-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isAuditing ? 'animate-spin' : ''}`} />
            <span>{isAuditing ? 'Executing Catalog Audit...' : 'Re-run Store Audit'}</span>
          </button>
        </div>
      </div>

      {/* Top Navigation Tabs */}
      <div className="flex items-center border-b border-stone-200 gap-1 bg-stone-100/60 p-1 rounded-xl">
        <button
          onClick={() => setActiveTab('current')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
            activeTab === 'current'
              ? 'bg-white text-stone-950 shadow-xs'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          <SearchCheck className="w-3.5 h-3.5 text-orange-600" />
          <span>Current Catalog Audit</span>
          <span className="font-mono text-[10px] bg-stone-200/70 text-stone-700 px-1.5 py-0.2 rounded-md">
            {findings.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
            activeTab === 'history'
              ? 'bg-white text-stone-950 shadow-xs'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          <History className="w-3.5 h-3.5 text-stone-600" />
          <span>Audit History & Evidence</span>
          {totalCount > 0 && (
            <span className="font-mono text-[10px] bg-stone-200/70 text-stone-700 px-1.5 py-0.2 rounded-md">
              {totalCount}
            </span>
          )}
        </button>

        {selectedAuditId && (
          <button
            onClick={() => setActiveTab('detail')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'detail'
                ? 'bg-white text-stone-950 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-blue-600" />
            <span>Snapshot: {selectedAuditId.substring(0, 14)}...</span>
          </button>
        )}

        <button
          onClick={() => setActiveTab('compare')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
            activeTab === 'compare'
              ? 'bg-white text-stone-950 shadow-xs'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          <GitCompare className="w-3.5 h-3.5 text-indigo-600" />
          <span>Historical Comparison</span>
        </button>
      </div>

      {/* Audit Execution Status Indicator */}
      {auditStatus === 'RUNNING' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex items-center gap-3">
          <RefreshCw className="w-4 h-4 animate-spin text-amber-600 shrink-0" />
          <div>
            <span className="font-semibold">Backend Audit In Progress:</span> Evaluating persisted catalog products against 12 GTIN, attribute, pricing, and schema consistency rules...
          </div>
        </div>
      )}

      {auditStatus === 'FAILED' && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-900 flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <div>
            <span className="font-semibold">Audit Execution Failed:</span> An error occurred while evaluating or persisting audit results. Your previous catalog state and historical snapshots remain safe.
          </div>
        </div>
      )}

      {lastAuditSummary && auditStatus === 'COMPLETED' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              <span className="font-semibold">Audit Completed & Durable Snapshot Preserved:</span> Evaluated {lastAuditSummary.productsEvaluated} products across {lastAuditSummary.rulesEvaluated} rule sets at {lastAuditSummary.completedAt}.
            </span>
          </div>
          <span className="font-mono text-[11px] text-emerald-800">
            {lastAuditSummary.findingsCount} findings identified
          </span>
        </div>
      )}

      {/* TAB 1: CURRENT LIVE CATALOG AUDIT (Phase 1 preserved) */}
      {activeTab === 'current' && (
        <div className="space-y-6">
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

          {/* Current Findings Listing */}
          {filteredCurrentFindings.length === 0 ? (
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
              {filteredCurrentFindings.map(finding => {
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
                        {finding.ruleCode && (
                          <span className="text-[10px] font-mono bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                            {finding.ruleCode}
                          </span>
                        )}
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

                    {/* 3 Rigorous Truth Sections */}
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
      )}

      {/* TAB 2: AUDIT HISTORY LIST */}
      {activeTab === 'history' && (
        <div className="space-y-6">
          <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-stone-950">
                Audit Execution Ledger & Provenance
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Every completed audit run creates an immutable snapshot of findings, evidence documents, and product states.
              </p>
            </div>

            <button
              onClick={() => loadHistory()}
              disabled={historyLoading}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
              <span>Refresh Ledger</span>
            </button>
          </div>

          {historyError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs text-rose-900 flex items-center gap-3">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{historyError}</span>
            </div>
          )}

          {historyLoading ? (
            <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
              <RefreshCw className="w-8 h-8 text-stone-400 animate-spin mx-auto mb-3" />
              <p className="text-xs font-medium text-stone-600">Retrieving workspace audit history from durable database...</p>
            </div>
          ) : historyRuns.length === 0 ? (
            <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
              <History className="w-12 h-12 text-stone-300 mx-auto mb-3" />
              <h3 className="text-base font-bold text-stone-900">No previous audit executions found</h3>
              <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
                Execute your first real catalog audit to establish an immutable historical baseline for this workspace.
              </p>
              <button
                onClick={handleRunFullAudit}
                className="mt-4 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs"
              >
                Run First Audit Now
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {historyRuns.map(run => {
                const dateStr = new Date(run.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });

                return (
                  <div
                    key={run.id}
                    className="bg-white border border-stone-200 rounded-xl p-4 sm:p-5 shadow-xs hover:border-stone-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${
                          run.status === 'COMPLETED'
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                            : run.status === 'FAILED'
                            ? 'text-rose-700 bg-rose-50 border-rose-200'
                            : 'text-amber-700 bg-amber-50 border-amber-200'
                        }`}>
                          {run.status}
                        </span>

                        <span className="font-mono text-xs font-semibold text-stone-900 truncate">
                          {run.id}
                        </span>

                        {run.snapshotAvailable ? (
                          <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                            <FileCheck className="w-3 h-3 text-emerald-600" />
                            <span>Snapshot Available</span>
                          </span>
                        ) : (
                          <span className="text-[11px] font-medium text-stone-600 bg-stone-100 px-2 py-0.5 rounded border border-stone-200">
                            Legacy Run (Snapshot Unavailable)
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5 text-stone-400" />
                          <span>{dateStr}</span>
                        </span>
                        <span>·</span>
                        <span>{run.productsEvaluated} products</span>
                        <span>·</span>
                        <span>{run.rulesEvaluated} rules evaluated</span>
                        <span>·</span>
                        <span className="font-semibold text-stone-700">{run.findingsCount} findings</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => openAuditDetail(run.id)}
                        className="px-3.5 py-1.5 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors shadow-xs"
                      >
                        <span>Inspect Snapshot</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => {
                          setCompareBaseId(run.id);
                          setActiveTab('compare');
                        }}
                        title="Use as base for comparison"
                        className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-medium rounded-lg flex items-center gap-1 transition-colors"
                      >
                        <GitCompare className="w-3.5 h-3.5" />
                        <span>Compare</span>
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Pagination controls */}
              {nextCursor && (
                <div className="pt-2 flex justify-center">
                  <button
                    onClick={() => loadHistory(nextCursor)}
                    disabled={historyLoading}
                    className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors"
                  >
                    <span>Load Next Page</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: HISTORICAL AUDIT DETAIL SNAPSHOT */}
      {activeTab === 'detail' && selectedAuditId && (
        <div className="space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-stone-200">
            <button
              onClick={() => setActiveTab('history')}
              className="text-xs font-semibold text-stone-600 hover:text-stone-950 flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Audit Ledger</span>
            </button>

            <span className="text-xs font-mono text-stone-500">
              Audit Run: {selectedAuditId}
            </span>
          </div>

          {snapshotLoading ? (
            <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
              <RefreshCw className="w-8 h-8 text-stone-400 animate-spin mx-auto mb-3" />
              <p className="text-xs font-medium text-stone-600">Loading immutable historical audit snapshot...</p>
            </div>
          ) : snapshotError ? (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs text-rose-900 flex items-center gap-3">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{snapshotError}</span>
            </div>
          ) : !snapshotData?.snapshotAvailable ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-8 text-center shadow-xs">
              <AlertTriangle className="w-10 h-10 text-amber-600 mx-auto mb-2" />
              <h3 className="text-base font-bold text-amber-950">Historical Snapshot Unavailable</h3>
              <p className="text-xs text-amber-800 mt-1 max-w-lg mx-auto">
                {snapshotData?.message || 'Historical snapshot unavailable — this audit was created before Audit History & Evidence was implemented.'}
              </p>
              <p className="text-[11px] text-amber-700 mt-2">
                AIXSHOP preserves historical truth strictly: earlier runs are never artificially backfilled with current catalog state.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Snapshot Meta Overview Card */}
              <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-stone-100">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200">
                        {snapshotData.auditRun.status}
                      </span>
                      <h2 className="text-base font-bold text-stone-950 font-mono">
                        {snapshotData.auditRun.id}
                      </h2>
                    </div>
                    <p className="text-xs text-stone-500 mt-1">
                      Executed: {new Date(snapshotData.auditRun.createdAt).toLocaleString()} · Completed: {snapshotData.auditRun.completedAt ? new Date(snapshotData.auditRun.completedAt).toLocaleString() : 'N/A'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setCompareBaseId(snapshotData.auditRun.id);
                        setActiveTab('compare');
                      }}
                      className="px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors border border-indigo-200"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                      <span>Compare with Another Run</span>
                    </button>
                  </div>
                </div>

                {/* Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Products Evaluated</span>
                    <span className="text-lg font-bold font-mono text-stone-900 mt-0.5 block">{snapshotData.auditRun.productsEvaluated}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Rules Evaluated</span>
                    <span className="text-lg font-bold font-mono text-stone-900 mt-0.5 block">{snapshotData.auditRun.rulesEvaluated}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Historical Findings</span>
                    <span className="text-lg font-bold font-mono text-rose-700 mt-0.5 block">{snapshotData.findings.length}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Evidence Documents</span>
                    <span className="text-lg font-bold font-mono text-blue-700 mt-0.5 block">{snapshotData.evidence.length}</span>
                  </div>
                </div>
              </div>

              {/* Sub-tabs for Snapshot Detail */}
              <div className="flex items-center gap-2 border-b border-stone-200 pb-2">
                <button
                  onClick={() => setSnapshotDetailTab('findings')}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
                    snapshotDetailTab === 'findings'
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:text-stone-900 bg-stone-100'
                  }`}
                >
                  <SearchCheck className="w-3.5 h-3.5" />
                  <span>Historical Findings ({snapshotData.findings.length})</span>
                </button>

                <button
                  onClick={() => setSnapshotDetailTab('evidence')}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
                    snapshotDetailTab === 'evidence'
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:text-stone-900 bg-stone-100'
                  }`}
                >
                  <FileCheck className="w-3.5 h-3.5" />
                  <span>Historical Evidence ({snapshotData.evidence.length})</span>
                </button>

                <button
                  onClick={() => setSnapshotDetailTab('products')}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
                    snapshotDetailTab === 'products'
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:text-stone-900 bg-stone-100'
                  }`}
                >
                  <PackageCheck className="w-3.5 h-3.5" />
                  <span>Observed Products ({snapshotData.products.length})</span>
                </button>
              </div>

              {/* Snapshot Detail Tab 1: Findings */}
              {snapshotDetailTab === 'findings' && (
                <div className="space-y-3">
                  {snapshotData.findings.length === 0 ? (
                    <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-xs text-stone-500">
                      No findings recorded during this audit run.
                    </div>
                  ) : (
                    snapshotData.findings.map(f => {
                      const severityClass = {
                        critical: 'text-rose-700 bg-rose-50 border-rose-200',
                        high: 'text-amber-700 bg-amber-50 border-amber-200',
                        medium: 'text-stone-700 bg-stone-100 border-stone-200',
                        low: 'text-stone-600 bg-stone-50 border-stone-200',
                      }[f.severity];

                      return (
                        <div
                          key={f.id}
                          className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs space-y-3"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-stone-100">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${severityClass}`}>
                                {f.severity}
                              </span>
                              <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
                                {f.scope} scope
                              </span>
                              {f.ruleCode && (
                                <span className="text-[10px] font-mono bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                                  {f.ruleCode}
                                </span>
                              )}
                              {f.productTitle && (
                                <span className="text-xs font-medium text-stone-700">
                                  · Product: {f.productTitle}
                                </span>
                              )}
                            </div>

                            <span className="text-[11px] font-mono text-stone-400">
                              Snapshot: {new Date(f.snapshotCreatedAt).toLocaleTimeString()}
                            </span>
                          </div>

                          <div>
                            <h3 className="text-sm font-bold text-stone-950">{f.title}</h3>
                            <p className="text-xs text-stone-600 mt-1 leading-relaxed">{f.description}</p>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                            <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500 block">Observed Evidence</span>
                              <span className="text-xs font-mono text-stone-800 mt-1 block">{f.observedEvidence}</span>
                            </div>
                            <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500 block">Derived Conclusion</span>
                              <span className="text-xs text-stone-700 mt-1 block">{f.derivedConclusion}</span>
                            </div>
                            <div className="p-2.5 bg-amber-50/50 rounded-xl border border-amber-200/60">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 block">Why It Matters</span>
                              <span className="text-xs text-stone-800 mt-1 block">{f.whyItMatters}</span>
                            </div>
                          </div>

                          {f.suggestedCorrection && (
                            <div className="pt-2 text-xs text-stone-600 border-t border-stone-100">
                              <span className="font-semibold text-stone-900">Historical Suggested Correction: </span>
                              <span className="font-mono text-stone-800">{f.suggestedCorrection}</span>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Snapshot Detail Tab 2: Evidence Documents */}
              {snapshotDetailTab === 'evidence' && (
                <div className="space-y-3">
                  {snapshotData.evidence.length === 0 ? (
                    <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-xs text-stone-500">
                      No evidence documents were attached to the catalog at the time of this audit run.
                    </div>
                  ) : (
                    snapshotData.evidence.map(e => (
                      <div
                        key={e.id}
                        className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-2.5"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <FileCheck className="w-4 h-4 text-blue-600 shrink-0" />
                            <h3 className="text-sm font-bold text-stone-950">{e.title}</h3>
                            <span className="text-[10px] font-mono bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                              {e.evidenceType}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
                              e.status === 'verified'
                                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                : 'text-amber-700 bg-amber-50 border-amber-200'
                            }`}>
                              Status: {e.status}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-stone-600 pt-1">
                          <div>
                            <span className="font-semibold text-stone-900">Issuer: </span>
                            <span>{e.issuer || 'Unspecified'}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-stone-900">Verification Date: </span>
                            <span className="font-mono">{e.dateVerified || 'None'}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-stone-900">Original URL: </span>
                            {e.url ? (
                              <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-orange-600 underline font-mono truncate inline-block max-w-[200px]">
                                {e.url}
                              </a>
                            ) : (
                              <span className="text-stone-400">None provided</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Snapshot Detail Tab 3: Observed Products */}
              {snapshotDetailTab === 'products' && (
                <div className="space-y-3">
                  {snapshotData.products.length === 0 ? (
                    <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-xs text-stone-500">
                      No products observed in this audit run snapshot.
                    </div>
                  ) : (
                    snapshotData.products.map(p => (
                      <div
                        key={p.id}
                        className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-stone-100">
                          <div>
                            <h3 className="text-sm font-bold text-stone-950">{p.title}</h3>
                            <p className="text-xs text-stone-500 font-mono">
                              Brand: {p.brand} · Category: {p.category} · Completeness: {p.completenessScore}%
                            </p>
                          </div>

                          <div className="text-xs font-mono text-stone-600">
                            {p.variants?.length || 0} variant(s) · {p.findingsCount} finding(s)
                          </div>
                        </div>

                        {/* Variants breakdown */}
                        {p.variants && p.variants.length > 0 && (
                          <div className="space-y-1.5">
                            <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Observed Variants at Audit Time:</span>
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                              {p.variants.map((v: any, vIdx: number) => (
                                <div key={v.id || vIdx} className="p-2 bg-stone-50 rounded-lg border border-stone-200/70 text-xs">
                                  <p className="font-semibold text-stone-900 truncate">{v.title || v.sku || `Variant ${vIdx + 1}`}</p>
                                  <p className="font-mono text-stone-500 text-[11px]">SKU: {v.sku || '(none)'} · Price: ${v.price ?? 'N/A'}</p>
                                  <p className="font-mono text-stone-500 text-[11px]">Barcode: {v.barcode || '(empty)'}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: HISTORICAL COMPARISON */}
      {activeTab === 'compare' && (
        <div className="space-y-6">
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
            <div>
              <h2 className="text-base font-bold text-stone-950">
                Audit Snapshot Comparison
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Compare two immutable historical audit executions to inspect resolved findings, persistent issues, and new observations.
              </p>
            </div>

            {/* Selection row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="text-xs font-semibold text-stone-700 block mb-1">
                  Base Audit Run (Earlier):
                </label>
                <select
                  value={compareBaseId}
                  onChange={e => setCompareBaseId(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">Select Base Audit...</option>
                  {historyRuns.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.id} ({new Date(r.createdAt).toLocaleDateString()} - {r.findingsCount} findings)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-stone-700 block mb-1">
                  Target Audit Run (Later):
                </label>
                <select
                  value={compareTargetId}
                  onChange={e => setCompareTargetId(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">Select Target Audit...</option>
                  {historyRuns.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.id} ({new Date(r.createdAt).toLocaleDateString()} - {r.findingsCount} findings)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => handleRunComparison(compareBaseId, compareTargetId)}
                disabled={comparisonLoading || !compareBaseId || !compareTargetId}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-xs"
              >
                <GitCompare className={`w-3.5 h-3.5 ${comparisonLoading ? 'animate-spin' : ''}`} />
                <span>{comparisonLoading ? 'Computing Comparison...' : 'Compare Audit Runs'}</span>
              </button>
            </div>
          </div>

          {comparisonError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs text-rose-900 flex items-center gap-3">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{comparisonError}</span>
            </div>
          )}

          {comparisonResult && (
            <div className="space-y-6">
              {/* Summary delta stats */}
              <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs">
                <h3 className="text-sm font-bold text-stone-950 mb-3">
                  Summary Metric Changes
                </h3>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Persistent Findings</span>
                    <span className="text-lg font-bold font-mono text-amber-700 mt-0.5 block">{comparisonResult.persistentCount}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Resolved Issues</span>
                    <span className="text-lg font-bold font-mono text-emerald-700 mt-0.5 block">{comparisonResult.resolvedCount}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">New Findings</span>
                    <span className="text-lg font-bold font-mono text-rose-700 mt-0.5 block">{comparisonResult.newCount}</span>
                  </div>

                  <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                    <span className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider block">Unmatched / Unevaluated</span>
                    <span className="text-lg font-bold font-mono text-stone-600 mt-0.5 block">{comparisonResult.unmatchedCount}</span>
                  </div>
                </div>
              </div>

              {/* Comparison item list */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-stone-950">
                  Detailed Finding Comparison ({comparisonResult.comparisonItems.length})
                </h3>

                {comparisonResult.comparisonItems.map(item => {
                  const statusBadgeClass = {
                    PERSISTENT: 'text-amber-800 bg-amber-50 border-amber-200',
                    RESOLVED: 'text-emerald-800 bg-emerald-50 border-emerald-200',
                    NEW: 'text-rose-800 bg-rose-50 border-rose-200',
                    UNMATCHED: 'text-stone-700 bg-stone-100 border-stone-200',
                  }[item.status];

                  return (
                    <div
                      key={item.key}
                      className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-2.5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${statusBadgeClass}`}>
                            {item.status}
                          </span>
                          <h4 className="text-xs sm:text-sm font-bold text-stone-950">{item.findingTitle}</h4>
                        </div>

                        {item.ruleCode && (
                          <span className="text-[10px] font-mono bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                            {item.ruleCode}
                          </span>
                        )}
                      </div>

                      {item.severityChange && (
                        <div className="text-xs text-stone-700 bg-stone-50 p-2 rounded-lg border border-stone-200/60 flex items-center gap-2">
                          <span className="font-semibold">Severity Shift:</span>
                          <span className="font-mono text-stone-500">{item.severityChange.from}</span>
                          <ArrowRight className="w-3 h-3 text-stone-400" />
                          <span className="font-mono font-bold text-stone-900">{item.severityChange.to}</span>
                        </div>
                      )}

                      {item.observedValueChange && (
                        <div className="text-xs text-stone-700 bg-stone-50 p-2 rounded-lg border border-stone-200/60 flex items-center gap-2">
                          <span className="font-semibold">Observed Value Shift:</span>
                          <span className="font-mono text-stone-500">{item.observedValueChange.from}</span>
                          <ArrowRight className="w-3 h-3 text-stone-400" />
                          <span className="font-mono font-bold text-stone-900">{item.observedValueChange.to}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
