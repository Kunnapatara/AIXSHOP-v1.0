import React from 'react';
import { ArrowLeft, Compass, Home, SearchCheck, FileText } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const NotFoundPage: React.FC = () => {
  const { navigateTo } = useApp();

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex flex-col font-sans">
      <header className="bg-[#FAF8F5]/95 border-b border-stone-200 px-4 sm:px-8 py-3.5">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigateTo('home')}
            className="flex items-center gap-2.5 text-left cursor-pointer"
          >
            <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm">
              AX
            </div>
            <span className="font-bold text-base tracking-tight text-stone-950">AIXSHOP</span>
            <span className="text-xs font-mono text-stone-400">v1.0</span>
          </button>
          <button
            type="button"
            onClick={() => navigateTo('landing')}
            className="px-3.5 py-1.5 text-xs font-semibold text-stone-700 bg-white border border-stone-200 hover:bg-stone-100 rounded-lg cursor-pointer"
          >
            Public Store Check
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="max-w-lg w-full bg-white border border-stone-200 rounded-2xl p-8 text-center space-y-6 shadow-sm">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-orange-50 border border-orange-200 text-xs font-mono font-bold text-orange-800">
            <Compass className="w-3.5 h-3.5" />
            <span>HTTP 404 · Page Not Found</span>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-950">
              We couldn’t find that page
            </h1>
            <p className="text-sm text-stone-600 leading-relaxed">
              The URL you requested does not match an active AIXSHOP workspace view or public page. Choose one of the verified destinations below to continue.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className="px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 min-h-[44px] cursor-pointer"
            >
              <Home className="w-4 h-4" />
              <span>Return to Store Overview</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('landing')}
              className="px-5 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-xl flex items-center justify-center gap-2 min-h-[44px] cursor-pointer"
            >
              <SearchCheck className="w-4 h-4" />
              <span>Go to Public Store Check</span>
            </button>
          </div>

          <div className="pt-4 border-t border-stone-100 flex flex-wrap items-center justify-center gap-4 text-xs text-stone-500">
            <button
              type="button"
              onClick={() => navigateTo('settings')}
              className="hover:text-stone-900 inline-flex items-center gap-1 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('privacy')}
              className="hover:text-stone-900 inline-flex items-center gap-1 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Privacy Policy (Draft)</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('terms')}
              className="hover:text-stone-900 inline-flex items-center gap-1 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Terms of Service (Draft)</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};
