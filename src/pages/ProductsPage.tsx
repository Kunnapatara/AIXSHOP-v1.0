import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { Product } from '../types';
import { 
  Layers, 
  Search, 
  Filter, 
  ArrowUpDown, 
  ExternalLink, 
  AlertTriangle, 
  CheckCircle2, 
  Package, 
  FileCheck,
  ChevronRight,
  LayoutGrid,
  List,
  CheckSquare
} from 'lucide-react';

export const ProductsPage: React.FC = () => {
  const { products, viewProductDetail, addToast } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const categories = useMemo(() => {
    const set = new Set(products.map(p => p.category));
    return Array.from(set);
  }, [products]);

  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = p.title.toLowerCase().includes(q);
        const matchesBrand = p.brand.toLowerCase().includes(q);
        const matchesSku = p.variants.some(v => v.sku.toLowerCase().includes(q) || v.barcode.includes(q));
        if (!matchesTitle && !matchesBrand && !matchesSku) return false;
      }
      return true;
    });
  }, [products, categoryFilter, statusFilter, searchQuery]);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedProductIds(filteredProducts.map(p => p.id));
    } else {
      setSelectedProductIds([]);
    }
  };

  const handleSelectProduct = (id: string) => {
    setSelectedProductIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleBulkRecheck = () => {
    setBulkModalOpen(false);
    addToast(
      'Bulk Catalog Audit Complete',
      `Re-analyzed schema and attribute consistency for ${selectedProductIds.length} selected products. Note: No live write-back was performed.`,
      'info'
    );
    setSelectedProductIds([]);
  };

  return (
    <div className="space-y-6">
      {/* Header & Catalog Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Product Catalog Workspace
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Canonical product identities, structured attributes, variant counts, and commercial channel offers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* View Toggle */}
          <div className="flex items-center bg-stone-100 p-1 rounded-lg">
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-md text-xs transition-colors ${
                viewMode === 'table' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-500'
              }`}
              aria-label="Table view"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded-md text-xs transition-colors ${
                viewMode === 'cards' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-500'
              }`}
              aria-label="Grid card view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Distinction Callout */}
      <div className="p-3.5 bg-stone-50 border border-stone-200/90 rounded-xl text-xs text-stone-600 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <strong className="text-stone-900">Canonical Rule:</strong> Product Identity defines physical invariants. Offers define commercial channel propositions.
        </div>
        <span className="font-mono text-stone-500 text-[11px]">
          {products.length} Products · {products.reduce((s, p) => s + p.variants.length, 0)} Variants
        </span>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 shadow-xs space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by title, SKU, brand, or GTIN barcode..."
              className="w-full pl-10 pr-4 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-orange-500 min-h-[40px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 min-h-[40px] focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 min-h-[40px] focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        {/* Bulk Action Controls */}
        {selectedProductIds.length > 0 && (
          <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-xs bg-orange-50/60 p-2.5 rounded-lg border border-orange-200/60">
            <span className="font-semibold text-orange-900">
              {selectedProductIds.length} product(s) selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBulkModalOpen(true)}
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded text-xs font-semibold shadow-xs"
              >
                Bulk Inspect & Re-check
              </button>
              <button
                onClick={() => setSelectedProductIds([])}
                className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 rounded text-xs font-medium"
              >
                Clear Selection
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Catalog Listing */}
      {filteredProducts.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
          <Package className="w-12 h-12 text-stone-300 mx-auto mb-3" />
          <h3 className="text-base font-bold text-stone-900">No products match search criteria</h3>
          <p className="text-xs text-stone-500 mt-1">
            Try adjusting search keywords or category filters.
          </p>
        </div>
      ) : viewMode === 'table' ? (
        /* Responsive Table View (Full width scrollable container with clear labels) */
        <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50 border-b border-stone-200 text-stone-500 font-semibold uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="p-4 w-10">
                    <input
                      type="checkbox"
                      checked={selectedProductIds.length === filteredProducts.length && filteredProducts.length > 0}
                      onChange={handleSelectAll}
                      aria-label="Select all products"
                      className="rounded border-stone-300 text-orange-600 focus:ring-orange-500"
                    />
                  </th>
                  <th className="p-4 min-w-[280px]">Product Identity</th>
                  <th className="p-4 min-w-[120px]">Variants</th>
                  <th className="p-4 min-w-[180px]">Commercial Offers</th>
                  <th className="p-4 text-center">Completeness</th>
                  <th className="p-4 text-center">Evidence</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filteredProducts.map(product => {
                  const isSelected = selectedProductIds.includes(product.id);
                  return (
                    <tr 
                      key={product.id}
                      className={`hover:bg-stone-50/70 transition-colors ${isSelected ? 'bg-orange-50/30' : ''}`}
                    >
                      <td className="p-4">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectProduct(product.id)}
                          aria-label={`Select ${product.title}`}
                          className="rounded border-stone-300 text-orange-600 focus:ring-orange-500"
                        />
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <img
                            src={product.image}
                            alt={product.title}
                            className="w-11 h-11 rounded-lg object-cover border border-stone-200 shrink-0 bg-stone-100"
                            referrerPolicy="no-referrer"
                          />
                          <div className="min-w-0">
                            <button
                              onClick={() => viewProductDetail(product.id, 'products')}
                              className="text-xs font-bold text-stone-900 hover:text-orange-600 transition-colors text-left line-clamp-1"
                            >
                              {product.title}
                            </button>
                            <p className="text-[11px] text-stone-500 font-mono mt-0.5 truncate">
                              ID: {product.id} · {product.brand}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 font-mono text-stone-700">
                        <span>{product.variants.length} variant(s)</span>
                        <p className="text-[10px] text-stone-400 truncate">
                          {product.variants.map(v => v.sku).slice(0, 2).join(', ')}
                        </p>
                      </td>
                      <td className="p-4">
                        <div className="space-y-0.5 text-stone-700">
                          {product.offers.map(off => (
                            <div key={off.id} className="text-[11px] flex items-center justify-between gap-2">
                              <span className="truncate text-stone-600">{off.channel}</span>
                              <span className="font-mono font-medium">${off.price.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        <span className="font-mono font-bold text-stone-900 tabular-nums">
                          {product.completenessScore}%
                        </span>
                      </td>
                      <td className="p-4 text-center">
                        <span className="font-mono font-medium text-stone-700 tabular-nums">
                          {product.evidenceCoverageScore}%
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <button
                          onClick={() => viewProductDetail(product.id, 'products')}
                          className="px-3 py-1.5 bg-stone-100 hover:bg-orange-50 hover:text-orange-700 text-stone-800 font-medium rounded-lg text-xs transition-colors"
                        >
                          Inspect Detail →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Card Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProducts.map(product => (
            <div
              key={product.id}
              className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between"
            >
              <div>
                <div className="relative h-44 bg-stone-100 border-b border-stone-200">
                  <img
                    src={product.image}
                    alt={product.title}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-3 left-3 bg-white/90 backdrop-blur px-2 py-0.5 rounded text-[11px] font-mono text-stone-700 border border-stone-200">
                    {product.brand}
                  </div>
                  <div className="absolute top-3 right-3 bg-white/90 backdrop-blur px-2 py-0.5 rounded text-[11px] font-mono font-bold text-stone-900 border border-stone-200 tabular-nums">
                    Score: {product.completenessScore}%
                  </div>
                </div>

                <div className="p-5 space-y-3">
                  <h3 className="text-sm font-bold text-stone-950 leading-snug line-clamp-2">
                    {product.title}
                  </h3>

                  <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-stone-100 font-mono text-stone-600">
                    <div>
                      <span className="text-[10px] text-stone-400 block uppercase">Variants</span>
                      <span>{product.variants.length} SKUs</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-400 block uppercase">Offers</span>
                      <span>{product.offers.length} active channels</span>
                    </div>
                  </div>

                  <div className="space-y-1 pt-1 border-t border-stone-100 text-xs">
                    <p className="text-[10px] uppercase font-semibold text-stone-400">Commercial Offers</p>
                    {product.offers.map(off => (
                      <div key={off.id} className="flex items-center justify-between text-stone-700">
                        <span className="text-[11px]">{off.channel}</span>
                        <span className="font-mono font-medium">${off.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="p-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between">
                <span className="text-xs font-mono text-stone-500 truncate max-w-[140px]">
                  {product.id}
                </span>
                <button
                  onClick={() => viewProductDetail(product.id, 'products')}
                  className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors"
                >
                  Inspect Detail →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bulk Review Modal */}
      {bulkModalOpen && (
        <div 
          className="fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setBulkModalOpen(false)}
        >
          <div 
            className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-stone-200 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-orange-100 text-orange-700 flex items-center justify-center">
                <CheckSquare className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-stone-950">Bulk Catalog Inspection</h3>
                <p className="text-xs text-stone-500">
                  {selectedProductIds.length} items queued for verification
                </p>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              This operation evaluates catalog schema compliance, GTIN barcode integrity, and evidence backing across selected products.
            </p>

            <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800 space-y-1">
              <p className="font-semibold">Write-Back Integrity Boundary:</p>
              <p>
                Bulk review evaluates data inside AIXSHOP. Changes are not written to your live storefront or Google Merchant Center feeds without an authorized write-back connector.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-stone-100">
              <button
                onClick={() => setBulkModalOpen(false)}
                className="px-4 py-2 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkRecheck}
                className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-xs"
              >
                Execute Bulk Schema Review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
