import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../api/client';
import {
  evaluateFeedReadiness,
  mapProductToGmcRow,
  mapProductToMetaRow,
  mapProductToSchemaOrgJsonLd,
  exportToCsv,
  FeedPlatform,
  FeedReadinessReport,
} from '../domain/feed/feedValidationEngine';
import { Download, RefreshCw, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';

const PLATFORMS: { id: FeedPlatform; label: string }[] = [
  { id: 'google_merchant_center', label: 'Google Merchant Center' },
  { id: 'meta_commerce', label: 'Meta Commerce Catalog' },
  { id: 'schema_org', label: 'Schema.org JSON-LD' },
];

export const FeedReadinessPage: React.FC = () => {
  const { products, storeProfile, viewProductDetail, addToast } = useApp();
  const { isAuthenticated } = useAuth();

  const [platform, setPlatform] = useState<FeedPlatform>('google_merchant_center');
  const [report, setReport] = useState<FeedReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'invalid' | 'valid'>('all');

  const runValidation = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isAuthenticated) {
        const res = await apiClient.validateFeed(platform);
        setReport(res.report);
      } else {
        setReport(evaluateFeedReadiness(products, platform));
      }
    } catch (err: any) {
      setError(err.message || 'Failed to validate product feed');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, platform, products]);

  useEffect(() => {
    runValidation();
  }, [runValidation]);

  const handleExport = (exportFilter: 'all' | 'valid_only') => {
    const format = platform === 'schema_org' ? 'json' : 'csv';
    if (isAuthenticated) {
      window.location.href = apiClient.getFeedExportUrl(platform, format, exportFilter);
      return;
    }

    // Local demo export fallback
    const currency = storeProfile.currency || 'USD';
    let targetProducts = products;
    if (exportFilter === 'valid_only' && report) {
      const validIds = new Set(report.evaluations.filter((e) => e.isValid).map((e) => e.productId));
      targetProducts = products.filter((p) => validIds.has(p.id));
    }

    let content = '';
    let mime = 'text/csv;charset=utf-8';
    let ext = 'csv';

    if (platform === 'schema_org') {
      content = JSON.stringify(targetProducts.map((p) => mapProductToSchemaOrgJsonLd(p, currency)), null, 2);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    } else if (platform === 'meta_commerce') {
      content = exportToCsv(targetProducts.map((p) => mapProductToMetaRow(p, currency)));
    } else {
      content = exportToCsv(targetProducts.map((p) => mapProductToGmcRow(p, currency)));
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${platform}_feed_${exportFilter}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addToast('Feed Exported', `Downloaded ${targetProducts.length} products in ${ext.toUpperCase()} format.`, 'success');
  };

  const displayedEvaluations = (report?.evaluations || []).filter((e) => {
    if (filterMode === 'invalid') return !e.isValid;
    if (filterMode === 'valid') return e.isValid;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Feed Readiness & Canonical Export
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Validate catalog fields against Google Merchant Center, Meta Commerce, and Schema.org structured feed contracts before syndication.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={() => handleExport('valid_only')}
            disabled={!report || report.validProductsCount === 0}
            className="px-3.5 py-2 border border-stone-200 bg-white hover:bg-stone-50 text-stone-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Valid Only</span>
          </button>
          <button
            onClick={() => handleExport('all')}
            disabled={!report || report.totalProducts === 0}
            className="px-3.5 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{platform === 'schema_org' ? 'Export JSON-LD' : 'Export Full CSV'}</span>
          </button>
        </div>
      </div>

      {/* Platform Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg border border-stone-200">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlatform(p.id)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                platform === p.id
                  ? 'bg-white text-stone-950 shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button
          onClick={runValidation}
          disabled={loading}
          className="px-3 py-1.5 border border-stone-200 bg-white hover:bg-stone-50 rounded-lg text-xs font-medium text-stone-700 flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Re-validate</span>
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Feed Readiness</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-stone-950 mt-1 block">
                {report.readinessScore}%
              </span>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Valid Products</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-emerald-700 mt-1 block">
                {report.validProductsCount}
              </span>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Rejected / Incomplete</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-red-700 mt-1 block">
                {report.invalidProductsCount}
              </span>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Total Evaluated</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-stone-950 mt-1 block">
                {report.totalProducts}
              </span>
            </div>
          </div>

          {Object.keys(report.summaryErrors).length > 0 && (
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <h2 className="text-xs font-bold text-stone-900 mb-2">Blocking Field Defects</h2>
              <div className="flex flex-wrap gap-4 text-xs font-mono tabular-nums text-stone-700">
                {Object.entries(report.summaryErrors).map(([field, count]) => (
                  <span key={field}>
                    {field}: <strong className="text-red-700">{count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Filter & Table */}
          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3">
              <h2 className="text-xs font-bold text-stone-900">Product Feed Validation Matrix</h2>
              <div className="flex items-center gap-1 p-0.5 bg-stone-100 rounded-md text-xs">
                {(['all', 'invalid', 'valid'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setFilterMode(m)}
                    className={`px-2.5 py-1 rounded capitalize font-medium cursor-pointer ${
                      filterMode === m ? 'bg-white text-stone-900 shadow-2xs' : 'text-stone-600'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {displayedEvaluations.length === 0 ? (
              <div className="p-8 text-center text-xs text-stone-500">
                No products match the selected validation filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50 text-stone-600 font-semibold">
                      <th className="py-2.5 px-4">Product / SKU</th>
                      <th className="py-2.5 px-4">Feed Status</th>
                      <th className="py-2.5 px-4">Blocking Errors</th>
                      <th className="py-2.5 px-4">Warnings</th>
                      <th className="py-2.5 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {displayedEvaluations.slice(0, 60).map((ev) => (
                      <tr key={ev.productId} className="hover:bg-stone-50/70">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-stone-900">{ev.title}</div>
                          <div className="font-mono text-[11px] text-stone-500">{ev.sku}</div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {ev.isValid ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Ready
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                              <AlertCircle className="w-3.5 h-3.5" />
                              Rejected
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-red-700">
                          {ev.errors.length > 0 ? ev.errors.map((e) => e.field).join(', ') : '—'}
                        </td>
                        <td className="py-3 px-4 text-amber-700">
                          {ev.warnings.length > 0 ? ev.warnings.map((w) => w.field).join(', ') : '—'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            onClick={() => viewProductDetail(ev.productId)}
                            className="text-orange-700 hover:text-orange-800 font-medium cursor-pointer"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
