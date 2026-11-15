export type TopicPresenceState = 'specified' | 'explicit_blank' | 'unspecified' | 'legacy_ambiguous';

export type VisibilityConflictPolicy = 'reject_on_conflict' | 'replace_versioned';

export interface VisibilityMetricRecord {
  id: string;
  workspaceId: string;
  importId?: string | null;
  observationDate: string; // YYYY-MM-DD
  platform: string;
  brandMentions: number;
  productMentions: number;
  websiteClicks: number;
  discoveryTopic?: string | null;
  topicPresence?: TopicPresenceState;
  evidenceSource?: string | null;
  createdAt: string;
}

export interface VisibilityObservationHistoryRecord {
  id: string;
  workspaceId: string;
  importId: string;
  observationDate: string;
  platform: string;
  discoveryTopic?: string | null;
  topicPresence: TopicPresenceState;
  brandMentions: number;
  productMentions: number;
  websiteClicks: number;
  evidenceSource?: string | null;
  eventType: 'recorded' | 'superseded' | 'replaced';
  versionNumber: number;
  supersedesHistoryId?: string | null;
  createdAt: string;
}

export interface VisibilityObservationConflict {
  observationDate: string;
  platform: string;
  discoveryTopic: string | null;
  topicPresence: TopicPresenceState;
  existingImportId: string | null;
  existingValues: {
    brandMentions: number;
    productMentions: number;
    websiteClicks: number;
  };
  incomingValues: {
    brandMentions: number;
    productMentions: number;
    websiteClicks: number;
  };
}

export class VisibilityObservationConflictError extends Error {
  public readonly code = 'VISIBILITY_OBSERVATION_CONFLICT';
  public readonly statusCode = 409;
  public readonly conflicts: VisibilityObservationConflict[];

  constructor(conflicts: VisibilityObservationConflict[], message?: string) {
    super(
      message ||
        `Visibility import conflicts with ${conflicts.length} existing observation(s). Pass conflictPolicy="replace_versioned" for explicit versioned replacement instead of overwriting historical measurements.`
    );
    this.name = 'VisibilityObservationConflictError';
    this.conflicts = conflicts;
  }
}

export interface VisibilityImportRowError {
  rowNumber: number;
  field?: string;
  value?: string;
  reason: string;
  raw?: string;
}

export interface VisibilityImportRecord {
  id: string;
  workspaceId: string;
  filename: string;
  contentHash?: string | null;
  rowCount: number;
  rejectedRowCount?: number;
  status?: 'completed' | 'partial' | 'failed';
  errors?: VisibilityImportRowError[];
  reportingPeriodStart?: string | null;
  reportingPeriodEnd?: string | null;
  sourcePlatform: string;
  createdAt: string;
}

export interface VisibilitySummary {
  connected: boolean;
  status: 'CONNECTED' | 'DATA_SOURCE_NOT_CONNECTED';
  message: string;
  totalBrandMentions: number;
  totalProductMentions: number;
  totalWebsiteClicks: number;
  platforms: Array<{ platform: string; mentions: number; clicks: number }>;
  recentObservations: VisibilityMetricRecord[];
  imports: VisibilityImportRecord[];
}
