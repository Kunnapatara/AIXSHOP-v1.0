import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  ArrowLeft, 
  ExternalLink, 
  ShieldCheck, 
  AlertTriangle, 
  CheckCircle2, 
  Layers, 
  Package, 
  FileText, 
  Sparkles, 
  RefreshCw,
  Info,
  Tag,
  SlidersHorizontal,
  Bot
} from 'lucide-react';

export const ProductDetailPage: React.FC = () => {
  const { 
    selectedProduct, 
    previousPage, 
    returnFromProductDetail, 
    navigateTo, 
    findings, 
    recheckProduct 
  } = useApp();

  const [activeTab, setActiveTab] = useState<'attributes' | 'variants' | 'offers' | 'evidence' | 'shopper_preview'>('attributes');
  const [isRechecking, setIsRechecking] = useState(false);

  // Proper Not-Found Recovery State (Never silently substitute another product)
  if (!selectedProduct) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs max-w-xl mx-auto my-12">
        <Package className="w-12 h-12 text-stone-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-stone-900">Product Not Found</h2>
        <p className="text-xs text-stone-500 mt-1 max-w-md mx-auto">
          The requested canonical product identifier does not exist or has been removed from the catalog index.
        </p>
        <button
          onClick={returnFromProductDetail}
          className="mt-6 px-4 py-2 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Return to Catalog</span>
        </button>
      </div>
    );
  }

  const productFindings = findings.filter(f => f.productId === selectedProduct.id);

  const handleRecheck = () => {
    setIsRechecking(true);
    setTimeout(() => {
      recheckProduct(selectedProduct.id);
      setIsRechecking(false);
    }, 700);
  };

  return (
    <div className="space-y-6">
      {/* Back Navigation Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-stone-200">
        <button
          onClick={returnFromProductDetail}
          className="inline-flex items-center gap-2 text-xs font-semibold text-stone-600 hover:text-stone-950 transition-colors w-fit p-1 -ml-1 rounded"
          aria-label={`Return to ${previousPage}`}
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to {previousPage === 'audit' ? 'Audit Findings' : previousPage === 'actions' ? 'Action Center' : previousPage === 'home' ? 'Store Home' : 'Products Catalog'}</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-stone-400">
            Last audited: {new Date(selectedProduct.lastAudited).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <button
            onClick={handleRecheck}
            disabled={isRechecking}
            className="px-3 py-1.5 bg-white border border-stone-300 hover:border-stone-400 text-stone-800 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRechecking ? 'animate-spin' : ''}`} />
            <span>{isRechecking ? 'Re-checking...' : 'Re-check Product'}</span>
          </button>
        </div>
      </div>

      {/* Product Hero Header */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
          <div className="md:col-span-3">
            <img
              src={selectedProduct.image}
              alt={selectedProduct.title}
              className="w-full h-48 sm:h-56 object-cover rounded-xl border border-stone-200 bg-stone-100"
              referrerPolicy="no-referrer"
            />
          </div>

          <div className="md:col-span-9 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-stone-900">{selectedProduct.brand}</span>
              <span className="text-stone-300">·</span>
              <span className="text-stone-500">{selectedProduct.category}</span>
              <span className="text-stone-300">·</span>
              <span className="font-mono text-stone-400">Canonical ID: {selectedProduct.id}</span>
            </div>

            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
              {selectedProduct.title}
            </h1>

            <p className="text-xs sm:text-sm text-stone-600 leading-relaxed max-w-3xl">
              {selectedProduct.description}
            </p>

            {/* Tri-Partite Scores for this specific product */}
            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-stone-100 max-w-xl">
              <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                <span className="text-[10px] text-stone-500 font-medium block">Catalog Completeness</span>
                <span className="text-xl font-bold font-mono text-stone-900 tabular-nums">
                  {selectedProduct.completenessScore}%
                </span>
              </div>
              <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                <span className="text-[10px] text-stone-500 font-medium block">Evidence Coverage</span>
                <span className="text-xl font-bold font-mono text-stone-900 tabular-nums">
                  {selectedProduct.evidenceCoverageScore}%
                </span>
              </div>
              <div className="p-2.5 bg-stone-50 rounded-xl border border-stone-200/80">
                <span className="text-[10px] text-stone-500 font-medium block">External Discovery</span>
                <span className="text-xs font-semibold text-stone-800 capitalize mt-1 block">
                  {selectedProduct.externalDiscoveryStatus.replace(/_/g, ' ')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Relevant Diagnostic Findings Alert Banner (if any) */}
      {productFindings.length > 0 && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-stone-900">
                  {productFindings.length} Active Finding(s) Detected for This Product
                </h3>
                <p className="text-xs text-stone-600 mt-0.5">
                  Unresolved specifications may cause AI shoppers to downgrade or omit this product from recommendation lists.
                </p>
                <div className="mt-2 space-y-1">
                  {productFindings.map(f => (
                    <div key={f.id} className="text-xs text-stone-800 flex items-center gap-2">
                      <span className="font-mono text-[10px] font-bold text-amber-800 uppercase px-1.5 py-0.5 rounded bg-amber-100">
                        {f.severity}
                      </span>
                      <span>{f.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => navigateTo('actions', productFindings[0]?.actionItemId)}
              className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shrink-0 whitespace-nowrap shadow-xs"
            >
              Resolve in Actions →
            </button>
          </div>
        </div>
      )}

      {/* Contextual Tabs */}
      <div className="flex border-b border-stone-200 overflow-x-auto gap-2">
        <button
          onClick={() => setActiveTab('attributes')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'attributes'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Structured Attributes ({Object.keys(selectedProduct.attributes).length})
        </button>

        <button
          onClick={() => setActiveTab('variants')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'variants'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Variants ({selectedProduct.variants.length})
        </button>

        <button
          onClick={() => setActiveTab('offers')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'offers'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Commercial Offers ({selectedProduct.offers.length})
        </button>

        <button
          onClick={() => setActiveTab('evidence')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
            activeTab === 'evidence'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          Evidence & Provenance ({selectedProduct.evidenceDocuments.length})
        </button>

        <button
          onClick={() => setActiveTab('shopper_preview')}
          className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'shopper_preview'
              ? 'border-orange-600 text-orange-700'
              : 'border-transparent text-stone-600 hover:text-stone-900'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          <span>Shopper Assistant Preview</span>
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === 'attributes' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div>
              <h3 className="text-sm font-bold text-stone-900">Structured Specification Attributes</h3>
              <p className="text-xs text-stone-500">Key-value attributes parsed by AI web crawlers and schema parsers</p>
            </div>
            <span className="text-xs font-mono text-stone-400">Schema.org JSON-LD compliant</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(selectedProduct.attributes).map(([key, val]) => (
              <div key={key} className="p-3 bg-stone-50 rounded-xl border border-stone-200/80">
                <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wider block">
                  {key}
                </span>
                <span className="text-xs font-semibold text-stone-900 mt-0.5 block break-words">
                  {val}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'variants' && (
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
            <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wider">
              Product Variants & Physical Identifiers
            </h3>
            <span className="text-xs font-mono text-stone-500">
              {selectedProduct.variants.length} child SKUs
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50/50 border-b border-stone-200 text-stone-500 font-semibold uppercase text-[11px]">
                <tr>
                  <th className="p-3.5">Variant Title</th>
                  <th className="p-3.5">SKU</th>
                  <th className="p-3.5">GTIN / Barcode</th>
                  <th className="p-3.5">Attributes</th>
                  <th className="p-3.5 text-right">Price</th>
                  <th className="p-3.5 text-right">Inventory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {selectedProduct.variants.map(v => (
                  <tr key={v.id} className="hover:bg-stone-50/50">
                    <td className="p-3.5 font-semibold text-stone-900">{v.title}</td>
                    <td className="p-3.5 font-mono text-stone-700">{v.sku}</td>
                    <td className="p-3.5 font-mono">
                      {v.barcode ? (
                        <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                          {v.barcode}
                        </span>
                      ) : (
                        <span className="text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200 font-semibold">
                          Missing GTIN
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 text-stone-600">
                      {Object.entries(v.attributes).map(([k, val]) => `${k}: ${val}`).join(' · ')}
                    </td>
                    <td className="p-3.5 text-right font-mono font-medium">
                      {v.price != null ? `$${v.price.toFixed(2)}` : <span className="text-stone-400 italic font-sans text-xs">Unpriced</span>}
                    </td>
                    <td className="p-3.5 text-right font-mono text-stone-700">
                      {typeof v.inventoryCount === 'number'
                        ? v.inventoryCount > 0
                          ? `${v.inventoryCount} units`
                          : <span className="text-rose-600 font-sans text-xs font-semibold">0 units (Out of stock)</span>
                        : <span className="text-stone-400 font-sans text-xs italic">Unavailable (Public feed)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'offers' && (
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wider">
                Commercial Channel Offers (Product ≠ Offer)
              </h3>
              <p className="text-[11px] text-stone-500 mt-0.5">
                Channel-specific commercial terms, pricing, and availability
              </p>
            </div>
            <span className="text-xs font-mono text-stone-500">
              {selectedProduct.offers.length} active channels
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50/50 border-b border-stone-200 text-stone-500 font-semibold uppercase text-[11px]">
                <tr>
                  <th className="p-3.5">Channel</th>
                  <th className="p-3.5">Offer ID</th>
                  <th className="p-3.5">Price</th>
                  <th className="p-3.5">Availability</th>
                  <th className="p-3.5">Condition</th>
                  <th className="p-3.5">Last Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {selectedProduct.offers.map(off => (
                  <tr key={off.id} className="hover:bg-stone-50/50">
                    <td className="p-3.5 font-semibold text-stone-900">{off.channel}</td>
                    <td className="p-3.5 font-mono text-stone-500">{off.id}</td>
                    <td className="p-3.5 font-mono font-bold text-stone-900">${off.price.toFixed(2)} {off.currency}</td>
                    <td className="p-3.5 capitalize">
                      <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                        {off.availability.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="p-3.5 capitalize text-stone-700">{off.condition}</td>
                    <td className="p-3.5 font-mono text-stone-500">{off.lastSync}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'evidence' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div>
              <h3 className="text-sm font-bold text-stone-900">Evidence & Provenance Registry</h3>
              <p className="text-xs text-stone-500">Third-party certificates, lab reports, and standards substantiating product claims</p>
            </div>
            <span className="text-xs font-mono text-stone-400">Strict Truth Policy</span>
          </div>

          {selectedProduct.evidenceDocuments.length === 0 ? (
            <div className="p-8 text-center bg-stone-50 rounded-xl border border-dashed border-stone-300">
              <FileText className="w-8 h-8 text-stone-400 mx-auto mb-2" />
              <p className="text-xs font-semibold text-stone-800">No Evidence Documents Attached</p>
              <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
                Claims such as organic, non-toxic, or origin grade lack attached third-party proof documents.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedProduct.evidenceDocuments.map(doc => (
                <div key={doc.id} className="p-4 bg-stone-50 rounded-xl border border-stone-200 flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-stone-900">{doc.title}</span>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded uppercase font-semibold ${
                        doc.status === 'verified' 
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' 
                          : 'bg-amber-50 text-amber-800 border border-amber-200'
                      }`}>
                        {doc.status}
                      </span>
                    </div>
                    <p className="text-xs text-stone-500 mt-1 font-mono">
                      Issuer: {doc.issuer} · Verified: {doc.dateVerified}
                    </p>
                  </div>
                  <span className="text-xs font-mono text-stone-400">{doc.id}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'shopper_preview' && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-orange-600" />
              <h3 className="text-sm font-bold text-stone-900">Shopper Assistant Interpretation Model</h3>
            </div>
            <span className="text-xs font-mono text-stone-400">Contextual simulation</span>
          </div>

          <p className="text-xs text-stone-600 leading-relaxed">
            This simulation demonstrates how an external conversational shopping agent parses this product based strictly on your structured attributes, highlighting confident answers versus uncertainty gaps:
          </p>

          <div className="p-4 bg-stone-900 text-stone-100 rounded-xl space-y-3 text-xs font-mono leading-relaxed">
            <p className="text-stone-400"># Shopper Assistant Synthetic Knowledge Graph</p>
            <p>
              <strong className="text-orange-400">ENTITY:</strong> {selectedProduct.title} ({selectedProduct.brand})
            </p>
            <p>
              <strong className="text-emerald-400">HIGH CONFIDENCE FACTS:</strong>
            </p>
            <ul className="list-disc pl-5 space-y-1 text-stone-300">
              {Object.entries(selectedProduct.attributes).slice(0, 4).map(([k, v]) => (
                <li key={k}>{k}: {v}</li>
              ))}
            </ul>
            {productFindings.length > 0 && (
              <div className="pt-2 border-t border-stone-800 text-amber-400">
                <p><strong>RESERVATION / HESITATION TRIGGERS:</strong></p>
                <ul className="list-disc pl-5 space-y-1 text-stone-300">
                  {productFindings.map(f => (
                    <li key={f.id}>{f.title} ({f.derivedConclusion})</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
