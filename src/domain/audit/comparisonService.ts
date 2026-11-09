import { HistoricalFindingRecord, AuditComparisonResult, FindingComparisonItem } from './historicalTypes';
import { AuditRunRecord } from '../storage/storageTypes';

export function compareHistoricalAudits(
  baseRun: AuditRunRecord,
  baseFindings: HistoricalFindingRecord[],
  targetRun: AuditRunRecord,
  targetFindings: HistoricalFindingRecord[]
): AuditComparisonResult {
  // Build lookup maps for base and target findings
  // Stable key: ruleCode + scope + (productId || 'catalog') + (targetField || '')
  const makeKey = (f: HistoricalFindingRecord) => {
    return `${f.ruleCode || 'UNKNOWN_RULE'}::${f.scope}::${f.productId || 'store'}::${f.targetField || 'default'}`;
  };

  const baseMap = new Map<string, HistoricalFindingRecord>();
  for (const f of baseFindings) {
    const key = makeKey(f);
    baseMap.set(key, f);
  }

  const targetMap = new Map<string, HistoricalFindingRecord>();
  for (const f of targetFindings) {
    const key = makeKey(f);
    targetMap.set(key, f);
  }

  const comparisonItems: FindingComparisonItem[] = [];
  const processedKeys = new Set<string>();

  let persistentCount = 0;
  let resolvedCount = 0;
  let newCount = 0;
  let unmatchedCount = 0;

  // Rules evaluated in target run
  const targetRulesEvaluated = new Set<string>(
    targetRun.metadata?.rules || Object.keys(targetRun.summary?.ruleBreakdown || {})
  );

  // 1. Process base findings
  for (const [key, baseF] of baseMap.entries()) {
    processedKeys.add(key);
    const targetF = targetMap.get(key);

    if (targetF) {
      // Finding is persistent across both runs
      persistentCount++;
      const severityChanged = baseF.severity !== targetF.severity;
      const valueChanged = (baseF.currentValue || '') !== (targetF.currentValue || '');

      comparisonItems.push({
        key,
        status: 'PERSISTENT',
        findingTitle: targetF.title,
        ruleCode: targetF.ruleCode || baseF.ruleCode || undefined,
        productId: targetF.productId || baseF.productId || undefined,
        targetField: targetF.targetField || baseF.targetField || undefined,
        severityChange: severityChanged ? { from: baseF.severity, to: targetF.severity } : null,
        observedValueChange: valueChanged ? { from: baseF.currentValue || '', to: targetF.currentValue || '' } : null,
        baseFinding: baseF,
        targetFinding: targetF,
      });
    } else {
      // Finding was in base, but NOT in target run.
      // Criterion: "Do not claim that an issue is resolved solely because a finding is absent from a later snapshot unless the later audit actually evaluated the relevant rule and product."
      const ruleWasEvaluated = baseF.ruleCode ? targetRulesEvaluated.has(baseF.ruleCode) : false;

      if (ruleWasEvaluated) {
        resolvedCount++;
        comparisonItems.push({
          key,
          status: 'RESOLVED',
          findingTitle: baseF.title,
          ruleCode: baseF.ruleCode || undefined,
          productId: baseF.productId || undefined,
          targetField: baseF.targetField || undefined,
          baseFinding: baseF,
        });
      } else {
        unmatchedCount++;
        comparisonItems.push({
          key,
          status: 'UNMATCHED',
          findingTitle: baseF.title,
          ruleCode: baseF.ruleCode || undefined,
          productId: baseF.productId || undefined,
          targetField: baseF.targetField || undefined,
          baseFinding: baseF,
        });
      }
    }
  }

  // 2. Process findings that are newly identified in target run
  for (const [key, targetF] of targetMap.entries()) {
    if (!processedKeys.has(key)) {
      newCount++;
      comparisonItems.push({
        key,
        status: 'NEW',
        findingTitle: targetF.title,
        ruleCode: targetF.ruleCode || undefined,
        productId: targetF.productId || undefined,
        targetField: targetF.targetField || undefined,
        targetFinding: targetF,
      });
    }
  }

  const baseSummary = baseRun.summary || {};
  const targetSummary = targetRun.summary || {};

  return {
    baseAuditId: baseRun.id,
    targetAuditId: targetRun.id,
    baseRun,
    targetRun,
    summaryChanges: {
      productsEvaluatedDiff: (targetRun.productsEvaluated || 0) - (baseRun.productsEvaluated || 0),
      rulesEvaluatedDiff: (targetRun.rulesEvaluated || 0) - (baseRun.rulesEvaluated || 0),
      findingsCountDiff: (targetRun.findingsCount || 0) - (baseRun.findingsCount || 0),
      completenessAvgDiff: (targetSummary.catalogCompletenessAvg || 0) - (baseSummary.catalogCompletenessAvg || 0),
    },
    comparisonItems,
    persistentCount,
    resolvedCount,
    newCount,
    unmatchedCount,
  };
}
