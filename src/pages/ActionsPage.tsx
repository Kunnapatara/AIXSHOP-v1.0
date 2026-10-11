import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { ActionItem, ActionStatus } from '../types';
import { 
  CheckSquare, 
  Filter, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  RefreshCw, 
  FileText, 
  ExternalLink,
  ShieldCheck,
  ChevronRight,
  Info,
  Edit3
} from 'lucide-react';

export const ActionsPage: React.FC = () => {
  const { 
    actionItems, 
    approveAction, 
    dismissAction, 
    recheckAction, 
    viewProductDetail,
    navigateTo 
  } = useApp();

  const [statusFilter, setStatusFilter] = useState<'all' | ActionStatus>('all');
  const [selectedAction, setSelectedAction] = useState<ActionItem | null>(null);
  const [editedValue, setEditedValue] = useState<string>('');
  const [isEditingValue, setIsEditingValue] = useState<boolean>(false);

  const filteredActions = useMemo(() => {
    return actionItems.filter(act => {
      if (statusFilter !== 'all' && act.status !== statusFilter) return false;
      return true;
    });
  }, [actionItems, statusFilter]);

  const handleOpenActionModal = (action: ActionItem) => {
    setSelectedAction(action);
    setEditedValue(action.proposedChange.to);
    setIsEditingValue(false);
  };

  const handleConfirmApproval = () => {
    if (!selectedAction) return;
    approveAction(selectedAction.id);
    setSelectedAction(null);
  };

  const handleConfirmDismiss = () => {
    if (!selectedAction) return;
    dismissAction(selectedAction.id);
    setSelectedAction(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Merchant Action Center
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Prioritized catalog remediation queue. Human review mandatory for evidence-gated specifications.
          </p>
        </div>

        {/* Status Filters */}
        <div className="flex items-center bg-stone-100 p-1 rounded-lg">
          {(['all', 'pending_review', 'approved', 'dismissed'] as const).map(st => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                statusFilter === st 
                  ? 'bg-white text-stone-900 shadow-xs font-semibold' 
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              {st.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Review Workflow Guide Strip */}
      <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 text-xs text-stone-600 shadow-xs">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-orange-600 shrink-0" />
          <span className="font-bold text-stone-900 uppercase tracking-wider text-[11px]">
            Governance Workflow:
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-stone-700">
          <span>1. Review Evidence</span>
          <ChevronRight className="w-3 h-3 text-stone-400" />
          <span>2. Understand Finding</span>
          <ChevronRight className="w-3 h-3 text-stone-400" />
          <span>3. Review / Edit Correction</span>
          <ChevronRight className="w-3 h-3 text-stone-400" />
          <span>4. Human Approval</span>
          <ChevronRight className="w-3 h-3 text-stone-400" />
          <span>5. Re-check Validation</span>
        </div>
      </div>

      {/* Actions Queue */}
      {filteredActions.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center shadow-xs">
          <CheckSquare className="w-12 h-12 text-stone-300 mx-auto mb-3" />
          <h3 className="text-base font-bold text-stone-900">No actions in this queue</h3>
          <p className="text-xs text-stone-500 mt-1">
            All items matching this filter have been addressed.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredActions.map(action => {
            const severityClass = {
              critical: 'text-rose-700 bg-rose-50 border-rose-200',
              high: 'text-amber-700 bg-amber-50 border-amber-200',
              medium: 'text-stone-700 bg-stone-100 border-stone-200',
              low: 'text-stone-600 bg-stone-50 border-stone-200',
            }[action.severity];

            const statusClass = {
              pending_review: 'text-amber-800 bg-amber-50 border-amber-200',
              approved: 'text-emerald-800 bg-emerald-50 border-emerald-200',
              applied_externally: 'text-blue-800 bg-blue-50 border-blue-200',
              dismissed: 'text-stone-600 bg-stone-100 border-stone-200',
            }[action.status];

            return (
              <div
                key={action.id}
                className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 shadow-xs hover:border-stone-300 transition-all space-y-4"
              >
                {/* Header row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-stone-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[11px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${severityClass}`}>
                      {action.severity}
                    </span>
                    <span className={`text-[11px] font-mono font-medium capitalize px-2 py-0.5 rounded border ${statusClass}`}>
                      {action.status.replace('_', ' ')}
                    </span>
                    {action.evidenceRequired && (
                      <span className="text-[11px] text-stone-500 font-mono flex items-center gap-1">
                        <FileText className="w-3 h-3 text-stone-400" />
                        <span>Evidence Gated</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {action.productId && (
                      <button
                        onClick={() => viewProductDetail(action.productId!, 'actions')}
                        className="text-xs text-stone-600 hover:text-stone-900 font-medium underline flex items-center gap-1"
                      >
                        <span>{action.productTitle?.substring(0, 32)}...</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Title & Field Change */}
                <div>
                  <h2 className="text-base font-bold text-stone-950">
                    {action.title}
                  </h2>
                  <div className="mt-2 p-3 bg-stone-50 rounded-xl border border-stone-200/80 font-mono text-xs flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-stone-500">{action.proposedChange.field}:</span>
                    <span className="text-rose-600 line-through">{action.proposedChange.from}</span>
                    <span className="text-stone-400">→</span>
                    <span className="text-emerald-700 font-semibold">{action.proposedChange.to}</span>
                  </div>
                </div>

                {/* Re-check Verification Status */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-stone-500">Verification State:</span>
                    <span className={`font-mono font-semibold ${
                      action.verificationStatus === 'verified_in_catalog' 
                        ? 'text-emerald-700' 
                        : action.verificationStatus === 'recheck_required'
                        ? 'text-amber-700'
                        : 'text-stone-500'
                    }`}>
                      {action.verificationStatus.replace(/_/g, ' ')}
                    </span>
                    {action.recheckNotes && (
                      <span className="text-stone-400 font-mono text-[11px]">
                        ({action.recheckNotes.substring(0, 50)}...)
                      </span>
                    )}
                  </div>

                  {/* Re-check Button */}
                  <button
                    onClick={() => recheckAction(action.id)}
                    className="px-2.5 py-1 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded flex items-center gap-1 transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Run Re-check</span>
                  </button>
                </div>

                {/* Action Buttons */}
                <div className="pt-3 border-t border-stone-100 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] text-stone-400 font-mono">
                    ID: {action.id} · Finding: {action.findingId}
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleOpenActionModal(action)}
                      className="px-3.5 py-2 text-xs font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors min-h-[38px]"
                    >
                      Inspect Evidence & Edit
                    </button>

                    {action.status === 'pending_review' && (
                      <>
                        <button
                          onClick={() => dismissAction(action.id)}
                          className="px-3 py-2 text-xs font-medium text-stone-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors min-h-[38px]"
                        >
                          Dismiss
                        </button>
                        <button
                          onClick={() => approveAction(action.id)}
                          className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-xs transition-colors min-h-[38px]"
                        >
                          Approve Remediation
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action Inspection & Approval Modal */}
      {selectedAction && (
        <div 
          className="fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setSelectedAction(null)}
        >
          <div 
            className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-xl border border-stone-200 space-y-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between pb-3 border-b border-stone-100">
              <div>
                <span className="text-[11px] font-mono text-stone-400 uppercase">
                  Action Inspection #{selectedAction.id}
                </span>
                <h3 className="text-base font-bold text-stone-950 mt-0.5">
                  {selectedAction.title}
                </h3>
              </div>
              <span className="text-xs font-mono font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                {selectedAction.severity}
              </span>
            </div>

            {/* Evidence Block */}
            <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 text-xs space-y-1.5">
              <p className="font-semibold text-stone-900 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-stone-500" />
                <span>Source Evidence & Provenance</span>
              </p>
              <p className="text-stone-700 font-mono">
                {selectedAction.evidenceProvided || 'Self-consistent catalog attribute alignment.'}
              </p>
            </div>

            {/* Proposed Change with Edit Capability */}
            <div className="space-y-2 text-xs">
              <label className="font-semibold text-stone-900 block">
                Proposed Value for <code className="font-mono text-stone-700">{selectedAction.proposedChange.field}</code>:
              </label>
              <input
                type="text"
                value={editedValue}
                onChange={e => setEditedValue(e.target.value)}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg font-mono text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <p className="text-[11px] text-stone-500">
                You can adjust the recommended value before granting merchant approval.
              </p>
            </div>

            {/* Explicit Write-Back Disclaimer */}
            <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800">
              <p className="font-bold">Live Storefront Boundary Notice:</p>
              <p className="mt-0.5">
                Approval records this remediation inside AIXSHOP. Live write-back to Shopify or external feeds requires authorized write-back permissions in Store / Settings.
              </p>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-between pt-3 border-t border-stone-100">
              <button
                onClick={() => setSelectedAction(null)}
                className="px-3.5 py-2 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-lg"
              >
                Close
              </button>

              <div className="flex items-center gap-2">
                {selectedAction.status === 'pending_review' && (
                  <button
                    onClick={handleConfirmDismiss}
                    className="px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 rounded-lg"
                  >
                    Dismiss Finding
                  </button>
                )}
                <button
                  onClick={handleConfirmApproval}
                  className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-xs"
                >
                  Approve & Record Verification
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
