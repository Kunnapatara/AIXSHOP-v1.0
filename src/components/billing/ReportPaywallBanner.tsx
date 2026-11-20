import React from 'react';
import { Lock, ArrowRight } from 'lucide-react';
import { PreliminaryAuditSummary, ReportEntitlement } from '../../api/client';

interface ReportPaywallBannerProps {
  entitlement: ReportEntitlement;
  preliminarySummary?: PreliminaryAuditSummary | null;
  contextLabel?: string;
  onUpgrade: () => void;
}

export const ReportPaywallBanner: React.FC<ReportPaywallBannerProps> = ({
  entitlement,
  contextLabel = 'Audit execution, full findings, evidence trails, remediation actions, and feed exports require an active paid plan.',
  onUpgrade,
}) => {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 shadow-xs space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-100 border border-amber-200 flex items-center justify-center text-amber-800 shrink-0 mt-0.5">
            <Lock className="w-4 h-4" />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-amber-950">
                Paid Plan Required — Audit &amp; Reports Locked
              </h3>
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-white border border-amber-200 text-amber-900">
                {entitlement.activeTier} ({entitlement.subscriptionStatus})
              </span>
            </div>
            <p className="text-xs text-amber-900 leading-relaxed">
              {entitlement.reasonMessage || contextLabel}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onUpgrade}
          className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
        >
          <span>Upgrade Plan to Unlock</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
