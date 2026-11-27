import React from 'react';
import { ArrowLeft, ShieldAlert, Scale, CreditCard, Store, AlertTriangle } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const TermsOfServicePage: React.FC = () => {
  const { navigateTo } = useApp();

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex flex-col font-sans">
      <header className="sticky top-0 z-30 bg-[#FAF8F5]/95 backdrop-blur border-b border-stone-200 px-4 sm:px-8 py-3.5">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => navigateTo('landing')}
            className="inline-flex items-center gap-2 text-xs font-semibold text-stone-700 hover:text-stone-950 min-h-[40px] cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to AIXSHOP</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateTo('privacy')}
              className="px-3 py-1.5 text-xs font-medium text-stone-600 hover:text-stone-950 rounded-lg hover:bg-stone-100"
            >
              Privacy Policy (Draft)
            </button>
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg"
            >
              Merchant App
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-8 py-10 space-y-8">
        {/* Mandatory Legal Review Draft Notice */}
        <div
          className="p-4 bg-amber-50 border-2 border-amber-300 rounded-xl flex items-start gap-3"
          role="note"
          aria-label="Draft legal document notice"
        >
          <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-950 space-y-1">
            <p className="font-bold uppercase tracking-wide">
              Draft Document — Legal Review Required Before Commercial Publication
            </p>
            <p className="leading-relaxed">
              These Terms of Service are an unreviewed draft template for internal and legal counsel preparation. Using this draft does not constitute legal advice and does not guarantee compliance with Stripe Connect/Billing policies, Shopify App Store requirements, or commercial/consumer contract laws in any jurisdiction.
            </p>
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-2xl p-6 sm:p-8 space-y-6 shadow-xs">
          <div className="border-b border-stone-200 pb-5 space-y-2">
            <span className="text-xs font-mono font-semibold uppercase tracking-wider text-orange-700 bg-orange-50 px-2.5 py-1 rounded">
              Draft Terms of Service · AIXSHOP v1.0
            </span>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-950 pt-1">
              Terms of Service (Draft Template)
            </h1>
            <p className="text-xs text-stone-500 font-mono">
              Status: Unreviewed Draft · Governing Law, Liability Caps &amp; Operator Entity Must Be Finalized
            </p>
          </div>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <Scale className="w-4 h-4 text-orange-600" />
              <span>1. Service Scope &amp; Non-Guarantee of External Discovery</span>
            </h2>
            <p className="text-xs sm:text-sm text-stone-600">
              AIXSHOP provides B2B Shopify and online storefront catalog auditing, schema completeness analysis, and feed readiness checks. AIXSHOP does not guarantee ranking, citation, conversion lift, or inclusion in third-party AI assistants, search engines, or shopping marketplaces.
            </p>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <Store className="w-4 h-4 text-orange-600" />
              <span>2. Storefront Sync &amp; Optional Shopify Write-Back</span>
            </h2>
            <ul className="list-disc pl-5 space-y-1 text-xs sm:text-sm text-stone-600">
              <li>
                <strong>Public Discovery:</strong> Unauthenticated URL checks sample public storefront JSON endpoints where accessible and do not create an authenticated Shopify integration.
              </li>
              <li>
                <strong>Authenticated Shopify OAuth:</strong> Connects only to stores explicitly authorized by the merchant. Default sync permissions are read-only (<code className="font-mono">read_products</code>).
              </li>
              <li>
                <strong>Write-Back Responsibility:</strong> If a merchant explicitly grants <code className="font-mono">write_products</code> and triggers individual approved updates, the merchant remains responsible for reviewing product SKUs, GTINs, and titles prior to execution.
              </li>
            </ul>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-orange-600" />
              <span>3. Subscriptions, Free Audit Limits &amp; Billing</span>
            </h2>
            <p className="text-xs sm:text-sm text-stone-600">
              Free Audit workspaces enforce paywall restrictions on full diagnostic audit outputs until an active paid subscription is verified through Stripe. Recurring subscription fees, renewals, upgrades, and cancellations are managed via Stripe Checkout and the Stripe Customer Billing Portal according to the active workspace plan.
            </p>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600" />
              <span>4. Merchant Evidence &amp; Legal Completion Notice</span>
            </h2>
            <p className="text-xs sm:text-sm text-stone-600">
              Merchants represent that uploaded compliance certificates, GTIN records, and product claims are accurate and authorized. Limitation of liability, indemnification, dispute resolution, governing jurisdiction, refund policy, and operator entity identification (<code className="font-mono">[INSERT LEGAL ENTITY, REGISTERED ADDRESS &amp; SUPPORT EMAIL]</code>) must be inserted by qualified legal counsel before commercial acceptance.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
};
