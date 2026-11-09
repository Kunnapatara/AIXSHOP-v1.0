import { 
  Finding, 
  EvidenceDocument, 
  Product, 
  Variant, 
  FindingSeverity, 
  FindingScope, 
  FindingType 
} from '../../types';
import { AuditRunRecord, AuditRunStatus } from '../storage/storageTypes';

export interface HistoricalFindingRecord {
  id: string;
  auditRunId: string;
  workspaceId: string;
  originalFindingId: string;
  scope: FindingScope;
  productId?: string | null;
  productTitle?: string | null;
  findingType: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  observedEvidence: string;
  derivedConclusion: string;
  merchantVerified: boolean;
  whyItMatters: string;
  suggestedCorrection?: string | null;
  targetField?: string | null;
  currentValue?: string | null;
  recommendedValue?: string | null;
  actionItemId?: string | null;
  ruleCode?: string | null;
  snapshotCreatedAt: string;
}

export interface HistoricalEvidenceRecord {
  id: string;
  auditRunId: string;
  workspaceId: string;
  originalEvidenceId: string;
  productId?: string | null;
  title: string;
  evidenceType: string;
  issuer: string;
  dateVerified: string;
  url?: string | null;
  status: 'verified' | 'unverified' | 'expired';
  sourceType: string;
  metadata: Record<string, any>;
  snapshotCreatedAt: string;
}

export interface HistoricalProductRecord {
  id: string;
  auditRunId: string;
  workspaceId: string;
  productId: string;
  title: string;
  brand: string;
  category: string;
  description: string;
  image: string;
  completenessScore: number;
  attributes: Record<string, any>;
  variants: Variant[];
  offers: any[];
  findingsCount: number;
  snapshotCreatedAt: string;
}

export interface HistoricalAuditSnapshot {
  auditRun: AuditRunRecord;
  findings: HistoricalFindingRecord[];
  evidence: HistoricalEvidenceRecord[];
  products: HistoricalProductRecord[];
  snapshotAvailable: boolean;
  message?: string;
}

export interface AuditHistoryItem {
  id: string;
  workspaceId: string;
  status: AuditRunStatus;
  productsEvaluated: number;
  rulesEvaluated: number;
  findingsCount: number;
  summary: Record<string, any>;
  metadata: Record<string, any>;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  snapshotAvailable: boolean;
}

export interface AuditHistoryResponse {
  success: boolean;
  items: AuditHistoryItem[];
  nextCursor: string | null;
  totalCount?: number;
}

export type ComparisonFindingStatus = 'PERSISTENT' | 'RESOLVED' | 'NEW' | 'UNMATCHED';

export interface FindingComparisonItem {
  key: string;
  status: ComparisonFindingStatus;
  findingTitle: string;
  severityChange?: {
    from: FindingSeverity;
    to: FindingSeverity;
  } | null;
  observedValueChange?: {
    from: string;
    to: string;
  } | null;
  baseFinding?: HistoricalFindingRecord;
  targetFinding?: HistoricalFindingRecord;
  ruleCode?: string;
  productId?: string;
  targetField?: string;
}

export interface AuditComparisonResult {
  baseAuditId: string;
  targetAuditId: string;
  baseRun: AuditRunRecord;
  targetRun: AuditRunRecord;
  summaryChanges: {
    productsEvaluatedDiff: number;
    rulesEvaluatedDiff: number;
    findingsCountDiff: number;
    completenessAvgDiff: number;
  };
  comparisonItems: FindingComparisonItem[];
  persistentCount: number;
  resolvedCount: number;
  newCount: number;
  unmatchedCount: number;
}
