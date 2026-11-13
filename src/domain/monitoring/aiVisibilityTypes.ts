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
  evidenceSource?: string | null;
  createdAt: string;
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
