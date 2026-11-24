import { StoragePayloadV1 } from '../domain/storage/storageTypes';
import { StoreProfile, ActionItem, Product, CatalogImportResult, ProductCandidate } from '../types';
import {
  isValidBillingRedirectUrl,
  isValidShopifyAuthUrl,
  validateAndNormalizeShopDomain,
} from '../domain/validation/shopify';

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
}

export type ReportAccessReasonCode =
  | 'ACTIVE_PAID_SUBSCRIPTION'
  | 'TRIALING_PAID_SUBSCRIPTION'
  | 'FREE_AUDIT_PRELIMINARY_ONLY'
  | 'SUBSCRIPTION_PAST_DUE'
  | 'SUBSCRIPTION_CANCELED'
  | 'SUBSCRIPTION_UNPAID'
  | 'SUBSCRIPTION_INCOMPLETE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'STORE_PROFILE_UNAVAILABLE';

export interface ReportEntitlement {
  hasFullReportAccess: boolean;
  accessLevel: 'full' | 'preliminary';
  activeTier: string;
  subscriptionStatus: string;
  reasonCode: ReportAccessReasonCode;
  reasonMessage: string;
  upgradeRequired: boolean;
}

export interface PreliminaryAuditSummary {
  totalFindingsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  actionsCount: number;
  recommendedTier: 'Starter' | 'Growth' | 'Enterprise';
  skuCount: number;
  note: string;
}

export interface CommercialPlanSummaryItem {
  tier: string;
  priceCents: number;
  billingInterval: 'month' | 'year' | 'none';
  skuLimit: number | null;
  isUnlimited: boolean;
  quotaSemantics: 'preliminary_evaluation_capacity' | 'verified_monthly_catalog_skus';
  reportAccess: 'preliminary_only' | 'full_report_and_remediation';
  explanation: string;
}

class ApiClient {
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers as Record<string, string> || {}),
    };

    const res = await fetch(path, {
      ...options,
      headers,
      credentials: 'include', // sends HTTP-only session cookie
    });

    if (!res.ok) {
      let errMsg = `Request failed with status ${res.status}`;
      let body: any = null;
      try {
        body = await res.json();
        if (body?.error) errMsg = body.error;
      } catch {
        // use default status message
      }
      const error: any = new Error(errMsg);
      error.status = res.status;
      if (body && typeof body === 'object') {
        if (body.code !== undefined) error.code = body.code;
        if (body.currentVersion !== undefined) error.currentVersion = body.currentVersion;
        if (body.expectedVersion !== undefined) error.expectedVersion = body.expectedVersion;
        if (body.conflicts !== undefined) error.conflicts = body.conflicts;
        if (body.reportEntitlement !== undefined) error.reportEntitlement = body.reportEntitlement;
        if (body.preliminarySummary !== undefined) error.preliminarySummary = body.preliminarySummary;
      }
      throw error;
    }

    try {
      return await res.json();
    } catch {
      throw new Error('Invalid JSON response received from server');
    }
  }

  // Auth Endpoints (cookie-only browser sessions)
  async register(params: { email: string; password: string; fullName: string; workspaceName: string }): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async login(params: { email: string; password: string }): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST' });
  }

  async forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    });
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
  async getCatalog(): Promise<{
    workspaceId: string;
    catalog: StoragePayloadV1;
    reportEntitlement?: ReportEntitlement;
    preliminarySummary?: PreliminaryAuditSummary;
  }> {
    return this.request('/api/catalog');
  }

  async saveCatalog(
    payload: StoragePayloadV1,
    expectedVersion?: number
  ): Promise<{ success: boolean; skuCount: number; catalogVersion?: number; timestamp: string }> {
    const resolvedExpected = expectedVersion !== undefined ? expectedVersion : payload.catalogVersion;
    return this.request<{ success: boolean; skuCount: number; catalogVersion?: number; timestamp: string }>('/api/catalog', {
      method: 'PUT',
      body: JSON.stringify(
        resolvedExpected !== undefined ? { payload, expectedVersion: resolvedExpected } : { payload }
      ),
    });
  }

  async approveAction(actionId: string, customApprovedValue?: string): Promise<{ success: boolean; action: ActionItem; product?: Product; catalogVersion?: number }> {
    return this.request<{ success: boolean; action: ActionItem; product?: Product; catalogVersion?: number }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ customApprovedValue }),
    });
  }

  async dismissAction(actionId: string): Promise<{ success: boolean; action: ActionItem; catalogVersion?: number }> {
    return this.request<{ success: boolean; action: ActionItem; catalogVersion?: number }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/dismiss`, {
      method: 'POST',
    });
  }

  async recheckAction(actionId: string): Promise<{ success: boolean; action: ActionItem; catalogVersion?: number }> {
    return this.request<{ success: boolean; action: ActionItem; catalogVersion?: number }>(`/api/catalog/actions/${encodeURIComponent(actionId)}/recheck`, {
      method: 'POST',
    });
  }

  async importCatalog(candidates: ProductCandidate[]): Promise<{ success: boolean; result: CatalogImportResult; catalogVersion?: number }> {
    return this.request<{ success: boolean; result: CatalogImportResult; catalogVersion?: number }>('/api/catalog/import', {
      method: 'POST',
      body: JSON.stringify({ candidates }),
    });
  }

  async migrateDemoData(
    expectedVersion?: number
  ): Promise<{ success: boolean; message: string; skuCount: number; catalogVersion?: number }> {
    return this.request<{ success: boolean; message: string; skuCount: number; catalogVersion?: number }>('/api/catalog/migrate-demo', {
      method: 'POST',
      body: JSON.stringify(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  }

  async authorizeGuestTransfer(params: {
    idempotencyKey?: string;
    conflictStrategy?: import('../domain/catalog/guestTransfer').GuestTransferConflictStrategy;
    payload: StoragePayloadV1;
  }): Promise<import('../domain/catalog/guestTransfer').GuestTransferAuthorizationResponse> {
    return this.request('/api/catalog/guest-transfer/authorize', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async commitGuestTransfer(params: {
    transferToken: string;
    idempotencyKey?: string;
    conflictStrategy?: import('../domain/catalog/guestTransfer').GuestTransferConflictStrategy;
    payload: StoragePayloadV1;
  }): Promise<import('../domain/catalog/guestTransfer').GuestTransferCommitResult> {
    return this.request('/api/catalog/guest-transfer/commit', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getGuestTransferStatus(
    idempotencyKey: string
  ): Promise<import('../domain/catalog/guestTransfer').GuestTransferStatusResponse> {
    return this.request(
      `/api/catalog/guest-transfer/status?idempotencyKey=${encodeURIComponent(idempotencyKey)}`
    );
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
  async runAudit(): Promise<{
    success: boolean;
    auditRun: any;
    catalog: StoragePayloadV1;
    reportEntitlement?: ReportEntitlement;
    preliminarySummary?: PreliminaryAuditSummary;
  }> {
    return this.request('/api/audit/run', {
      method: 'POST',
    });
  }

  async getLatestAuditRun(): Promise<{
    workspaceId: string;
    auditRun: any | null;
    reportEntitlement?: ReportEntitlement;
  }> {
    return this.request('/api/audit/latest');
  }

  async getAuditHistory(options?: { limit?: number; cursor?: string }): Promise<import('../domain/audit/historicalTypes').AuditHistoryResponse & { reportEntitlement?: ReportEntitlement }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/audit/history${query}`);
  }

  async getAuditRun(id: string): Promise<import('../domain/audit/historicalTypes').HistoricalAuditSnapshot & { reportEntitlement?: ReportEntitlement }> {
    return this.request(`/api/audit/${encodeURIComponent(id)}`);
  }

  async compareAudits(baseId: string, targetId: string): Promise<{ success: boolean; comparison: import('../domain/audit/historicalTypes').AuditComparisonResult }> {
    const params = new URLSearchParams({ baseId, targetId });
    return this.request<{ success: boolean; comparison: import('../domain/audit/historicalTypes').AuditComparisonResult }>(`/api/audit/compare?${params.toString()}`);
  }

  // Billing Endpoints
  async getBillingPlans(): Promise<BillingPlansResponse> {
    const data = await this.request<BillingPlansResponse>('/api/billing/plans');
    if (!data || typeof data !== 'object' || !Array.isArray(data.plans)) {
      throw new Error('Malformed billing plans response from server');
    }
    const validPlans = data.plans.filter(
      (p): p is BillingPlan =>
        Boolean(p) &&
        typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.tier === 'string' &&
        typeof p.name === 'string' &&
        typeof p.priceCents === 'number' &&
        Number.isFinite(p.priceCents) &&
        Array.isArray(p.features)
    );
    if (validPlans.length === 0) {
      throw new Error('Server returned no valid billing plans');
    }
    return {
      plans: validPlans,
      ...(Array.isArray(data.commercialSummary) ? { commercialSummary: data.commercialSummary } : {}),
      currency: typeof data.currency === 'string' && data.currency ? data.currency : 'USD',
    };
  }

  async getBillingSubscription(): Promise<BillingSubscriptionResponse> {
    const data = await this.request<BillingSubscriptionResponse>('/api/billing/subscription');
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.workspaceId !== 'string' ||
      !data.workspaceId.trim() ||
      !data.subscription ||
      typeof data.subscription !== 'object' ||
      typeof data.subscription.tier !== 'string' ||
      typeof data.subscription.status !== 'string'
    ) {
      throw new Error('Malformed subscription response from server');
    }
    return data;
  }

  async verifyCheckoutSession(sessionId: string): Promise<CheckoutVerificationResponse> {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('A valid checkout sessionId is required for verification');
    }
    return this.request<CheckoutVerificationResponse>('/api/billing/checkout-session/verify', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionId.trim() }),
    });
  }

  async createCheckoutSession(params: CreateCheckoutSessionRequest): Promise<CheckoutSessionResponse> {
    if (!params?.tier || typeof params.tier !== 'string') {
      throw new Error('A valid plan tier is required to initiate checkout');
    }
    const payload: CreateCheckoutSessionRequest = { tier: params.tier };
    if (params.successUrl) payload.successUrl = params.successUrl;
    if (params.cancelUrl) payload.cancelUrl = params.cancelUrl;

    const data = await this.request<CheckoutSessionResponse>('/api/billing/checkout-session', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (
      !data ||
      typeof data !== 'object' ||
      data.success !== true ||
      typeof data.sessionId !== 'string' ||
      !data.sessionId.trim() ||
      !isValidBillingRedirectUrl(data.checkoutUrl, {
        flow: 'checkout',
        provider: typeof data.provider === 'string' ? data.provider : undefined,
      })
    ) {
      throw new Error('Checkout session response missing a valid checkout URL');
    }

    return data;
  }

  async createPortalSession(params?: CreatePortalSessionRequest): Promise<PortalSessionResponse> {
    const payload: CreatePortalSessionRequest = {};
    if (params?.returnUrl) payload.returnUrl = params.returnUrl;

    const data = await this.request<PortalSessionResponse>('/api/billing/portal-session', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (
      !data ||
      typeof data !== 'object' ||
      data.success !== true ||
      !isValidBillingRedirectUrl(data.portalUrl, {
        flow: 'portal',
        provider: typeof data.provider === 'string' ? data.provider : undefined,
      })
    ) {
      throw new Error('Customer portal session response missing a valid portal URL');
    }

    return data;
  }

  // Shopify Endpoints
  async connectShopify(shop: string): Promise<ShopifyConnectResponse> {
    const validation = validateAndNormalizeShopDomain(shop);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const data = await this.request<ShopifyConnectResponse>(
      `/api/shopify/connect?shop=${encodeURIComponent(validation.shopDomain)}`
    );

    if (
      !data ||
      typeof data !== 'object' ||
      data.success !== true ||
      !isValidShopifyAuthUrl(data.authUrl) ||
      typeof data.shopDomain !== 'string' ||
      !data.shopDomain.trim()
    ) {
      throw new Error('Shopify connect response missing a valid Shopify authorization URL');
    }

    return data;
  }

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
    findingsCount?: number;
    storeDomain: string;
    reportEntitlement?: ReportEntitlement;
    isLocked?: boolean;
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
  async validateFeed(platform: string): Promise<{
    success: boolean;
    report: any;
    reportEntitlement?: ReportEntitlement;
    isLocked?: boolean;
  }> {
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

export type PlanTier = 'Free Audit' | 'Starter' | 'Growth' | 'Enterprise';

export type SubscriptionStatus =
  | 'pending'
  | 'incomplete'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'expired';

export interface BillingPlan {
  id: string;
  tier: PlanTier;
  name: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year' | 'none';
  skuLimit: number | null;
  features: string[];
}

export interface BillingPlansResponse {
  plans: BillingPlan[];
  commercialSummary?: CommercialPlanSummaryItem[];
  currency: string;
}

export interface BillingSubscriptionInfo {
  id?: string;
  workspaceId?: string;
  provider: string;
  tier: PlanTier | string;
  status: SubscriptionStatus | string;
  billingInterval?: 'month' | 'year' | 'none';
  isRecurring?: boolean;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BillingSubscriptionResponse {
  workspaceId: string;
  subscription: BillingSubscriptionInfo;
  storeProfile: StoreProfile | null;
  reportEntitlement?: ReportEntitlement;
}

export interface CheckoutVerificationResponse {
  success: boolean;
  verified: boolean;
  workspaceId: string;
  subscription: BillingSubscriptionInfo;
  storeProfile: StoreProfile | null;
  reportEntitlement?: ReportEntitlement;
}

export interface CreateCheckoutSessionRequest {
  tier: PlanTier;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutSessionResponse {
  success: boolean;
  sessionId: string;
  checkoutUrl: string;
  provider: string;
}

export interface CreatePortalSessionRequest {
  returnUrl?: string;
}

export interface PortalSessionResponse {
  success: boolean;
  portalUrl: string;
  provider: string;
}

export interface ShopifyConnectResponse {
  success: boolean;
  authUrl: string;
  state: string;
  shopDomain: string;
}

export const apiClient = new ApiClient();
