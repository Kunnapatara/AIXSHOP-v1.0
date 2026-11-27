import React from 'react';
import { ArrowLeft, ShieldAlert, Lock, Database, FileText, Globe } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const PrivacyPolicyPage: React.FC = () => {
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
              onClick={() => navigateTo('terms')}
              className="px-3 py-1.5 text-xs font-medium text-stone-600 hover:text-stone-950 rounded-lg hover:bg-stone-100"
            >
              Terms of Service (Draft)
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
              This Privacy Policy is an engineering template draft prepared for review by qualified legal counsel prior to commercial launch. Publishing this draft does not constitute legal advice and does not guarantee compliance with GDPR, CCPA/CPRA, PDPA, Stripe requirements, Shopify Partner Program requirements, or any other regulatory framework.
            </p>
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-2xl p-6 sm:p-8 space-y-6 shadow-xs">
          <div className="border-b border-stone-200 pb-5 space-y-2">
            <span className="text-xs font-mono font-semibold uppercase tracking-wider text-orange-700 bg-orange-50 px-2.5 py-1 rounded">
              Draft Privacy Policy · AIXSHOP v1.0
            </span>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-950 pt-1">
              Privacy Policy (Draft Template)
            </h1>
            <p className="text-xs text-stone-500 font-mono">
              Status: Unreviewed Draft · Operator Legal Entity &amp; Contact Email Must Be Inserted Before Launch
            </p>
          </div>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <Database className="w-4 h-4 text-orange-600" />
              <span>1. Information Processed by the Platform</span>
            </h2>
            <p>
              When merchants register an AIXSHOP workspace or connect an online store, the platform processes only data required to operate catalog health auditing, tenant authentication, and subscription billing:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-xs sm:text-sm text-stone-600">
              <li>
                <strong>Account &amp; Workspace Data:</strong> Name, business email address, password hash (scrypt salted hash), workspace name, and membership role.
              </li>
              <li>
                <strong>Session Credentials:</strong> HttpOnly cookie tokens hashed with SHA-256 on the server and tracked in database-backed session tables.
              </li>
              <li>
                <strong>Catalog &amp; Store Metadata:</strong> Public storefront URLs, product titles, variants, SKUs, barcodes/GTINs, compliance evidence metadata, and encrypted Shopify OAuth tokens (AES-256-GCM at rest when Shopify OAuth is connected).
              </li>
              <li>
                <strong>Subscription &amp; Billing Records:</strong> Subscription tier, Stripe customer/subscription identifiers, and billing notification delivery logs. Raw payment card numbers are handled by Stripe and are not stored by AIXSHOP.
              </li>
            </ul>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <Lock className="w-4 h-4 text-orange-600" />
              <span>2. Tenant Isolation &amp; Security Controls</span>
            </h2>
            <p className="text-xs sm:text-sm text-stone-600">
              Catalog records, audit findings, Shopify connections, and billing records are partitioned by workspace identifier. Administrative operational logs redact sensitive credentials, tokens, and personal identifiers before emission.
            </p>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <Globe className="w-4 h-4 text-orange-600" />
              <span>3. Third-Party Subprocessors (Subject to Final Verification)</span>
            </h2>
            <ul className="list-disc pl-5 space-y-1 text-xs sm:text-sm text-stone-600">
              <li>
                <strong>Managed PostgreSQL Hosting:</strong> Stores workspace records, catalogs, audit history, and encrypted store tokens.
              </li>
              <li>
                <strong>Stripe:</strong> Processes subscription checkout, billing portal management, and webhook payment events.
              </li>
              <li>
                <strong>Shopify Admin API:</strong> Synchronizes merchant-authorized product catalog fields when OAuth is connected.
              </li>
              <li>
                <strong>SMTP Transactional Mail Provider:</strong> Delivers password recovery and billing lifecycle notifications.
              </li>
            </ul>
          </section>

          <section className="space-y-2.5 text-sm text-stone-700 leading-relaxed">
            <h2 className="text-base font-bold text-stone-950 flex items-center gap-2">
              <FileText className="w-4 h-4 text-orange-600" />
              <span>4. Data Retention, Deletion &amp; Contact Placeholder</span>
            </h2>
            <p className="text-xs sm:text-sm text-stone-600">
              Authenticated merchants may delete their account and solely owned workspaces from Settings. Specific retention periods, Data Processing Addendum (DPA) terms, GDPR/CCPA rights workflows, and verified privacy contact details (<code className="font-mono">[INSERT LEGAL ENTITY &amp; PRIVACY CONTACT EMAIL]</code>) must be finalized by legal counsel prior to production launch.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
};
