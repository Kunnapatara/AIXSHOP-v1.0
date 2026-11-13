import { StoragePayloadV1 } from '../domain/storage/storageTypes';
import { StoreProfile, ActionItem, Product, CatalogImportResult, ProductCandidate } from '../types';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

export interface AuthSessionResponse {
  user: AuthUser;
  workspace: WorkspaceSummary;
  workspaces?: WorkspaceSummary[];
  token?: string;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(path, {
      ...options,
      headers,
      credentials: 'include', // sends HTTP-only session cookie
    });

    if (!res.ok) {
      let errMsg = `Request failed with status ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) errMsg = body.error;
      } catch {
        // use default status message
      }
      const error: any = new Error(errMsg);
      error.status = res.status;
      throw error;
    }

    return res.json();
  }

  // Auth Endpoints
  async register(params: { email: string; password: string; fullName: string; workspaceName: string }): Promise<AuthSessionResponse> {
    const data = await this.request<AuthSessionResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (data.token) this.setToken(data.token);
    return data;
  }

  async login(params: { email: string; password: string }): Promise<AuthSessionResponse> {
    const data = await this.request<AuthSessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (data.token) this.setToken(data.token);
    return data;
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST' });
    this.setToken(null);
  }

  async getSession(): Promise<AuthSessionResponse | null> {
    try {
      return await this.request<AuthSessionResponse>('/api/auth/me');
    } catch (err: any) {
      if (err.status === 401 || err.status === 403) {
        return null;
      }
      throw err;
    }
  }

  async switchWorkspace(workspaceId: string): Promise<{ success: boolean; workspace: WorkspaceSummary }> {
    return this.request<{ success: boolean; workspace: WorkspaceSummary }>('/api/auth/switch-workspace', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    });
  }

  // Catalog Endpoints
  async getCatalog(): Promise<{ workspaceId: string; catalog: StoragePayloadV1 }> {
    return this.request<{ workspaceId: string; catalog: StoragePayloadV1 }>('/api/catalog');
  }

  async saveCatalog(payload: StoragePayloadV1): Promise<{ success: boolean; skuCount: number; timestamp: string }> {
    return this.request<{ success: boolean; skuCount: number; timestamp: string }>('/api/catalog', {
      method: 'PUT',
      body: JSON.stringify({ payload }),
    });
  }

  async approveAction(actionId: string, customApprovedValue?: string): Promise<{ success: boolean; action: ActionItem; product?: Product }> {
    return this.request<{ success: boolean; action: ActionItem; product?: Product }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ customApprovedValue }),
    });
  }

  async dismissAction(actionId: string): Promise<{ success: boolean; action: ActionItem }> {
    return this.request<{ success: boolean; action: ActionItem }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/dismiss`, {
      method: 'POST',
    });
  }

  async recheckAction(actionId: string): Promise<{ success: boolean; action: ActionItem }> {
    return this.request<{ success: boolean; action: ActionItem }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/recheck`, {
      method: 'POST',
    });
  }

  async importCatalog(candidates: ProductCandidate[]): Promise<{ success: boolean; result: CatalogImportResult }> {
    return this.request<{ success: boolean; result: CatalogImportResult }>('/api/catalog/import', {
      method: 'POST',
      body: JSON.stringify({ candidates }),
    });
  }

  async migrateDemoData(): Promise<{ success: boolean; message: string; skuCount: number }> {
    return this.request<{ success: boolean; message: string; skuCount: number }>('/api/catalog/migrate-demo', {
      method: 'POST',
    });
  }

  // Store Endpoints
  async getStoreProfile(): Promise<StoreProfile> {
    return this.request<StoreProfile>('/api/store/profile');
  }

  async updateStoreProfile(updates: Partial<StoreProfile>): Promise<{ success: boolean; store: StoreProfile }> {
    return this.request<{ success: boolean; store: StoreProfile }>('/api/store/profile', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async toggleConnector(connectorId: string): Promise<{ success: boolean; store: StoreProfile }> {
    return this.request<{ success: boolean; store: StoreProfile }>(`/api/store/connectors/${encodeURIComponent(connectorId)}/toggle`, {
      method: 'POST',
    });
  }

  // Audit Endpoints
  async runAudit(): Promise<{ success: boolean; auditRun: any; catalog: StoragePayloadV1 }> {
    return this.request<{ success: boolean; auditRun: any; catalog: StoragePayloadV1 }>('/api/audit/run', {
      method: 'POST',
    });
  }

  async getLatestAuditRun(): Promise<{ workspaceId: string; auditRun: any | null }> {
    return this.request<{ workspaceId: string; auditRun: any | null }>('/api/audit/latest');
  }

  async getAuditHistory(options?: { limit?: number; cursor?: string }): Promise<import('../domain/audit/historicalTypes').AuditHistoryResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<import('../domain/audit/historicalTypes').AuditHistoryResponse>(`/api/audit/history${query}`);
  }

  async getAuditRun(id: string): Promise<import('../domain/audit/historicalTypes').HistoricalAuditSnapshot> {
    return this.request<import('../domain/audit/historicalTypes').HistoricalAuditSnapshot>(`/api/audit/${encodeURIComponent(id)}`);
  }

  async compareAudits(baseId: string, targetId: string): Promise<{ success: boolean; comparison: import('../domain/audit/historicalTypes').AuditComparisonResult }> {
    const params = new URLSearchParams({ baseId, targetId });
    return this.request<{ success: boolean; comparison: import('../domain/audit/historicalTypes').AuditComparisonResult }>(`/api/audit/compare?${params.toString()}`);
  }

  // Shopify Endpoints
  async getShopifyStatus(options?: { verify?: 'live' }): Promise<ShopifyStatusResponse> {
    const query = options?.verify === 'live' ? '?verify=live' : '';
    return this.request<ShopifyStatusResponse>(`/api/shopify/status${query}`);
  }

  async syncShopify(options?: { maxPages?: number; pageSize?: number; resumeCursor?: string }): Promise<{
    success: boolean;
    syncRun: any;
    productsDiscovered: number;
    productsImported: number;
    variantsImported: number;
    excludedByPlan: number;
    status: string;
    message: string;
  }> {
    return this.request('/api/shopify/sync', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  }

  async resumeShopifySync(options?: { syncRunId?: string; maxPages?: number; pageSize?: number }): Promise<{
    success: boolean;
    syncRun: any;
    productsDiscovered: number;
    productsImported: number;
    variantsImported: number;
    excludedByPlan: number;
    status: string;
    message: string;
  }> {
    return this.request('/api/shopify/sync/resume', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  }

  async registerShopifyWebhooks(): Promise<{ success: boolean; results: any[]; activeWebhooks: string[] }> {
    return this.request('/api/shopify/webhooks/register', {
      method: 'POST',
    });
  }

  async verifyShopifyWebhooks(): Promise<{
    success: boolean;
    verified: boolean;
    status: string;
    requiredTopics: string[];
    activeTopics: string[];
    missingTopics: string[];
    liveSubscriptions: any[];
    verifiedAt: string;
    message: string;
  }> {
    return this.request('/api/shopify/webhooks/verify', {
      method: 'POST',
    });
  }

  async disconnectShopify(): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/api/shopify/disconnect', {
      method: 'POST',
    });
  }

  async getShopifySyncRuns(limit: number = 10): Promise<{ success: boolean; syncRuns: any[] }> {
    return this.request<{ success: boolean; syncRuns: any[] }>(`/api/shopify/sync/runs?limit=${limit}`);
  }

  // AI Discovery Endpoints
  async getDiscoveryAudit(): Promise<{
    success: boolean;
    readiness: any;
    hubChecklist: any;
    productCount: number;
    storeDomain: string;
  }> {
    return this.request('/api/discovery/audit');
  }

  // Business Profile Endpoints
  async getBusinessProfile(): Promise<{ success: boolean; profile: any }> {
    return this.request('/api/business-profile');
  }

  async updateBusinessProfile(profile: any): Promise<{ success: boolean; profile: any }> {
    return this.request('/api/business-profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  // Feed Readiness Endpoints
  async validateFeed(platform: string): Promise<{ success: boolean; report: any }> {
    return this.request('/api/feed/validate', {
      method: 'POST',
      body: JSON.stringify({ platform }),
    });
  }

  getFeedExportUrl(platform: string, format: string = 'csv', filter: string = 'all'): string {
    return `/api/feed/export?platform=${encodeURIComponent(platform)}&format=${encodeURIComponent(format)}&filter=${encodeURIComponent(filter)}`;
  }

  // Visibility Monitoring Endpoints
  async getVisibilitySummary(): Promise<{ success: boolean; summary: any }> {
    return this.request('/api/visibility/summary');
  }

  async uploadVisibilityCsv(csvContent: string, filename: string): Promise<{ success: boolean; import: any; summary: any }> {
    return this.request('/api/visibility/upload', {
      method: 'POST',
      body: JSON.stringify({ csvContent, filename }),
    });
  }
}

export interface ShopifyStatusResponse {
  configured?: boolean;
  connected: boolean;
  status: 'connected' | 'disconnected' | 'revoked' | 'error' | 'not_connected' | 'not_configured' | 'reauth_required' | 'reauthorization_required';
  shopDomain: string | null;
  grantedScopes: string[];
  installedAt: string | null;
  lastVerifiedAt: string | null;
  canResumeSync?: boolean;
  webhookStatus?: 'active' | 'not_configured' | 'pending' | 'inactive' | 'partially_registered' | 'registered_unverified' | 'unverified' | 'mismatch' | 'verification_incomplete' | 'verification_unavailable' | 'verification_failed' | 'error';
  activeWebhooks?: string[];
  webhookDetails?: {
    verificationMode: 'live' | 'cached';
    isLiveVerified: boolean;
    requiredTopics: string[];
    verifiedTopics: string[];
    missingTopics: string[];
    mismatchedSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string; expectedUrl: string }>;
    webhookLastVerifiedAt: string | null;
    lastVerifiedAt: string | null;
    isFresh: boolean;
    completenessStatus?: string;
    error?: string;
  };
  latestSync?: {
    id?: string;
    status: string;
    completedAt?: string | null;
    productsDiscovered: number;
    productsImported: number;
    variantsImported: number;
    excludedByPlan: number;
    cursorResumed?: string | null;
    errorMessage?: string | null;
  } | null;
  lastSync?: {
    status: string;
    completedAt: string | null;
    productsDiscovered: number;
    productsImported: number;
    variantsImported: number;
    excludedByPlan: number;
    error: string | null;
  } | null;
  entitlement?: {
    tier: string;
    skuLimit: number;
    currentUsage: number;
    remainingQuota: number;
    isUnlimited: boolean;
  };
  webhooks?: {
    subscribedTopics: string[];
    processedCount: number;
  };
}

export const apiClient = new ApiClient();
