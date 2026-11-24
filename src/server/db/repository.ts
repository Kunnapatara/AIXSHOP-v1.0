import { 
  UserRecord, 
  WorkspaceRecord, 
  WorkspaceMembershipRecord, 
  SessionRecord, 
  StoreRecord,
  WorkspaceRole 
} from '../types';
import { 
  Product, 
  Variant, 
  Offer, 
  EvidenceDocument, 
  Finding, 
  ActionItem, 
  StoreProfile,
  CatalogImportResult,
  ProductCandidate,
  EvidencePurpose,
  EvidenceReviewAuditEntry,
  ExternalVerificationStatus,
  ReviewerPrincipalType,
  ShopifyProductProvenanceRecord
} from '../../types';
import { ReviewerServicePrincipalRecord } from '../security/reviewerAuth';
import { ExternalRegistryVerificationEvaluation } from '../services/externalRegistryService';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { SubscriptionRecord, BillingEventRecord, BillingEventStatus, PlanTier } from '../billing/types';
import {
  GuestTransferAuditRecord,
  GuestTransferAuthorizationRecord,
  GuestTransferCommitResult,
  GuestTransferConflictStrategy,
} from '../../domain/catalog/guestTransfer';

export interface CreateUserData {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
}

export interface CreateWorkspaceData {
  id: string;
  name: string;
  slug: string;
}

export interface CreateSessionData {
  id: string;
  sessionTokenHash: string;
  userId: string;
  activeWorkspaceId: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RegisterUserData {
  user: CreateUserData;
  workspace: CreateWorkspaceData;
  session: CreateSessionData;
}

export interface RegisterUserResult {
  user: UserRecord;
  workspace: WorkspaceRecord;
  membership: WorkspaceMembershipRecord;
  session: SessionRecord;
}

export interface SchemaReadinessResult {
  isReady: boolean;
  missingTables?: string[];
  pendingMigrations?: string[];
  error?: string;
  details?: {
    checkedTables: string[];
    appliedMigrations: string[];
    verifiedConstraints?: string[];
  };
}

export class CatalogVersionConflictError extends Error {
  public readonly code = 'CATALOG_VERSION_CONFLICT';
  public readonly statusCode = 409;
  public readonly workspaceId: string;
  public readonly expectedVersion: number | null;
  public readonly currentVersion: number;

  constructor(workspaceId: string, expectedVersion: number | null, actualVersion: number) {
    super(
      expectedVersion === null
        ? `Catalog snapshot version guard required for workspace "${workspaceId}": missing expectedVersion, current authoritative version is ${actualVersion}.`
        : `Catalog snapshot conflict for workspace "${workspaceId}": expected version ${expectedVersion}, current authoritative version is ${actualVersion}.`
    );
    this.name = 'CatalogVersionConflictError';
    this.workspaceId = workspaceId;
    this.expectedVersion = expectedVersion;
    this.currentVersion = actualVersion;
  }
}

export class CatalogVersionValidationError extends Error {
  public readonly code = 'INVALID_CATALOG_VERSION';
  public readonly statusCode = 400;
  public readonly currentVersion?: number;

  constructor(message: string, currentVersion?: number) {
    super(message);
    this.name = 'CatalogVersionValidationError';
    this.currentVersion = currentVersion;
  }
}

export class WorkspaceLockOrderError extends Error {
  public readonly code = 'WORKSPACE_LOCK_ORDER_VIOLATION';
  public readonly statusCode = 409;
  public readonly heldWorkspaces: string[];
  public readonly requestedWorkspace: string;

  constructor(heldWorkspaces: string[], requestedWorkspace: string) {
    super(
      `[AIXSHOP Workspace Lock] Cross-workspace lock order violation: cannot acquire "${requestedWorkspace}" while holding [${heldWorkspaces.join(', ')}]. Acquire multi-workspace locks in deterministic lexicographical order.`
    );
    this.name = 'WorkspaceLockOrderError';
    this.heldWorkspaces = [...heldWorkspaces];
    this.requestedWorkspace = requestedWorkspace;
  }
}

export interface DatabaseRepository {
  // Database health & readiness
  ping(): Promise<boolean>;
  checkSchemaReadiness(): Promise<SchemaReadinessResult>;
  getBackendType(): 'postgres' | 'memory';
  close?(): Promise<void>;

  // Shared distributed rate limiting (Workstream G)
  consumeRateLimit(
    key: string,
    maxAttempts: number,
    windowMs: number
  ): Promise<{ allowed: boolean; count: number; resetAt: number }>;

  // Atomic Registration
  registerUser(data: RegisterUserData): Promise<RegisterUserResult>;

  // Users
  createUser(data: CreateUserData): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;
  updateUserPassword?(userId: string, passwordHash: string): Promise<void>;

  // Password Reset Recovery Tokens (Migration 014)
  createPasswordResetToken(data: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
    requestedIp?: string;
  }): Promise<void>;
  invalidatePasswordResetToken(tokenId: string): Promise<void>;
  consumePasswordResetTokenAndUpdatePassword(
    tokenHash: string,
    newPasswordHash: string
  ): Promise<{ userId: string } | null>;

  // Workspaces & Memberships
  createWorkspace(data: CreateWorkspaceData, ownerUserId: string): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }>;
  getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null>;
  getUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>>;
  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembershipRecord | null>;

  // Sessions
  createSession(data: CreateSessionData): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteUserSessions(userId: string): Promise<void>;
  updateSessionWorkspace(sessionId: string, newWorkspaceId: string): Promise<void>;

  // Workspace Operation Leases (Migration 014)
  acquireWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string,
    ttlMs: number
  ): Promise<{ acquired: boolean; leaseOwner?: string; expiresAt?: string }>;
  releaseWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string
  ): Promise<void>;

  // Stores
  getStoreByWorkspace(workspaceId: string): Promise<StoreProfile | null>;
  saveStoreProfile(workspaceId: string, profile: StoreProfile): Promise<StoreProfile>;

  // Distributed Workspace Lock & Authoritative Catalog Mutation (Workstream B)
  withWorkspaceLock<T>(
    workspaceId: string,
    fn: () => Promise<T>,
    options?: { lockTimeoutMs?: number }
  ): Promise<T>;

  mutateWorkspaceCatalog<T>(
    workspaceId: string,
    mutator: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{ nextCatalog?: StoragePayloadV1; result: T }> | { nextCatalog?: StoragePayloadV1; result: T }
  ): Promise<T>;

  // Catalog
  loadWorkspaceCatalog(workspaceId: string): Promise<StoragePayloadV1 | null>;
  saveWorkspaceCatalog(
    workspaceId: string,
    payload: StoragePayloadV1,
    options?: { expectedVersion?: number }
  ): Promise<void>;
  
  // Specific Catalog Mutations (atomic, server-side validated)
  approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product; catalogVersion?: number }>;

  dismissAction(
    workspaceId: string, 
    actionId: string
  ): Promise<{ action: ActionItem; catalogVersion?: number }>;

  recheckAction(
    workspaceId: string, 
    actionId: string
  ): Promise<{ action: ActionItem; catalogVersion?: number }>;

  importCatalog(
    workspaceId: string,
    candidates: ProductCandidate[]
  ): Promise<CatalogImportResult>;

  // GTIN Evidence Verification & Shopify Provenance (Migration 015)
  submitEvidenceDocument(params: {
    workspaceId: string;
    productId: string;
    title: string;
    type: EvidenceDocument['type'];
    issuer: string;
    dateVerified?: string;
    url?: string;
    evidencePurpose?: EvidencePurpose;
    submittedByUserId: string;
    id?: string;
  }): Promise<{ evidence: EvidenceDocument; catalogVersion?: number }>;

  getEvidenceDocumentById(
    workspaceId: string,
    evidenceId: string
  ): Promise<{ evidence: EvidenceDocument; productId: string; product?: Product } | null>;

  reviewEvidenceDocument(params: {
    workspaceId: string;
    evidenceId: string;
    decision: 'approved' | 'rejected';
    reviewerId: string;
    reviewerRole: string;
    principalType?: ReviewerPrincipalType;
    authMethod?: string;
    claimedReviewerId?: string;
    reason?: string;
    verificationSource?: 'server_reviewer';
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }>;

  recordExternalRegistryVerification(params: {
    workspaceId: string;
    evidenceId: string;
    initiatedByReviewerId: string;
    initiatedByPrincipalType: ReviewerPrincipalType;
    initiatedByAuthMethod: string;
    claimedReviewerId?: string;
    evaluation: ExternalRegistryVerificationEvaluation;
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }>;

  getPlatformReviewerGrant(userId: string): Promise<{
    platformRole: 'none' | 'platform_reviewer';
    scopes: string[];
    revokedAt?: string | null;
  } | null>;

  setPlatformReviewerGrant(params: {
    userId: string;
    platformRole: 'none' | 'platform_reviewer';
    scopes?: string[];
    revokedAt?: string | null;
  }): Promise<void>;

  listReviewerServicePrincipals(): Promise<ReviewerServicePrincipalRecord[]>;
  saveReviewerServicePrincipal(principal: ReviewerServicePrincipalRecord): Promise<ReviewerServicePrincipalRecord>;
  revokeReviewerServicePrincipal(principalId: string): Promise<void>;

  getEvidenceReviewAuditLog(workspaceId: string, evidenceId?: string): Promise<EvidenceReviewAuditEntry[]>;

  upsertShopifyProductProvenance(record: ShopifyProductProvenanceRecord): Promise<void>;
  getShopifyProductProvenance(workspaceId: string): Promise<ShopifyProductProvenanceRecord[]>;
  deleteShopifyProductProvenance(workspaceId: string, productId: string): Promise<void>;

  // Guest-to-Cloud Catalog Transfer Authorizations & Audit Trail (Migration 018)
  createGuestTransferAuthorization(record: GuestTransferAuthorizationRecord): Promise<GuestTransferAuthorizationRecord>;
  getGuestTransferAuthorizationByTokenHash(tokenHash: string): Promise<GuestTransferAuthorizationRecord | null>;
  getGuestTransferAuthorizationByIdempotencyKey(
    workspaceId: string,
    userId: string,
    idempotencyKey: string
  ): Promise<GuestTransferAuthorizationRecord | null>;
  markGuestTransferAuthorizationExpired(id: string): Promise<void>;
  commitGuestTransferAtomic(params: {
    authorizationId: string;
    workspaceId: string;
    userId: string;
    payloadSha256: string;
    conflictStrategy: GuestTransferConflictStrategy;
    guestPayload: StoragePayloadV1;
    buildMergedCatalog: (ctx: {
      existingCatalog: StoragePayloadV1 | null;
      authoritativeStore: StoreProfile;
      subscription: SubscriptionRecord | null;
      catalogVersionBefore: number;
    }) => {
      mergedPayload: StoragePayloadV1;
      summary: GuestTransferCommitResult;
      importedCount: number;
      skippedCount: number;
      conflictsCount: number;
    };
  }): Promise<GuestTransferCommitResult>;
  recordGuestTransferAudit(record: GuestTransferAuditRecord): Promise<void>;
  getGuestTransferAuditLog(workspaceId: string): Promise<GuestTransferAuditRecord[]>;

  // Billing & Subscriptions
  getSubscriptionByWorkspace(workspaceId: string): Promise<SubscriptionRecord | null>;
  getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRecord | null>;
  saveSubscription(subscription: SubscriptionRecord): Promise<SubscriptionRecord>;
  getBillingEventById(eventId: string): Promise<BillingEventRecord | null>;
  saveBillingEvent(event: BillingEventRecord): Promise<void>;
  claimBillingEvent(
    event: BillingEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }>;
  listRecoverableBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
  }): Promise<BillingEventRecord[]>;
  finalizeExpiredExhaustedBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
    reason?: string;
  }): Promise<BillingEventRecord[]>;
  claimBillingEventForRecovery(
    eventId: string,
    options?: {
      leaseOwner?: string;
      leaseDurationMs?: number;
      maxAttempts?: number;
      allowReplayFailed?: boolean;
      provider?: string;
    }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }>;
  renewBillingEventLease(eventId: string, leaseOwner: string, extendMs?: number): Promise<boolean>;
  updateBillingEventStatus(
    eventId: string,
    status: BillingEventStatus,
    payload?: any,
    leaseOwner?: string
  ): Promise<void>;
  markBillingEventFailure(params: {
    eventId: string;
    leaseOwner?: string;
    status: 'failed' | 'permanently_failed';
    errorMessage: string;
    nextRetryAt?: string | null;
  }): Promise<void>;
  applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
    leaseOwner?: string;
  }): Promise<void>;

  // Catalog Audit Runs
  createAuditRun(data: CreateAuditRunData): Promise<AuditRunRecord>;
  updateAuditRun(id: string, updates: UpdateAuditRunData): Promise<AuditRunRecord>;
  getAuditRunById(id: string, workspaceId: string): Promise<AuditRunRecord | null>;
  getLatestAuditRunByWorkspace(workspaceId: string): Promise<AuditRunRecord | null>;
  executeWorkspaceAudit(workspaceId: string): Promise<{ auditRun: AuditRunRecord; catalog: StoragePayloadV1 }>;

  // Workstream B: Audit History & Evidence Snapshots
  getAuditRunsHistory(
    workspaceId: string, 
    options?: { limit?: number; cursor?: string }
  ): Promise<{ items: Array<AuditRunRecord & { snapshotAvailable: boolean }>; nextCursor: string | null; totalCount: number }>;

  getHistoricalAuditSnapshot(
    workspaceId: string, 
    auditRunId: string
  ): Promise<import('../../domain/audit/historicalTypes').HistoricalAuditSnapshot | null>;

  compareHistoricalAudits(
    workspaceId: string,
    baseAuditId: string,
    targetAuditId: string
  ): Promise<import('../../domain/audit/historicalTypes').AuditComparisonResult | null>;

  // Workstream C: Shopify Integration
  getShopifyConnection(workspaceId: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null>;
  getShopifyConnectionByShop(shopDomain: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null>;
  saveShopifyConnection(conn: import('../shopify/types').ShopifyConnectionRecord): Promise<import('../shopify/types').ShopifyConnectionRecord>;
  deleteShopifyConnection(workspaceId: string): Promise<void>;
  saveShopifyOAuthState(state: { id: string; workspaceId: string; shopDomain: string; expiresAt: string }): Promise<void>;
  getAndConsumeShopifyOAuthState(stateId: string): Promise<{ id: string; workspaceId: string; shopDomain: string; expiresAt: string } | null>;
  createShopifySyncRun(run: import('../shopify/types').ShopifySyncRunRecord): Promise<import('../shopify/types').ShopifySyncRunRecord>;
  updateShopifySyncRun(
    id: string,
    workspaceId: string,
    updates: Partial<import('../shopify/types').ShopifySyncRunRecord>
  ): Promise<import('../shopify/types').ShopifySyncRunRecord>;
  getShopifySyncRunById(id: string, workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null>;
  getLatestShopifySyncRun(workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null>;
  getShopifySyncRuns(workspaceId: string, limit?: number): Promise<import('../shopify/types').ShopifySyncRunRecord[]>;
  claimShopifyWebhookEvent(
    event: import('../shopify/types').ShopifyWebhookEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<import('../shopify/types').ShopifyWebhookClaimResult>;
  updateShopifyWebhookEventStatus(
    eventId: string,
    shopDomain: string,
    topic: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    error?: string,
    leaseOwner?: string
  ): Promise<void>;
  withShopifyRefreshLock<T>(
    workspaceId: string,
    fn: (
      connection: import('../shopify/types').ShopifyConnectionRecord,
      saveConnection: (conn: import('../shopify/types').ShopifyConnectionRecord) => Promise<import('../shopify/types').ShopifyConnectionRecord>
    ) => Promise<T>
  ): Promise<T>;
  getWorkspaceBusinessProfile(workspaceId: string): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile | null>;
  saveWorkspaceBusinessProfile(profile: import('../../domain/businessProfile/types').WorkspaceBusinessProfile): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile>;
  saveVisibilityImport(record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord>;
  getVisibilityImportByHash(workspaceId: string, contentHash: string): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord | null>;
  saveVisibilityMetrics(metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]): Promise<void>;
  saveVisibilityImportAtomic(
    record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord,
    metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[],
    options?: { conflictPolicy?: import('../../domain/monitoring/aiVisibilityTypes').VisibilityConflictPolicy }
  ): Promise<{
    importRecord: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord;
    metricsSaved: number;
    duplicateImport?: boolean;
    replacedCount?: number;
  }>;
  getVisibilityObservationHistory?(
    workspaceId: string,
    limit?: number
  ): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityObservationHistoryRecord[]>;
  getVisibilitySummary(workspaceId: string): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilitySummary>;
}

export type AuditRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AuditRunRecord {
  id: string;
  workspaceId: string;
  status: AuditRunStatus;
  productsEvaluated: number;
  rulesEvaluated: number;
  findingsCount: number;
  summary: Record<string, any>;
  metadata: Record<string, any>;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAuditRunData {
  id: string;
  workspaceId: string;
  status: AuditRunStatus;
  productsEvaluated?: number;
  rulesEvaluated?: number;
  findingsCount?: number;
  summary?: Record<string, any>;
  metadata?: Record<string, any>;
  startedAt?: string;
}

export interface UpdateAuditRunData {
  status?: AuditRunStatus;
  productsEvaluated?: number;
  rulesEvaluated?: number;
  findingsCount?: number;
  summary?: Record<string, any>;
  metadata?: Record<string, any>;
  errorMessage?: string | null;
  completedAt?: string | null;
}

