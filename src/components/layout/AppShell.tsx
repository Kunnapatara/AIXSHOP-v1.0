import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { NavigationPage } from '../../types';
import { 
  Home, 
  SearchCheck, 
  Layers, 
  CheckSquare, 
  Settings, 
  Menu, 
  X, 
  Store, 
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  AlertTriangle
} from 'lucide-react';
import { ToastContainer } from '../common/ToastContainer';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { 
    currentPage, 
    navigateTo, 
    storeProfile, 
    mobileMenuOpen, 
    setMobileMenuOpen,
    findings,
    actionItems,
    isReadOnlyMode,
    readOnlyReason
  } = useApp();

  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // If currently on Landing page, we render landing page with its own specialized top/footer layout
  if (currentPage === 'landing') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex flex-col font-sans">
        {children}
        <ToastContainer />
      </div>
    );
  }

  const primaryNavItems: { id: NavigationPage; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'home', label: 'Home', icon: Home },
    { 
      id: 'audit', 
      label: 'Audit', 
      icon: SearchCheck, 
      badge: findings.filter(f => !f.merchantVerified).length 
    },
    { id: 'products', label: 'Products', icon: Layers },
    { 
      id: 'actions', 
      label: 'Actions', 
      icon: CheckSquare, 
      badge: actionItems.filter(a => a.status === 'pending_review').length 
    },
  ];

  const getPageTitle = () => {
    switch (currentPage) {
      case 'home': return 'Store Overview';
      case 'audit': return 'Catalog & Store Audit';
      case 'products': return 'Product Catalog';
      case 'product-detail': return 'Product Intelligence';
      case 'actions': return 'Merchant Action Center';
      case 'settings': return 'Store & Catalog Settings';
      default: return 'AIXSHOP';
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex flex-col md:flex-row font-sans">
      {/* Desktop Sidebar Navigation */}
      <aside 
        aria-label="Main Desktop Sidebar" 
        className="hidden md:flex flex-col w-64 bg-white border-r border-stone-200 shrink-0 sticky top-0 h-screen justify-between z-20"
      >
        <div>
          {/* Brand Wordmark & Mode */}
          <div className="px-5 py-5 border-b border-stone-100 flex items-center justify-between">
            <button
              onClick={() => navigateTo('home')}
              className="text-left group flex items-center gap-2.5 focus:outline-none"
            >
              <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm shadow-sm">
                AX
              </div>
              <div>
                <span className="font-bold text-base tracking-tight text-stone-950 group-hover:text-orange-600 transition-colors">
                  AIXSHOP
                </span>
                <span className="text-[11px] font-mono text-stone-400 block -mt-0.5">
                  v1.0 · Commerce Intel
                </span>
              </div>
            </button>
          </div>

          {/* Connected Store Header Indicator */}
          <div className="px-4 py-3 mx-3 mt-3 bg-stone-50 border border-stone-200/80 rounded-xl">
            <div className="flex items-center gap-2">
              <Store className="w-4 h-4 text-orange-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-stone-900 truncate">
                  {storeProfile.name}
                </p>
                <p className="text-[11px] font-mono text-stone-500 truncate">
                  {storeProfile.skuCount} active products
                </p>
              </div>
            </div>
          </div>

          {/* Primary Navigation - Strictly exactly 4 merchant items */}
          <nav aria-label="Merchant Navigation" className="px-3 py-4 space-y-1">
            <div className="px-3 pb-2 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
              Merchant Workspace
            </div>
            {primaryNavItems.map(item => {
              const Icon = item.icon;
              const isActive = currentPage === item.id || (currentPage === 'product-detail' && item.id === 'products');
              return (
                <button
                  key={item.id}
                  onClick={() => navigateTo(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    isActive 
                      ? 'bg-orange-50 text-orange-700 font-semibold' 
                      : 'text-stone-700 hover:bg-stone-100 hover:text-stone-900'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-orange-600' : 'text-stone-500'}`} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer: Public Landing preview & Store / Settings entry point */}
        <div className="p-3 border-t border-stone-100 space-y-2">
          {/* Public Landing Link */}
          <button
            onClick={() => navigateTo('landing')}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ExternalLink className="w-3.5 h-3.5 text-stone-400" />
              <span>Public Store Check</span>
            </div>
            <span className="text-[10px] text-stone-400 font-mono">Landing</span>
          </button>

          {/* Account & Store / Settings Entry Point */}
          <button
            onClick={() => navigateTo('settings')}
            className={`w-full p-2.5 rounded-xl border flex items-center justify-between text-left transition-all ${
              currentPage === 'settings' 
                ? 'border-orange-300 bg-orange-50/60' 
                : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-stone-100 border border-stone-200 flex items-center justify-center text-stone-700 shrink-0">
                <Settings className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-stone-900 truncate">Store / Settings</p>
                <p className="text-[10px] text-stone-500 font-mono truncate">{storeProfile.tier}</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header / Top Bar */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3 flex items-center justify-between gap-3 md:px-8 md:py-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-lg text-stone-700 hover:bg-stone-100 focus:outline-none min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Open mobile navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>

            {/* Wordmark (mobile) or Breadcrumb title (desktop) */}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm md:text-base font-bold text-stone-950 truncate">
                  {getPageTitle()}
                </span>
                {currentPage === 'product-detail' && (
                  <span className="text-xs text-stone-500 font-mono hidden sm:inline">
                    · Contextual View
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-500 hidden md:block">
                AI Commerce Visibility & Product Catalog Intelligence
              </p>
            </div>
          </div>

          {/* Top Bar Actions: Account / Settings link and Demo Mode Badge */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigateTo('landing')}
              className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors min-h-[36px]"
            >
              <ExternalLink className="w-3.5 h-3.5 text-stone-500" />
              <span>Public Site</span>
            </button>

            {/* Store / Settings Entry Point */}
            <button
              onClick={() => navigateTo('settings')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300 bg-white text-xs font-medium text-stone-800 transition-colors min-h-[44px]"
              aria-label="Store configuration and account settings"
            >
              <Store className="w-3.5 h-3.5 text-orange-600" />
              <span className="hidden sm:inline font-medium">{storeProfile.name.split(' ')[0]} Store</span>
              <Settings className="w-3.5 h-3.5 text-stone-500" />
            </button>
          </div>
        </header>

        {/* Mobile Hamburger Drawer */}
        {mobileMenuOpen && (
          <div 
            className="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-xs md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          >
            <div 
              className="absolute top-0 left-0 bottom-0 w-72 bg-white p-5 flex flex-col justify-between shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <div>
                <div className="flex items-center justify-between pb-4 border-b border-stone-100">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-xs">
                      AX
                    </div>
                    <span className="font-bold text-base text-stone-900">AIXSHOP v1.0</span>
                  </div>
                  <button 
                    onClick={() => setMobileMenuOpen(false)}
                    className="p-2 text-stone-500 hover:text-stone-900 min-h-[44px] min-w-[44px] flex items-center justify-center"
                    aria-label="Close menu"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="my-4 p-3 bg-stone-50 rounded-xl border border-stone-200 text-xs">
                  <p className="font-semibold text-stone-900">{storeProfile.name}</p>
                  <p className="text-[11px] text-stone-500 font-mono mt-0.5">{storeProfile.tier}</p>
                </div>

                <div className="space-y-1">
                  <div className="px-2 py-1 text-[11px] font-semibold text-stone-400 uppercase tracking-wider">
                    Primary Navigation
                  </div>
                  {primaryNavItems.map(item => {
                    const Icon = item.icon;
                    const isActive = currentPage === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => navigateTo(item.id)}
                        className={`w-full flex items-center justify-between px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                          isActive 
                            ? 'bg-orange-50 text-orange-700 font-semibold' 
                            : 'text-stone-700 hover:bg-stone-50'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <Icon className={`w-4 h-4 ${isActive ? 'text-orange-600' : 'text-stone-500'}`} />
                          <span>{item.label}</span>
                        </div>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="text-xs font-mono px-2 py-0.5 rounded bg-orange-100 text-orange-800">
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 border-t border-stone-100 space-y-2">
                <button
                  onClick={() => navigateTo('settings')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-stone-700 hover:bg-stone-50 min-h-[44px]"
                >
                  <Settings className="w-4 h-4 text-stone-500" />
                  <span>Store / Settings</span>
                </button>
                <button
                  onClick={() => navigateTo('landing')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-50 min-h-[44px]"
                >
                  <ExternalLink className="w-4 h-4 text-stone-400" />
                  <span>Public Landing & Store Check</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Content Body with bottom padding on mobile for the fixed bottom nav */}
        <main className="flex-1 px-4 py-5 md:px-8 md:py-6 pb-24 md:pb-10 max-w-7xl w-full mx-auto">
          {isReadOnlyMode && (
            <div className="mb-5 p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-start gap-2.5 shadow-xs" role="alert">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block">Read-Only Compatibility Mode Active</span>
                <span className="text-amber-800">
                  {readOnlyReason || 'Stored data uses an unsupported future schema version. Local mutations are disabled to protect data integrity.'}
                </span>
              </div>
            </div>
          )}
          {children}
        </main>

        {/* Mobile Bottom Navigation: Exactly 4 Primary Destinations */}
        <nav 
          aria-label="Mobile Bottom Navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-stone-200 z-30 flex items-center justify-around h-16 px-2 shadow-lg"
        >
          {primaryNavItems.map(item => {
            const Icon = item.icon;
            const isActive = currentPage === item.id || (currentPage === 'product-detail' && item.id === 'products');
            return (
              <button
                key={item.id}
                onClick={() => navigateTo(item.id)}
                className={`flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] transition-colors relative ${
                  isActive ? 'text-orange-600' : 'text-stone-500 hover:text-stone-900'
                }`}
                aria-label={item.label}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute -top-1 -right-2 w-4 h-4 rounded-full bg-orange-600 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className={`text-[11px] mt-1 ${isActive ? 'font-semibold' : 'font-normal'}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <ToastContainer />
    </div>
  );
};
