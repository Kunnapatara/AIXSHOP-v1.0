import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../api/client';
import { VisibilitySummary } from '../domain/monitoring/aiVisibilityTypes';
import { UploadCloud, AlertCircle, BarChart3, FileSpreadsheet, Info } from 'lucide-react';

const SAMPLE_CSV_TEMPLATE = `date,platform,brand_mentions,product_mentions,website_clicks,topic
2026-11-01,ChatGPT Search,14,29,11,ceramic coffee pour over
2026-11-02,Perplexity Shopping,9,18,7,linen kitchen apron`;

export const AiVisibilityPage: React.FC = () => {
  const { addToast } = useApp();
  const { isAuthenticated, openAuthModal } = useAuth();

  const [summary, setSummary] = useState<VisibilitySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvInput, setCsvInput] = useState('');
  const [filename, setFilename] = useState('merchant_visibility_export.csv');
  const [showUploadForm, setShowUploadForm] = useState(false);

  const loadSummary = React.useCallback(async () => {
    if (!isAuthenticated) {
      setSummary({
        connected: false,
        status: 'DATA_SOURCE_NOT_CONNECTED',
        message: 'DATA SOURCE NOT CONNECTED - Sign in and upload verified merchant analytics CSV exports.',
        totalBrandMentions: 0,
        totalProductMentions: 0,
        totalWebsiteClicks: 0,
        platforms: [],
        recentObservations: [],
        imports: [],
      });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getVisibilitySummary();
      setSummary(res.summary);
    } catch (err: any) {
      setError(err.message || 'Failed to load visibility summary');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = typeof ev.target?.result === 'string' ? ev.target.result : '';
      setCsvInput(text);
    };
    reader.readAsText(file);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      openAuthModal('login');
      return;
    }
    if (!csvInput.trim()) {
      addToast('Missing CSV Data', 'Please select or paste CSV analytics rows first.', 'warning');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const res = await apiClient.uploadVisibilityCsv(csvInput, filename);
      setSummary(res.summary);
      setShowUploadForm(false);
      setCsvInput('');
      addToast(
        'Analytics Imported',
        `Imported ${res.import?.rowCount || 0} deduplicated observation rows.`,
        'success'
      );
    } catch (err: any) {
      setError(err.message || 'Failed to import CSV analytics');
      addToast('Import Failed', err.message || 'Invalid CSV analytics format.', 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            AI Visibility Monitoring
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Evidence-backed tracking of verified merchant AI referral and citation analytics. No synthetic or simulated visibility metrics are generated.
          </p>
        </div>

        <button
          onClick={() => setShowUploadForm((v) => !v)}
          className="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <UploadCloud className="w-3.5 h-3.5" />
          <span>{showUploadForm ? 'Close Import Panel' : 'Import Analytics CSV'}</span>
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showUploadForm && (
        <form onSubmit={handleUpload} className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-stone-900">Upload Verified Merchant Analytics CSV</h2>
              <p className="text-xs text-stone-500">
                Required columns: <code className="font-mono">date</code> (strict YYYY-MM-DD) and <code className="font-mono">platform</code> (e.g. ChatGPT Search, Perplexity Shopping). Integers must be non-negative; malformed rows fail atomically without defaults.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCsvInput(SAMPLE_CSV_TEMPLATE)}
              className="text-xs font-medium text-orange-700 hover:text-orange-800 whitespace-nowrap cursor-pointer"
            >
              Load CSV Column Example
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileSelect}
              className="text-xs text-stone-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-stone-300 file:text-xs file:font-semibold file:bg-stone-50 file:text-stone-800 hover:file:bg-stone-100"
            />
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="Import filename label"
              className="px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-800"
            />
          </div>

          <textarea
            rows={5}
            value={csvInput}
            onChange={(e) => setCsvInput(e.target.value)}
            placeholder="Paste CSV content here..."
            className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
          />

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={uploading}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50 cursor-pointer"
            >
              {uploading ? 'Importing...' : 'Ingest & Deduplicate CSV'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="h-48 bg-white border border-stone-200 rounded-xl animate-pulse" />
      ) : summary && !summary.connected ? (
        <div className="bg-white border border-stone-200 rounded-xl p-10 text-center space-y-3">
          <BarChart3 className="w-8 h-8 text-stone-400 mx-auto" />
          <div className="text-xs font-mono font-semibold text-stone-600 uppercase tracking-wide">
            {summary.status.replace(/_/g, ' ')}
          </div>
          <h2 className="text-base font-bold text-stone-900">No Verified AI Visibility Data Connected</h2>
          <p className="text-xs text-stone-500 max-w-md mx-auto leading-relaxed">
            {summary.message}. AIXSHOP does not fabricate AI search rankings or synthetic mention counts. Upload verified analytics exports from your search or referral telemetry to populate this view.
          </p>
          <div className="pt-2">
            <button
              onClick={() => (isAuthenticated ? setShowUploadForm(true) : openAuthModal('login'))}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg cursor-pointer"
            >
              {isAuthenticated ? 'Import Analytics CSV' : 'Sign In to Import Data'}
            </button>
          </div>
        </div>
      ) : summary ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Brand Mentions</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-stone-950 mt-1 block">
                {summary.totalBrandMentions}
              </span>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Product Citations</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-stone-950 mt-1 block">
                {summary.totalProductMentions}
              </span>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <span className="text-xs font-medium text-stone-500 block">Verified Website Clicks</span>
              <span className="text-2xl font-bold font-mono tabular-nums text-stone-950 mt-1 block">
                {summary.totalWebsiteClicks}
              </span>
            </div>
          </div>

          {/* Platform Breakdown */}
          {summary.platforms.length > 0 && (
            <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-stone-200">
                <h2 className="text-xs font-bold text-stone-900">Platform Breakdown</h2>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-stone-600 font-semibold">
                    <th className="py-2.5 px-4">Platform</th>
                    <th className="py-2.5 px-4 text-right">Total Mentions</th>
                    <th className="py-2.5 px-4 text-right">Website Clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 font-mono tabular-nums">
                  {summary.platforms.map((p) => (
                    <tr key={p.platform}>
                      <td className="py-2.5 px-4 font-sans font-medium text-stone-900">{p.platform}</td>
                      <td className="py-2.5 px-4 text-right">{p.mentions}</td>
                      <td className="py-2.5 px-4 text-right">{p.clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Observations Table */}
          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
              <h2 className="text-xs font-bold text-stone-900">Recent Verified Observations</h2>
              <span className="text-xs font-mono text-stone-500">
                {summary.imports.length} import batch(es)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-stone-600 font-semibold">
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Platform</th>
                    <th className="py-2.5 px-4">Discovery Topic</th>
                    <th className="py-2.5 px-4 text-right">Brand</th>
                    <th className="py-2.5 px-4 text-right">Product</th>
                    <th className="py-2.5 px-4 text-right">Clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {summary.recentObservations.map((obs) => (
                    <tr key={obs.id} className="hover:bg-stone-50/70">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-stone-700">{obs.observationDate}</td>
                      <td className="py-2.5 px-4 font-medium text-stone-900">{obs.platform}</td>
                      <td className="py-2.5 px-4 text-stone-600">{obs.discoveryTopic || '—'}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">{obs.brandMentions}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">{obs.productMentions}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">{obs.websiteClicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
