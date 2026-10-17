import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
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
  RefreshCw
} from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const { 
    storeProfile, 
    updateStoreProfile, 
    toggleConnectorSync, 
    addToast,
    isReadOnlyMode,
    isDurableStorage,
    products
  } = useApp();

  const [activeTab, setActiveTab] = useState<'profile' | 'connectors' | 'subscription' | 'policies' | 'diagnostics'>('profile');
  const [storeName, setStoreName] = useState(storeProfile.name);
  const [storeDomain, setStoreDomain] = useState(storeProfile.domain);
  const [currency, setCurrency] = useState(storeProfile.currency);
  const [strictness, setStrictness] = useState(storeProfile.truthBoundaryStrictness);
  const [isDiagnosticsUnlocked, setIsDiagnosticsUnlocked] = useState(false);

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

      {activeTab === 'connectors' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-5">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div>
              <h3 className="text-sm font-bold text-stone-900">Integration Connectors & Channel Feeds</h3>
              <p className="text-xs text-stone-500">Integration status and catalog synchronization feeds</p>
            </div>
            <span className="text-xs font-mono text-stone-400">Connection Verification</span>
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
                  {connector.status === 'disconnected' && (
                    <p className="text-[11px] text-stone-500 mt-1.5 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                      <span>Live integration not configured. External OAuth and synchronization are unavailable.</span>
                    </p>
                  )}
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
            Write-back permissions require explicit OAuth token authorization with catalog write scopes. In this preview environment, live storefront mutation is unavailable and connectors default to safe read-only auditing.
          </div>
        </div>
      )}

      {activeTab === 'subscription' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div>
              <h3 className="text-sm font-bold text-stone-900">Subscription & SKU Capacity</h3>
              <p className="text-xs text-stone-500">Workspace scale limits and demo plan parameters (unverified entitlement)</p>
            </div>
            <span className="text-xs font-mono font-bold text-orange-700 bg-orange-50 px-2 py-0.5 rounded border border-orange-200">
              {storeProfile.tier} (Demo Fixture)
            </span>
          </div>

          <div className="p-5 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-stone-900">Catalog SKU Utilization</span>
              <span className="font-mono text-stone-600">
                {products.length} catalog products / {storeProfile.skuLimit} SKU Limit ({((products.length / storeProfile.skuLimit) * 100).toFixed(1)}%)
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-stone-200 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-orange-600 h-2.5 rounded-full" 
                style={{ width: `${Math.min(100, (products.length / storeProfile.skuLimit) * 100)}%` }}
              ></div>
            </div>

            <p className="text-xs text-stone-500">
              Capacity baseline: {storeProfile.skuLimit} SKUs. Plan tier and limits reflect local workspace configuration without verified third-party billing enforcement.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-stone-500">Billing Cadence</span>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                  Not Configured
                </span>
              </div>
              <p className="text-base font-bold text-stone-900 font-mono">$179 / mo</p>
              <p className="text-stone-500">Target tier reference · No active billing provider</p>
            </div>

            <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-stone-500">Audit & Sync</span>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                  Manual Only
                </span>
              </div>
              <p className="text-base font-bold text-stone-900 font-mono">On-Demand</p>
              <p className="text-stone-500">Live webhook synchronization not configured</p>
            </div>

            <div className="p-4 bg-white border border-stone-200 rounded-xl text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-stone-500">Support Entitlement</span>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                  Self-Serve
                </span>
              </div>
              <p className="text-base font-bold text-stone-900 font-mono">Standard Workspace</p>
              <p className="text-stone-500">Priority SaaS requires verified enterprise contract</p>
            </div>
          </div>

          <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-600">
            <strong className="block mb-0.5 text-stone-800">Integration Notice:</strong>
            Recurring billing, payment gateways, live webhook listeners, and paid SaaS entitlements are not implemented in this workspace. Displayed metrics and capacity allowances serve as local application constraints.
          </div>
        </div>
      )}

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
