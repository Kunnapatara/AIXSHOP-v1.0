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
  ProductCandidate
} from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { SubscriptionRecord, BillingEventRecord, PlanTier } from '../billing/types';

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

export interface DatabaseRepository {
  // Database health & readiness
  ping(): Promise<boolean>;
  checkSchemaReadiness(): Promise<SchemaReadinessResult>;
  getBackendType(): 'postgres' | 'memory';
  close?(): Promise<void>;

  // Atomic Registration
  registerUser(data: RegisterUserData): Promise<RegisterUserResult>;

  // Users
  createUser(data: CreateUserData): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;

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

  // Stores
  getStoreByWorkspace(workspaceId: string): Promise<StoreProfile | null>;
  saveStoreProfile(workspaceId: string, profile: StoreProfile): Promise<StoreProfile>;

  // Catalog
  loadWorkspaceCatalog(workspaceId: string): Promise<StoragePayloadV1 | null>;
  saveWorkspaceCatalog(workspaceId: string, payload: StoragePayloadV1): Promise<void>;
  
  // Specific Catalog Mutations (atomic, server-side validated)
  approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product }>;

  dismissAction(
    workspaceId: string, 
    actionId: string
  ): Promise<{ action: ActionItem }>;

  recheckAction(
    workspaceId: string, 
    actionId: string
  ): Promise<{ action: ActionItem }>;

  importCatalog(
    workspaceId: string,
    candidates: ProductCandidate[]
  ): Promise<CatalogImportResult>;

  // Billing & Subscriptions
  getSubscriptionByWorkspace(workspaceId: string): Promise<SubscriptionRecord | null>;
  getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRecord | null>;
  saveSubscription(subscription: SubscriptionRecord): Promise<SubscriptionRecord>;
  getBillingEventById(eventId: string): Promise<BillingEventRecord | null>;
  saveBillingEvent(event: BillingEventRecord): Promise<void>;
  claimBillingEvent(event: BillingEventRecord): Promise<{ claimed: boolean; event: BillingEventRecord | null }>;
  updateBillingEventStatus(eventId: string, status: 'processing' | 'processed' | 'failed' | 'ignored', payload?: any): Promise<void>;
  applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
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
  updateShopifySyncRun(id: string, updates: Partial<import('../shopify/types').ShopifySyncRunRecord>): Promise<import('../shopify/types').ShopifySyncRunRecord>;
  getShopifySyncRunById(id: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null>;
  getLatestShopifySyncRun(workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null>;
  getShopifySyncRuns(workspaceId: string, limit?: number): Promise<import('../shopify/types').ShopifySyncRunRecord[]>;
  claimShopifyWebhookEvent(event: import('../shopify/types').ShopifyWebhookEventRecord): Promise<{ claimed: boolean; event: import('../shopify/types').ShopifyWebhookEventRecord | null }>;
  updateShopifyWebhookEventStatus(eventId: string, shopDomain: string, topic: string, status: 'processing' | 'processed' | 'failed' | 'ignored', error?: string): Promise<void>;
  withShopifyRefreshLock<T>(
    workspaceId: string,
    fn: (
      connection: import('../shopify/types').ShopifyConnectionRecord,
      saveConnection: (conn: import('../shopify/types').ShopifyConnectionRecord) => Promise<import('../shopify/types').ShopifyConnectionRecord>
    ) => Promise<T>
  ): Promise<T>;
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

