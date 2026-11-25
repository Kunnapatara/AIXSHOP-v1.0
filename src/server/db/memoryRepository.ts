import { AsyncLocalStorage } from 'node:async_hooks';
import { 
  DatabaseRepository, 
  CreateUserData, 
  CreateWorkspaceData, 
  CreateSessionData,
  RegisterUserData,
  RegisterUserResult,
  SchemaReadinessResult,
  AuditRunRecord,
  CreateAuditRunData,
  UpdateAuditRunData,
  CatalogVersionConflictError,
  CatalogVersionValidationError,
  WorkspaceLockOrderError
} from './repository';
import {
  TopicPresenceState,
  VisibilityConflictPolicy,
  VisibilityObservationConflict,
  VisibilityObservationConflictError,
  VisibilityObservationHistoryRecord,
} from '../../domain/monitoring/aiVisibilityTypes';
import { executeCatalogAudit } from '../../domain/audit/auditEngine';
import { 
  UserRecord, 
  WorkspaceRecord, 
  WorkspaceMembershipRecord, 
  SessionRecord, 
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
import {
  buildTrustedGtinVerificationContext,
  computeEvidenceIntegrityHash,
  sanitizeAndValidateImportCandidates,
} from '../security/catalogSanitizer';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { SubscriptionRecord, BillingEventRecord, BillingEventStatus, PlanTier } from '../billing/types';
import { 
  initialProducts, 
  initialFindings, 
  initialActionItems, 
  initialStoreProfile 
} from '../../data/mockData';
import { 
  executeActionApproval, 
  executeActionDismissal, 
  executeActionRecheck, 
  executeCatalogImport 
} from '../../domain/catalog/catalogMutationService';
import { 
  calculateImportUsage, 
  checkPlanQuota, 
  countCatalogSkus, 
  PlanQuotaExceededError 
} from '../services/entitlementService';
import {
  GuestTransferAuditRecord,
  GuestTransferAuthorizationRecord,
  GuestTransferCommitResult,
  GuestTransferConflictStrategy,
} from '../../domain/catalog/guestTransfer';
import { GuestTransferError } from '../services/guestTransferService';

export class MemoryRepository implements DatabaseRepository {
  private users: Map<string, UserRecord> = new Map();
  private workspaces: Map<string, WorkspaceRecord> = new Map();
  private memberships: Map<string, WorkspaceMembershipRecord> = new Map(); // id -> record
  private sessions: Map<string, SessionRecord> = new Map(); // tokenHash -> record
  private stores: Map<string, StoreProfile> = new Map(); // workspaceId -> store
  private catalogs: Map<string, StoragePayloadV1> = new Map(); // workspaceId -> catalog
  private subscriptions: Map<string, SubscriptionRecord> = new Map(); // workspaceId -> subscription
  private billingEvents: Map<string, BillingEventRecord> = new Map(); // eventId -> event
  private auditRuns: Map<string, AuditRunRecord> = new Map(); // auditRunId -> record
  private auditRunFindings: Map<string, import('../../domain/audit/historicalTypes').HistoricalFindingRecord[]> = new Map(); // auditRunId -> findings
  private auditRunEvidence: Map<string, import('../../domain/audit/historicalTypes').HistoricalEvidenceRecord[]> = new Map(); // auditRunId -> evidence
  private auditRunProducts: Map<string, import('../../domain/audit/historicalTypes').HistoricalProductRecord[]> = new Map(); // auditRunId -> products
  private auditRunManifests: Map<string, { auditRunId: string; workspaceId: string; status: string; productsCount: number; findingsCount: number; evidenceCount: number; createdAt: string }> = new Map();

  // Workstream C: Shopify Integration Storage
  private shopifyConnections: Map<string, import('../shopify/types').ShopifyConnectionRecord> = new Map(); // workspaceId -> record
  private shopifyOAuthStates: Map<string, { id: string; workspaceId: string; shopDomain: string; expiresAt: string; createdAt: string }> = new Map(); // stateNonce -> state
  private shopifySyncRuns: Map<string, import('../shopify/types').ShopifySyncRunRecord> = new Map(); // id -> run
  private shopifyWebhookEvents: Map<string, import('../shopify/types').ShopifyWebhookEventRecord> = new Map(); // deliveryKey -> event
  private passwordResetTokens: Map<string, { id: string; userId: string; tokenHash: string; expiresAt: string; usedAt: string | null; requestedIp?: string; createdAt: string }> = new Map();
  private workspaceOperationLeases: Map<string, { workspaceId: string; operationKey: string; leaseOwner: string; leaseExpiresAt: number }> = new Map();
  private evidenceReviewAuditLog: Map<string, EvidenceReviewAuditEntry[]> = new Map(); // workspaceId -> entries
  private shopifyProductProvenance: Map<string, Map<string, ShopifyProductProvenanceRecord>> = new Map(); // workspaceId -> productId -> record
  private reviewerServicePrincipals: Map<string, ReviewerServicePrincipalRecord> = new Map(); // principalId -> record
  private userPlatformGrants: Map<string, { platformRole: 'none' | 'platform_reviewer'; scopes: string[]; revokedAt?: string | null }> = new Map();
  private guestTransferAuthorizations: Map<string, GuestTransferAuthorizationRecord> = new Map(); // id -> record
  private guestTransferAuditLog: Map<string, GuestTransferAuditRecord[]> = new Map(); // workspaceId -> entries

  constructor(seedDefaultDemoWorkspace = false) {
    if (seedDefaultDemoWorkspace) {
      this.seedDemo();
    }
  }

  getBackendType(): 'memory' {
    return 'memory';
  }

  async close(): Promise<void> {
    // MemoryRepository holds no external socket/pool handles
    return Promise.resolve();
  }

  private isConnected: boolean = true;
  private isSchemaReady: boolean = true;
  private schemaReadyError?: string;
  private rateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private static readonly MAX_RATE_LIMIT_ENTRIES = 5000;

  async consumeRateLimit(
    key: string,
    maxAttempts: number,
    windowMs: number
  ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    const now = Date.now();
    // Prune expired entries opportunistically and enforce strict hard cap
    if (this.rateLimits.size >= MemoryRepository.MAX_RATE_LIMIT_ENTRIES) {
      for (const [k, v] of this.rateLimits.entries()) {
        if (now > v.resetAt) this.rateLimits.delete(k);
      }
    }

    const existing = this.rateLimits.get(key);
    if (existing && now <= existing.resetAt) {
      this.rateLimits.delete(key);
      if (existing.count >= maxAttempts) {
        this.rateLimits.set(key, existing);
        return { allowed: false, count: existing.count, resetAt: existing.resetAt };
      }
      const next = { count: existing.count + 1, resetAt: existing.resetAt };
      this.rateLimits.set(key, next);
      return { allowed: true, count: next.count, resetAt: next.resetAt };
    }

    while (this.rateLimits.size >= MemoryRepository.MAX_RATE_LIMIT_ENTRIES) {
      const oldest = this.rateLimits.keys().next().value;
      if (oldest === undefined) break;
      this.rateLimits.delete(oldest);
    }

    const resetAt = now + windowMs;
    this.rateLimits.set(key, { count: 1, resetAt });
    return { allowed: true, count: 1, resetAt };
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
  }

  getRateLimitStoreSize(): number {
    return this.rateLimits.size;
  }

  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  setSchemaReady(ready: boolean, error?: string): void {
    this.isSchemaReady = ready;
    this.schemaReadyError = error;
  }

  async ping(): Promise<boolean> {
    return this.isConnected;
  }

  async checkSchemaReadiness(): Promise<SchemaReadinessResult> {
    if (!this.isConnected) {
      return { isReady: false, error: 'Database connection unreachable' };
    }
    if (!this.isSchemaReady) {
      return { 
        isReady: false, 
        error: this.schemaReadyError || 'Database schema incomplete or migrations pending' 
      };
    }
    return {
      isReady: true,
      details: {
        checkedTables: [
          'users',
          'workspaces',
          'workspace_memberships',
          'sessions',
          'stores',
          'products',
          'variants',
          'offers',
          'evidence_documents',
          'findings',
          'action_items',
          'schema_migrations',
          'evidence_review_audit_log',
          'shopify_product_provenance',
          'reviewer_service_principals',
          'guest_transfer_authorizations',
          'guest_transfer_audit_log',
        ],
        appliedMigrations: [
          '001_initial_schema.sql',
          '015_gtin_evidence_trust.sql',
          '016_source_classification_and_domain_cleanup.sql',
          '017_reviewer_identity_and_registry_trust.sql',
          '018_guest_transfer_authorizations.sql',
        ],
      },
    };
  }

  async registerUser(data: RegisterUserData): Promise<RegisterUserResult> {
    const emailNorm = data.user.email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === emailNorm) {
        const err: any = new Error('duplicate key value violates unique constraint "users_email_key"');
        err.code = '23505';
        throw err;
      }
    }

    const user: UserRecord = {
      id: data.user.id,
      email: emailNorm,
      passwordHash: data.user.passwordHash,
      fullName: data.user.fullName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const workspace: WorkspaceRecord = {
      id: data.workspace.id,
      name: data.workspace.name,
      slug: data.workspace.slug,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const memId = `mem_${workspace.id}_${user.id}`;
    const membership: WorkspaceMembershipRecord = {
      id: memId,
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
      createdAt: new Date().toISOString(),
    };

    const store: StoreProfile = {
      name: `${workspace.name} Store`,
      domain: '',
      websiteUrl: '',
      sourceClassification: 'unconfigured',
      shopifyConnected: false,
      currency: 'USD',
      skuCount: 0,
      skuLimit: 2500,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [
        {
          id: 'shopify_primary',
          type: 'shopify',
          name: 'Shopify Storefront Connector',
          status: 'not_configured',
          lastSync: 'Never',
          productCountSynced: 0,
          syncedSkuCount: 0,
          readOnly: true,
          writeBackAuthorized: false,
          missingReason: 'Real Shopify OAuth 2.0 application setup and customer credentials are required.',
        },
      ],
    };

    const session: SessionRecord = {
      id: data.session.id,
      sessionTokenHash: data.session.sessionTokenHash,
      userId: user.id,
      activeWorkspaceId: workspace.id,
      expiresAt: data.session.expiresAt,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ipAddress: data.session.ipAddress,
      userAgent: data.session.userAgent,
    };

    this.users.set(user.id, user);
    this.workspaces.set(workspace.id, workspace);
    this.memberships.set(memId, membership);
    this.stores.set(workspace.id, store);
    this.sessions.set(session.sessionTokenHash, session);
    this.catalogs.set(workspace.id, {
      products: [],
      variants: [],
      offers: [],
      findings: [],
      actions: [],
      evidence: [],
      storeProfile: store,
    });

    return { user, workspace, membership, session };
  }

  private seedDemo() {
    const demoWsId = 'ws_demo_solstice';
    const demoStoreId = 'store_demo_solstice';
    this.workspaces.set(demoWsId, {
      id: demoWsId,
      name: 'Solstice Mercantile Demo',
      slug: 'solstice-demo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.stores.set(demoWsId, {
      ...initialStoreProfile,
      name: 'Solstice Mercantile (Demo)',
    });
    this.catalogs.set(demoWsId, {
      products: JSON.parse(JSON.stringify(initialProducts)),
      variants: initialProducts.flatMap(p => p.variants || []),
      offers: initialProducts.flatMap(p => p.offers || []),
      findings: JSON.parse(JSON.stringify(initialFindings)),
      actions: JSON.parse(JSON.stringify(initialActionItems)),
      evidence: initialProducts.flatMap(p => p.evidenceDocuments || []),
      storeProfile: {
        ...initialStoreProfile,
        name: 'Solstice Mercantile (Demo)',
      },
    });
  }

  async createUser(data: CreateUserData): Promise<UserRecord> {
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === data.email.toLowerCase()) {
        const err: any = new Error('duplicate key value violates unique constraint "users_email_key"');
        err.code = '23505';
        throw err;
      }
    }
    const record: UserRecord = {
      id: data.id,
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(data.id, record);
    return record;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === email.toLowerCase()) {
        return u;
      }
    }
    return null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) || null;
  }

  async createWorkspace(
    data: CreateWorkspaceData, 
    ownerUserId: string
  ): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    const user = this.users.get(ownerUserId);
    if (!user) {
      throw new Error(`Foreign key violation: User ${ownerUserId} does not exist`);
    }

    for (const ws of this.workspaces.values()) {
      if (ws.slug.toLowerCase() === data.slug.toLowerCase()) {
        const err: any = new Error('duplicate key value violates unique constraint "workspaces_slug_key"');
        err.code = '23505';
        throw err;
      }
    }

    const workspace: WorkspaceRecord = {
      id: data.id,
      name: data.name,
      slug: data.slug,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(data.id, workspace);

    const memId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const membership: WorkspaceMembershipRecord = {
      id: memId,
      workspaceId: workspace.id,
      userId: ownerUserId,
      role: 'owner',
      createdAt: new Date().toISOString(),
    };
    this.memberships.set(memId, membership);

    // Create default store
    const store: StoreProfile = {
      name: `${workspace.name} Store`,
      domain: '',
      websiteUrl: '',
      sourceClassification: 'unconfigured',
      shopifyConnected: false,
      currency: 'USD',
      skuCount: 0,
      skuLimit: 2500,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [
        {
          id: 'shopify_primary',
          type: 'shopify',
          name: 'Shopify Storefront Connector',
          status: 'not_configured',
          lastSync: 'Never',
          productCountSynced: 0,
          syncedSkuCount: 0,
          readOnly: true,
          writeBackAuthorized: false,
          missingReason: 'Real Shopify OAuth 2.0 application setup and customer credentials are required.',
        },
      ],
    };
    this.stores.set(workspace.id, store);

    // Initialize empty catalog
    this.catalogs.set(workspace.id, {
      products: [],
      variants: [],
      offers: [],
      findings: [],
      actions: [],
      evidence: [],
      storeProfile: store,
    });

    return { workspace, membership };
  }

  async getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(workspaceId) || null;
  }

  async getUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    const results: Array<WorkspaceRecord & { role: WorkspaceRole }> = [];
    for (const mem of this.memberships.values()) {
      if (mem.userId === userId) {
        const ws = this.workspaces.get(mem.workspaceId);
        if (ws) {
          results.push({ ...ws, role: mem.role });
        }
      }
    }
    return results;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembershipRecord | null> {
    for (const mem of this.memberships.values()) {
      if (mem.workspaceId === workspaceId && mem.userId === userId) {
        return mem;
      }
    }
    return null;
  }

  async createSession(data: CreateSessionData): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: data.id,
      sessionTokenHash: data.sessionTokenHash,
      userId: data.userId,
      activeWorkspaceId: data.activeWorkspaceId,
      expiresAt: data.expiresAt,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    };
    this.sessions.set(data.sessionTokenHash, record);
    return record;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (new Date(session.expiresAt) <= new Date()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return session;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    for (const [hash, s] of this.sessions.entries()) {
      if (s.userId === userId) {
        this.sessions.delete(hash);
      }
    }
  }

  async updateSessionWorkspace(sessionId: string, newWorkspaceId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        s.activeWorkspaceId = newWorkspaceId;
        s.lastActiveAt = new Date().toISOString();
        break;
      }
    }
  }

  async getStoreByWorkspace(workspaceId: string): Promise<StoreProfile | null> {
    return this.stores.get(workspaceId) || null;
  }

  async saveStoreProfile(workspaceId: string, profile: StoreProfile): Promise<StoreProfile> {
    this.stores.set(workspaceId, { ...profile });
    const cat = this.catalogs.get(workspaceId);
    if (cat) {
      cat.storeProfile = { ...profile };
    }
    return { ...profile };
  }

  async loadWorkspaceCatalog(workspaceId: string): Promise<StoragePayloadV1 | null> {
    const cat = this.catalogs.get(workspaceId);
    if (!cat) {
      const store = this.stores.get(workspaceId);
      if (!store || !this.workspaces.has(workspaceId)) return null;
      const initialCatalog: StoragePayloadV1 = {
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
        storeProfile: store,
        catalogVersion: this.catalogVersions.get(workspaceId) || 1,
      };
      this.catalogs.set(workspaceId, initialCatalog);
      return JSON.parse(JSON.stringify(initialCatalog));
    }
    // Return deep clone
    return JSON.parse(JSON.stringify(cat));
  }

  private workspaceLocks: Map<string, Promise<unknown>> = new Map();
  private activeLockWorkspaces = new AsyncLocalStorage<Set<string>>();

  private catalogVersions: Map<string, number> = new Map();

  async withWorkspaceLock<T>(
    workspaceId: string,
    fn: () => Promise<T>,
    _options?: { lockTimeoutMs?: number }
  ): Promise<T> {
    const heldLocks = this.activeLockWorkspaces.getStore();
    if (heldLocks?.has(workspaceId)) {
      return await fn();
    }
    if (heldLocks && heldLocks.size > 0) {
      const held = Array.from(heldLocks).sort();
      const maxHeld = held[held.length - 1];
      if (maxHeld !== undefined && workspaceId < maxHeld) {
        throw new WorkspaceLockOrderError(held, workspaceId);
      }
    }

    const prevLock = this.workspaceLocks.get(workspaceId) || Promise.resolve();
    let releaseCurrent: () => void;
    const currentTurnPromise = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    const chainTail = prevLock.catch(() => {}).then(() => currentTurnPromise);
    this.workspaceLocks.set(workspaceId, chainTail);

    try {
      await prevLock.catch(() => {});
      const nextHeld = new Set(heldLocks || []);
      nextHeld.add(workspaceId);
      return await this.activeLockWorkspaces.run(nextHeld, fn);
    } finally {
      releaseCurrent!();
      if (this.workspaceLocks.get(workspaceId) === chainTail) {
        this.workspaceLocks.delete(workspaceId);
      }
    }
  }

  getActiveWorkspaceLockCount(): number {
    return this.workspaceLocks.size;
  }

  async mutateWorkspaceCatalog<T>(
    workspaceId: string,
    mutator: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{ nextCatalog?: StoragePayloadV1; result: T }> | { nextCatalog?: StoragePayloadV1; result: T }
  ): Promise<T> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) {
        throw new Error(`Workspace ${workspaceId} catalog not found`);
      }
      const authoritativeStore = this.stores.get(workspaceId) || catalog.storeProfile;
      const { nextCatalog, result } = await mutator(catalog, authoritativeStore);
      if (nextCatalog) {
        await this.saveWorkspaceCatalogInternal(workspaceId, nextCatalog);
      }
      return result;
    });
  }

  private async saveWorkspaceCatalogInternal(
    workspaceId: string,
    payload: StoragePayloadV1,
    options?: { expectedVersion?: number }
  ): Promise<void> {
    // Validate workspace exists
    if (!this.workspaces.has(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }

    const currentVersion = this.catalogVersions.get(workspaceId) || 1;
    const rawExpected = options?.expectedVersion !== undefined ? options.expectedVersion : payload.catalogVersion;
    const existingCat = this.catalogs.get(workspaceId);
    const hasExistingItems = Boolean(
      existingCat &&
        (existingCat.products.length > 0 ||
          existingCat.variants.length > 0 ||
          existingCat.offers.length > 0 ||
          existingCat.findings.length > 0 ||
          existingCat.actions.length > 0 ||
          existingCat.evidence.length > 0)
    );
    const isUninitialized = !this.catalogVersions.has(workspaceId) && currentVersion === 1 && !hasExistingItems;

    if (rawExpected !== undefined) {
      if (typeof rawExpected !== 'number' || !Number.isInteger(rawExpected) || rawExpected < 1) {
        throw new CatalogVersionValidationError(
          'expectedVersion must be a positive integer.',
          currentVersion
        );
      }
      if (rawExpected !== currentVersion) {
        throw new CatalogVersionConflictError(workspaceId, rawExpected, currentVersion);
      }
    } else if (!isUninitialized) {
      throw new CatalogVersionConflictError(workspaceId, null, currentVersion);
    }

    const store = this.stores.get(workspaceId);
    const authoritativeStore: StoreProfile = store || {
      name: payload.storeProfile?.name || `${workspaceId} Store`,
      domain: payload.storeProfile?.domain ?? '',
      websiteUrl: payload.storeProfile?.websiteUrl ?? payload.storeProfile?.domain ?? '',
      sourceClassification: payload.storeProfile?.sourceClassification || 'unconfigured',
      shopifyConnected: false,
      currency: payload.storeProfile?.currency || 'USD',
      skuCount: 0,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    };

    const proposedSkus = countCatalogSkus(payload.products);
    const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
    if (!quotaCheck.allowed) {
      throw new PlanQuotaExceededError(quotaCheck);
    }

    const updatedStoreProfile: StoreProfile = {
      ...authoritativeStore,
      ...(payload.storeProfile ? JSON.parse(JSON.stringify(payload.storeProfile)) : {}),
      tier: authoritativeStore.tier,
      skuLimit: authoritativeStore.skuLimit,
      skuCount: proposedSkus,
    };

    const nextVersion = currentVersion + 1;
    const payloadToStore: StoragePayloadV1 = JSON.parse(JSON.stringify(payload));
    payloadToStore.storeProfile = updatedStoreProfile;
    payloadToStore.catalogVersion = nextVersion;

    this.catalogs.set(workspaceId, payloadToStore);
    this.stores.set(workspaceId, updatedStoreProfile);
    this.catalogVersions.set(workspaceId, nextVersion);

    // Prune Shopify provenance rows for products deleted from the catalog
    const activeProductIds = new Set((payloadToStore.products || []).map(p => p.id));
    const wsProv = this.shopifyProductProvenance.get(workspaceId);
    if (wsProv) {
      for (const pid of wsProv.keys()) {
        if (!activeProductIds.has(pid)) {
          wsProv.delete(pid);
        }
      }
    }
  }

  async saveWorkspaceCatalog(
    workspaceId: string,
    payload: StoragePayloadV1,
    options?: { expectedVersion?: number }
  ): Promise<void> {
    return this.withWorkspaceLock(workspaceId, async () => {
      await this.saveWorkspaceCatalogInternal(workspaceId, payload, options);
    });
  }

  async approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product; catalogVersion?: number }> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

      const result = executeActionApproval(actionId, customApprovedValue, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action approval failed');
      }

      const updatedCatalog: StoragePayloadV1 = {
        ...catalog,
        actions: result.nextActions,
        products: result.nextProducts,
        findings: result.nextFindings,
        storeProfile: result.nextStoreProfile,
      };
      await this.saveWorkspaceCatalogInternal(workspaceId, updatedCatalog);

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found`);
      const updatedProduct = updatedAction.productId
        ? result.nextProducts.find(p => p.id === updatedAction.productId)
        : undefined;

      return { action: updatedAction, product: updatedProduct, catalogVersion: this.catalogVersions.get(workspaceId) };
    });
  }

  async dismissAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem; catalogVersion?: number }> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

      const result = executeActionDismissal(actionId, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action dismissal failed');
      }

      await this.saveWorkspaceCatalogInternal(workspaceId, {
        ...catalog,
        actions: result.nextActions,
      });

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found`);
      return { action: updatedAction, catalogVersion: this.catalogVersions.get(workspaceId) };
    });
  }

  async recheckAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem; catalogVersion?: number }> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

      const result = executeActionRecheck(actionId, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action recheck failed');
      }

      await this.saveWorkspaceCatalogInternal(workspaceId, {
        ...catalog,
        actions: result.nextActions,
        findings: result.nextFindings || catalog.findings,
      });

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found`);
      return { action: updatedAction, catalogVersion: this.catalogVersions.get(workspaceId) };
    });
  }

  async importCatalog(
    workspaceId: string,
    candidates: any[]
  ): Promise<CatalogImportResult> {
    const safeCandidates = sanitizeAndValidateImportCandidates(workspaceId, candidates, {
      rejectOnTampering: true,
    });

    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

      const store = await this.getStoreByWorkspace(workspaceId);
      const { additionalSkus } = calculateImportUsage(safeCandidates, catalog.products);
      const quotaCheck = checkPlanQuota(store, catalog.products, additionalSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      const importRes = executeCatalogImport(safeCandidates, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile,
        isReadOnly: false,
      });

      if (importRes.importedCount > 0) {
        await this.saveWorkspaceCatalogInternal(workspaceId, {
          ...catalog,
          products: importRes.nextProducts,
          evidence: importRes.nextProducts.flatMap(p => p.evidenceDocuments || []),
          storeProfile: importRes.nextStoreProfile,
        });
      }

      return importRes;
    });
  }

  // Billing & Subscriptions
  async getSubscriptionByWorkspace(workspaceId: string): Promise<SubscriptionRecord | null> {
    const sub = this.subscriptions.get(workspaceId);
    return sub ? JSON.parse(JSON.stringify(sub)) : null;
  }

  async getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRecord | null> {
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriptionId === subscriptionId) {
        return JSON.parse(JSON.stringify(sub));
      }
    }
    return null;
  }

  async saveSubscription(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    const cloned = JSON.parse(JSON.stringify(subscription));
    this.subscriptions.set(subscription.workspaceId, cloned);
    return JSON.parse(JSON.stringify(cloned));
  }

  async getBillingEventById(eventId: string): Promise<BillingEventRecord | null> {
    const evt = this.billingEvents.get(eventId);
    return evt ? JSON.parse(JSON.stringify(evt)) : null;
  }

  async saveBillingEvent(event: BillingEventRecord): Promise<void> {
    this.billingEvents.set(event.eventId, JSON.parse(JSON.stringify(event)));
  }

  async claimBillingEvent(
    event: BillingEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }> {
    const existing = this.billingEvents.get(event.eventId);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const leaseDurationMs = Math.max(50, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `worker_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();

    if (!existing) {
      const record: BillingEventRecord = {
        ...JSON.parse(JSON.stringify(event)),
        status: 'processing',
        leaseOwner,
        leaseExpiresAt,
        attemptCount: 1,
        lastError: null,
        lastAttemptAt: nowIso,
        nextRetryAt: null,
        processedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.billingEvents.set(event.eventId, record);
      return { claimed: true, event: JSON.parse(JSON.stringify(record)), leaseOwner };
    }

    const processedTime = new Date(existing.processedAt).getTime();
    const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
    const isStale =
      existing.status === 'processing' &&
      (!isNaN(leaseExpiryTime) ? leaseExpiryTime < now : now - processedTime > 5 * 60 * 1000);
    const isFailed = existing.status === 'failed';

    if (isFailed || isStale) {
      existing.status = 'processing';
      existing.leaseOwner = leaseOwner;
      existing.leaseExpiresAt = leaseExpiresAt;
      existing.attemptCount = (existing.attemptCount || 0) + 1;
      existing.lastAttemptAt = nowIso;
      existing.nextRetryAt = null;
      existing.processedAt = nowIso;
      existing.updatedAt = nowIso;
      if (event.payload) {
        existing.payload = JSON.parse(JSON.stringify(event.payload));
      }
      return { claimed: true, event: JSON.parse(JSON.stringify(existing)), leaseOwner };
    }

    return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
  }

  async listRecoverableBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
  }): Promise<BillingEventRecord[]> {
    const now = Date.now();
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const results: BillingEventRecord[] = [];

    for (const existing of this.billingEvents.values()) {
      if (options?.provider && existing.provider !== options.provider) {
        continue;
      }
      if ((existing.attemptCount ?? 0) >= maxAttempts) {
        continue;
      }
      if (existing.status === 'processing') {
        const processedTime = new Date(existing.processedAt).getTime();
        const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
        const isExpired = !isNaN(leaseExpiryTime)
          ? leaseExpiryTime < now
          : now - processedTime > 5 * 60 * 1000;
        if (isExpired) {
          results.push(JSON.parse(JSON.stringify(existing)));
        }
      } else if (existing.status === 'failed') {
        const nextRetryTime = existing.nextRetryAt ? new Date(existing.nextRetryAt).getTime() : NaN;
        if (isNaN(nextRetryTime) || nextRetryTime <= now) {
          results.push(JSON.parse(JSON.stringify(existing)));
        }
      }
    }

    results.sort((a, b) => {
      const ta = new Date(a.nextRetryAt || a.leaseExpiresAt || a.processedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.nextRetryAt || b.leaseExpiresAt || b.processedAt || b.createdAt || 0).getTime();
      return ta - tb;
    });

    return results.slice(0, limit);
  }

  async finalizeExpiredExhaustedBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
    reason?: string;
  }): Promise<BillingEventRecord[]> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const reason = (
      options?.reason ||
      `Worker lease expired on final attempt (maxAttempts=${maxAttempts}) without completion; event finalized to permanently_failed for manual replay.`
    ).slice(0, 500);

    const eligible: BillingEventRecord[] = [];
    for (const existing of this.billingEvents.values()) {
      if (options?.provider && existing.provider !== options.provider) {
        continue;
      }
      if (existing.status !== 'processing') {
        continue;
      }
      if ((existing.attemptCount ?? 0) < maxAttempts) {
        continue;
      }
      const processedTime = new Date(existing.processedAt).getTime();
      const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
      const isExpired = !isNaN(leaseExpiryTime)
        ? leaseExpiryTime < now
        : now - processedTime > 5 * 60 * 1000;
      if (isExpired) {
        eligible.push(existing);
      }
    }

    eligible.sort((a, b) => {
      const ta = new Date(a.leaseExpiresAt || a.processedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.leaseExpiresAt || b.processedAt || b.createdAt || 0).getTime();
      return ta - tb;
    });

    const finalized: BillingEventRecord[] = [];
    for (const existing of eligible.slice(0, limit)) {
      existing.status = 'permanently_failed';
      existing.leaseExpiresAt = null;
      existing.nextRetryAt = null;
      existing.lastError =
        existing.lastError && existing.lastError.trim() !== ''
          ? `${existing.lastError} | ${reason}`.slice(0, 500)
          : reason;
      existing.updatedAt = nowIso;
      finalized.push(JSON.parse(JSON.stringify(existing)));
    }

    return finalized;
  }

  async claimBillingEventForRecovery(
    eventId: string,
    options?: {
      leaseOwner?: string;
      leaseDurationMs?: number;
      maxAttempts?: number;
      allowReplayFailed?: boolean;
      provider?: string;
    }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }> {
    const existing = this.billingEvents.get(eventId);
    if (!existing) {
      return { claimed: false, event: null };
    }
    if (options?.provider && existing.provider !== options.provider) {
      return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
    }
    if (existing.status === 'processed' || existing.status === 'ignored') {
      return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const allowReplayFailed = Boolean(options?.allowReplayFailed);
    const leaseDurationMs = Math.max(50, options?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = options?.leaseOwner || `recovery_${now}_${Math.random().toString(36).slice(2, 10)}`;

    let canClaim = false;
    if (existing.status === 'processing') {
      const processedTime = new Date(existing.processedAt).getTime();
      const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
      const isExpired = !isNaN(leaseExpiryTime)
        ? leaseExpiryTime < now
        : now - processedTime > 5 * 60 * 1000;
      canClaim = isExpired && (allowReplayFailed || (existing.attemptCount ?? 0) < maxAttempts);
    } else if (existing.status === 'failed') {
      const nextRetryTime = existing.nextRetryAt ? new Date(existing.nextRetryAt).getTime() : NaN;
      const retryReady = allowReplayFailed || isNaN(nextRetryTime) || nextRetryTime <= now;
      canClaim = retryReady && (allowReplayFailed || (existing.attemptCount ?? 0) < maxAttempts);
    } else if (existing.status === 'permanently_failed') {
      canClaim = allowReplayFailed;
    }

    if (!canClaim) {
      return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
    }

    existing.status = 'processing';
    existing.leaseOwner = leaseOwner;
    existing.leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();
    existing.attemptCount = (existing.attemptCount || 0) + 1;
    existing.lastAttemptAt = nowIso;
    existing.nextRetryAt = null;
    existing.processedAt = nowIso;
    existing.updatedAt = nowIso;

    return {
      claimed: true,
      leaseOwner,
      event: JSON.parse(JSON.stringify(existing)),
    };
  }

  async renewBillingEventLease(
    eventId: string,
    leaseOwner: string,
    extendMs: number = 5 * 60 * 1000
  ): Promise<boolean> {
    const existing = this.billingEvents.get(eventId);
    if (!existing || existing.status !== 'processing' || existing.leaseOwner !== leaseOwner) {
      return false;
    }
    const now = Date.now();
    if (existing.leaseExpiresAt && new Date(existing.leaseExpiresAt).getTime() < now) {
      return false;
    }
    if (!existing.leaseExpiresAt && existing.processedAt && now - new Date(existing.processedAt).getTime() > 5 * 60 * 1000) {
      return false;
    }
    existing.leaseExpiresAt = new Date(now + Math.max(50, extendMs)).toISOString();
    existing.updatedAt = new Date(now).toISOString();
    return true;
  }

  async updateBillingEventStatus(
    eventId: string,
    status: BillingEventStatus,
    payload?: any,
    leaseOwner?: string
  ): Promise<void> {
    const existing = this.billingEvents.get(eventId);
    if (existing) {
      if (leaseOwner) {
        const now = Date.now();
        const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
        const processedTime = existing.processedAt ? new Date(existing.processedAt).getTime() : NaN;
        const isExpired = !isNaN(leaseExpiryTime)
          ? leaseExpiryTime < now
          : (!isNaN(processedTime) && now - processedTime > 5 * 60 * 1000);
        if (existing.status !== 'processing' || existing.leaseOwner !== leaseOwner || isExpired) {
          throw new Error(`Billing lease ownership lost or expired for event ${eventId}: stale worker "${leaseOwner}" rejected.`);
        }
      }
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
      if (status !== 'processing') {
        existing.leaseExpiresAt = null;
      }
      if (status === 'processed' || status === 'ignored') {
        existing.nextRetryAt = null;
        existing.lastError = null;
      }
      if (payload !== undefined) {
        existing.payload = JSON.parse(JSON.stringify(payload));
      }
    }
  }

  async markBillingEventFailure(params: {
    eventId: string;
    leaseOwner?: string;
    status: 'failed' | 'permanently_failed';
    errorMessage: string;
    nextRetryAt?: string | null;
  }): Promise<void> {
    const existing = this.billingEvents.get(params.eventId);
    if (!existing) {
      return;
    }
    if (params.leaseOwner) {
      const now = Date.now();
      const leaseExpiryTime = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() : NaN;
      const processedTime = existing.processedAt ? new Date(existing.processedAt).getTime() : NaN;
      const isExpired = !isNaN(leaseExpiryTime)
        ? leaseExpiryTime < now
        : (!isNaN(processedTime) && now - processedTime > 5 * 60 * 1000);
      if (existing.status !== 'processing' || existing.leaseOwner !== params.leaseOwner || isExpired) {
        throw new Error(`Billing lease ownership lost or expired for event ${params.eventId}: stale worker "${params.leaseOwner}" rejected.`);
      }
    }
    const nowIso = new Date().toISOString();
    existing.status = params.status;
    existing.leaseExpiresAt = null;
    existing.lastError = params.errorMessage;
    existing.lastAttemptAt = existing.lastAttemptAt || nowIso;
    existing.nextRetryAt = params.status === 'failed' ? (params.nextRetryAt ?? null) : null;
    existing.updatedAt = nowIso;
  }

  async applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
    leaseOwner?: string;
  }): Promise<void> {
    // Verify lease ownership and non-expiration BEFORE modifying any workspace/subscription state
    const prevEvent = this.billingEvents.get(params.eventId);
    if (params.leaseOwner) {
      const now = Date.now();
      const leaseExpiryTime = prevEvent?.leaseExpiresAt ? new Date(prevEvent.leaseExpiresAt).getTime() : NaN;
      const processedTime = prevEvent?.processedAt ? new Date(prevEvent.processedAt).getTime() : NaN;
      const isExpired = !isNaN(leaseExpiryTime)
        ? leaseExpiryTime < now
        : (!isNaN(processedTime) && now - processedTime > 5 * 60 * 1000);
      if (!prevEvent || prevEvent.status !== 'processing' || prevEvent.leaseOwner !== params.leaseOwner || isExpired) {
        throw new Error(`Billing lease ownership lost or expired for event ${params.eventId}: stale worker rejected.`);
      }
    }

    // Snapshot state for atomic rollback simulation
    const prevSub = this.subscriptions.get(params.subscription.workspaceId);
    const prevStore = this.stores.get(params.subscription.workspaceId);
    const prevEventSnapshot = prevEvent ? JSON.parse(JSON.stringify(prevEvent)) : undefined;

    try {
      // 1. Save subscription
      this.subscriptions.set(params.subscription.workspaceId, JSON.parse(JSON.stringify(params.subscription)));

      // 2. Update store profile if requested
      if (params.storeProfileUpdate) {
        const store = this.stores.get(params.subscription.workspaceId);
        if (store) {
          const updatedStore: StoreProfile = {
            ...store,
            tier: params.storeProfileUpdate.tier,
            skuLimit: params.storeProfileUpdate.skuLimit,
          };
          this.stores.set(params.subscription.workspaceId, updatedStore);
          const cat = this.catalogs.get(params.subscription.workspaceId);
          if (cat) {
            cat.storeProfile = { ...updatedStore };
          }
        }
      }

      // 3. Update billing event
      if (params.markProcessed !== false && prevEvent) {
        prevEvent.status = 'processed';
        prevEvent.leaseExpiresAt = null;
        prevEvent.lastError = null;
        prevEvent.nextRetryAt = null;
        prevEvent.processedAt = new Date().toISOString();
        prevEvent.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      // Rollback
      if (prevSub) this.subscriptions.set(params.subscription.workspaceId, prevSub);
      else this.subscriptions.delete(params.subscription.workspaceId);

      if (prevStore) this.stores.set(params.subscription.workspaceId, prevStore);
      if (prevEventSnapshot) this.billingEvents.set(params.eventId, prevEventSnapshot);
      throw err;
    }
  }

  clear(): void {
    this.users.clear();
    this.workspaces.clear();
    this.memberships.clear();
    this.sessions.clear();
    this.stores.clear();
    this.catalogs.clear();
    this.subscriptions.clear();
    this.billingEvents.clear();
    this.auditRuns.clear();
    this.auditRunFindings.clear();
    this.auditRunEvidence.clear();
    this.auditRunProducts.clear();
    this.auditRunManifests.clear();
    this.shopifyConnections.clear();
    this.shopifyOAuthStates.clear();
    this.shopifySyncRuns.clear();
    this.shopifyWebhookEvents.clear();
    this.businessProfiles.clear();
    this.visibilityImports.clear();
    this.visibilityMetrics = [];
  }

  // Catalog Audit Runs
  async createAuditRun(data: CreateAuditRunData): Promise<AuditRunRecord> {
    const now = new Date().toISOString();
    const record: AuditRunRecord = {
      id: data.id,
      workspaceId: data.workspaceId,
      status: data.status,
      productsEvaluated: data.productsEvaluated || 0,
      rulesEvaluated: data.rulesEvaluated || 0,
      findingsCount: data.findingsCount || 0,
      summary: data.summary ? JSON.parse(JSON.stringify(data.summary)) : {},
      metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : {},
      errorMessage: null,
      startedAt: data.startedAt || now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.auditRuns.set(record.id, record);
    return JSON.parse(JSON.stringify(record));
  }

  async updateAuditRun(id: string, updates: UpdateAuditRunData): Promise<AuditRunRecord> {
    const existing = this.auditRuns.get(id);
    if (!existing) {
      throw new Error(`Audit run ${id} not found`);
    }
    const updated: AuditRunRecord = {
      ...existing,
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.productsEvaluated !== undefined ? { productsEvaluated: updates.productsEvaluated } : {}),
      ...(updates.rulesEvaluated !== undefined ? { rulesEvaluated: updates.rulesEvaluated } : {}),
      ...(updates.findingsCount !== undefined ? { findingsCount: updates.findingsCount } : {}),
      ...(updates.summary !== undefined ? { summary: JSON.parse(JSON.stringify(updates.summary)) } : {}),
      ...(updates.metadata !== undefined ? { metadata: JSON.parse(JSON.stringify(updates.metadata)) } : {}),
      ...(updates.errorMessage !== undefined ? { errorMessage: updates.errorMessage } : {}),
      ...(updates.completedAt !== undefined ? { completedAt: updates.completedAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.auditRuns.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async getAuditRunById(id: string, workspaceId: string): Promise<AuditRunRecord | null> {
    const run = this.auditRuns.get(id);
    if (!run || run.workspaceId !== workspaceId) return null;
    return JSON.parse(JSON.stringify(run));
  }

  async getLatestAuditRunByWorkspace(workspaceId: string): Promise<AuditRunRecord | null> {
    const runs = Array.from(this.auditRuns.values())
      .filter(r => r.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return runs.length > 0 ? JSON.parse(JSON.stringify(runs[0])) : null;
  }

  async executeWorkspaceAudit(workspaceId: string): Promise<{ auditRun: AuditRunRecord; catalog: StoragePayloadV1 }> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const runId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      let auditRun = await this.createAuditRun({
        id: runId,
        workspaceId,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
      });

      try {
        let catalog = await this.loadWorkspaceCatalog(workspaceId);
        const store = (await this.getStoreByWorkspace(workspaceId)) || {
          name: 'Store',
          domain: '',
          websiteUrl: '',
          sourceClassification: 'unconfigured' as const,
          shopifyConnected: false,
          currency: 'USD',
          skuCount: 0,
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard' as const,
          tier: 'Free Audit',
          connectors: [],
        };

        if (!catalog) {
          catalog = {
            products: [],
            variants: [],
            offers: [],
            findings: [],
            actions: [],
            evidence: [],
            storeProfile: store,
          };
        }

        // Execute domain rules with server-owned GTIN verification & Shopify provenance context
        const [shopifyConnection, shopifyProvenance] = await Promise.all([
          this.getShopifyConnection(workspaceId),
          this.getShopifyProductProvenance(workspaceId),
        ]);
        const trustedGtinContext = buildTrustedGtinVerificationContext(
          workspaceId,
          catalog.products,
          shopifyConnection,
          shopifyProvenance
        );

        const auditResult = executeCatalogAudit(
          catalog.products,
          catalog.storeProfile || store,
          catalog.actions,
          trustedGtinContext
        );

        // Update catalog with real evaluation results
        const updatedCatalog: StoragePayloadV1 = {
          ...catalog,
          products: auditResult.updatedProducts,
          findings: auditResult.findings,
          actions: auditResult.actionItems,
          evidence: auditResult.updatedProducts.flatMap(p => p.evidenceDocuments || []),
          storeProfile: auditResult.updatedStoreProfile,
        };

        // Persist updated catalog atomically
        await this.saveWorkspaceCatalogInternal(workspaceId, updatedCatalog);
        updatedCatalog.catalogVersion = this.catalogVersions.get(workspaceId);

        // Workstream B: Create immutable historical snapshots for this Audit Run
        const snapshotTime = new Date().toISOString();

        // 1. Snapshot findings
        const historicalFindings: import('../../domain/audit/historicalTypes').HistoricalFindingRecord[] = auditResult.findings.map(f => ({
          id: `hfind_${runId}_${f.id}`,
          auditRunId: runId,
          workspaceId,
          originalFindingId: f.id,
          scope: f.scope,
          productId: f.productId || null,
          productTitle: f.productTitle || null,
          findingType: f.type,
          severity: f.severity,
          title: f.title,
          description: f.description,
          observedEvidence: f.observedEvidence,
          derivedConclusion: f.derivedConclusion,
          merchantVerified: f.merchantVerified,
          whyItMatters: f.whyItMatters,
          suggestedCorrection: f.suggestedCorrection || null,
          targetField: f.targetField || null,
          currentValue: f.currentValue || null,
          recommendedValue: f.recommendedValue || null,
          actionItemId: f.actionItemId || null,
          ruleCode: f.ruleCode || null,
          snapshotCreatedAt: snapshotTime,
        }));

        // 2. Snapshot evidence documents with preserved product associations
        const allEvidenceWithProduct: Array<{ evidence: EvidenceDocument; productId: string | null }> = [];
        if (catalog.evidence) {
          for (const e of catalog.evidence) {
            allEvidenceWithProduct.push({ evidence: e, productId: null });
          }
        }
        for (const p of catalog.products) {
          if (p.evidenceDocuments && p.evidenceDocuments.length > 0) {
            for (const e of p.evidenceDocuments) {
              allEvidenceWithProduct.push({ evidence: e, productId: p.id });
            }
          }
        }
        // Deduplicate evidence by ID, preferring non-null productId
        const evidenceMap = new Map<string, { evidence: EvidenceDocument; productId: string | null }>();
        for (const item of allEvidenceWithProduct) {
          if (item.evidence.id) {
            const existing = evidenceMap.get(item.evidence.id);
            if (!existing || (!existing.productId && item.productId)) {
              evidenceMap.set(item.evidence.id, item);
            }
          }
        }

        const historicalEvidence: import('../../domain/audit/historicalTypes').HistoricalEvidenceRecord[] = Array.from(evidenceMap.values()).map(({ evidence: e, productId }) => ({
          id: `hevid_${runId}_${e.id}`,
          auditRunId: runId,
          workspaceId,
          originalEvidenceId: e.id,
          productId: productId || null,
          title: e.title,
          evidenceType: e.type,
          issuer: e.issuer,
          dateVerified: e.dateVerified,
          url: e.url || null,
          status: e.status || 'unverified',
          sourceType: 'catalog_evidence',
          metadata: {
            evidencePurpose: e.evidencePurpose || 'general',
            verificationSource: e.verificationSource || 'client_submission',
            externalVerificationStatus: e.externalVerificationStatus || 'not_externally_verified',
            verifiedBy: e.verifiedBy || null,
            reviewerPrincipalType: e.reviewerPrincipalType || null,
            reviewerAuthMethod: e.reviewerAuthMethod || null,
            reviewedAt: e.reviewedAt || null,
            decision: e.decision || null,
            decisionReason: e.decisionReason || null,
            externalProviderName: e.externalProviderName || null,
            externalProviderRef: e.externalProviderRef || null,
            externalRequestAt: e.externalRequestAt || null,
            externalResponseAt: e.externalResponseAt || null,
            externalVerificationResult: e.externalVerificationResult || null,
            integrityHash: e.integrityHash || null,
          },
          snapshotCreatedAt: snapshotTime,
        }));

        // 3. Snapshot products and variants
        const historicalProducts: import('../../domain/audit/historicalTypes').HistoricalProductRecord[] = auditResult.updatedProducts.map(p => ({
          id: `hprod_${runId}_${p.id}`,
          auditRunId: runId,
          workspaceId,
          productId: p.id,
          title: p.title,
          brand: p.brand,
          category: p.category,
          description: p.description,
          image: p.image,
          completenessScore: p.completenessScore,
          attributes: JSON.parse(JSON.stringify(p.attributes || {})),
          variants: JSON.parse(JSON.stringify(p.variants || [])),
          offers: JSON.parse(JSON.stringify(p.offers || [])),
          findingsCount: p.findingsCount,
          snapshotCreatedAt: snapshotTime,
        }));

        // Store immutable snapshots
        this.auditRunFindings.set(runId, JSON.parse(JSON.stringify(historicalFindings)));
        this.auditRunEvidence.set(runId, JSON.parse(JSON.stringify(historicalEvidence)));
        this.auditRunProducts.set(runId, JSON.parse(JSON.stringify(historicalProducts)));
        this.auditRunManifests.set(runId, {
          auditRunId: runId,
          workspaceId,
          status: 'COMPLETED',
          productsCount: historicalProducts.length,
          findingsCount: historicalFindings.length,
          evidenceCount: historicalEvidence.length,
          createdAt: snapshotTime,
        });

        // Mark audit run as completed only AFTER required snapshots have been saved successfully
        auditRun = await this.updateAuditRun(runId, {
          status: 'COMPLETED',
          productsEvaluated: auditResult.summary.totalProducts,
          rulesEvaluated: auditResult.summary.rulesEvaluated,
          findingsCount: auditResult.summary.totalFindingsCount,
          summary: auditResult.summary,
          metadata: {
            rules: Object.keys(auditResult.summary.ruleBreakdown),
            completedAt: new Date().toISOString(),
            snapshotAvailable: true,
          },
          completedAt: new Date().toISOString(),
        });

        return {
          auditRun,
          catalog: updatedCatalog,
        };
      } catch (err: any) {
        await this.updateAuditRun(runId, {
          status: 'FAILED',
          errorMessage: err?.message || 'Catalog audit execution failed',
          completedAt: new Date().toISOString(),
        });
        throw err;
      }
    });
  }

  async getAuditRunsHistory(
    workspaceId: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ items: Array<AuditRunRecord & { snapshotAvailable: boolean }>; nextCursor: string | null; totalCount: number }> {
    const limit = Math.min(Math.max(options?.limit || 20, 1), 100);
    const runs = Array.from(this.auditRuns.values())
      .filter(r => r.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalCount = runs.length;

    let startIndex = 0;
    if (options?.cursor) {
      const idx = runs.findIndex(r => r.id === options.cursor);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    const pagedRuns = runs.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < runs.length ? pagedRuns[pagedRuns.length - 1].id : null;

    const items = pagedRuns.map(run => {
      const hasSnapshot = this.auditRunManifests.has(run.id) || run.metadata?.snapshotAvailable === true;
      return {
        ...JSON.parse(JSON.stringify(run)),
        snapshotAvailable: Boolean(hasSnapshot),
      };
    });

    return {
      items,
      nextCursor,
      totalCount,
    };
  }

  async getHistoricalAuditSnapshot(
    workspaceId: string,
    auditRunId: string
  ): Promise<import('../../domain/audit/historicalTypes').HistoricalAuditSnapshot | null> {
    const auditRun = await this.getAuditRunById(auditRunId, workspaceId);
    if (!auditRun) return null;

    const hasManifest = this.auditRunManifests.has(auditRunId) || auditRun.metadata?.snapshotAvailable === true;
    const findings = this.auditRunFindings.get(auditRunId);
    const evidence = this.auditRunEvidence.get(auditRunId);
    const products = this.auditRunProducts.get(auditRunId);

    if (!hasManifest && (!findings || findings.length === 0) && (!products || products.length === 0)) {
      return {
        auditRun,
        findings: [],
        evidence: [],
        products: [],
        snapshotAvailable: false,
        message: 'Historical snapshot unavailable — this audit was created before Audit History & Evidence was implemented.',
      };
    }

    return {
      auditRun,
      findings: findings ? JSON.parse(JSON.stringify(findings)) : [],
      evidence: evidence ? JSON.parse(JSON.stringify(evidence)) : [],
      products: products ? JSON.parse(JSON.stringify(products)) : [],
      snapshotAvailable: true,
    };
  }

  async compareHistoricalAudits(
    workspaceId: string,
    baseAuditId: string,
    targetAuditId: string
  ): Promise<import('../../domain/audit/historicalTypes').AuditComparisonResult | null> {
    const baseSnapshot = await this.getHistoricalAuditSnapshot(workspaceId, baseAuditId);
    const targetSnapshot = await this.getHistoricalAuditSnapshot(workspaceId, targetAuditId);

    if (!baseSnapshot || !targetSnapshot) return null;

    const { compareHistoricalAudits } = await import('../../domain/audit/comparisonService');
    return compareHistoricalAudits(
      baseSnapshot.auditRun,
      baseSnapshot.findings,
      targetSnapshot.auditRun,
      targetSnapshot.findings
    );
  }

  // ==========================================
  // Workstream C: Shopify Integration Methods
  // ==========================================

  async getShopifyConnection(workspaceId: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null> {
    const conn = this.shopifyConnections.get(workspaceId);
    return conn ? JSON.parse(JSON.stringify(conn)) : null;
  }

  async getShopifyConnectionByShop(shopDomain: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null> {
    const normShop = shopDomain.trim().toLowerCase();
    for (const conn of this.shopifyConnections.values()) {
      if (conn.shopDomain.toLowerCase() === normShop) {
        return JSON.parse(JSON.stringify(conn));
      }
    }
    return null;
  }

  async saveShopifyConnection(conn: import('../shopify/types').ShopifyConnectionRecord): Promise<import('../shopify/types').ShopifyConnectionRecord> {
    const copy = JSON.parse(JSON.stringify(conn));
    copy.updatedAt = new Date().toISOString();
    this.shopifyConnections.set(conn.workspaceId, copy);
    return JSON.parse(JSON.stringify(copy));
  }

  async deleteShopifyConnection(workspaceId: string): Promise<void> {
    const conn = this.shopifyConnections.get(workspaceId);
    if (conn) {
      conn.status = 'disconnected';
      conn.accessTokenEncrypted = '';
      conn.refreshTokenEncrypted = null;
      conn.updatedAt = new Date().toISOString();
    }
  }

  async saveShopifyOAuthState(state: { id: string; workspaceId: string; shopDomain: string; expiresAt: string }): Promise<void> {
    this.shopifyOAuthStates.set(state.id, {
      ...state,
      createdAt: new Date().toISOString(),
    });
  }

  async getAndConsumeShopifyOAuthState(stateId: string): Promise<{ id: string; workspaceId: string; shopDomain: string; expiresAt: string } | null> {
    const state = this.shopifyOAuthStates.get(stateId);
    if (!state) return null;
    this.shopifyOAuthStates.delete(stateId);
    return state;
  }

  async createShopifySyncRun(run: import('../shopify/types').ShopifySyncRunRecord): Promise<import('../shopify/types').ShopifySyncRunRecord> {
    const copy = JSON.parse(JSON.stringify(run));
    this.shopifySyncRuns.set(run.id, copy);
    return JSON.parse(JSON.stringify(copy));
  }

  async updateShopifySyncRun(
    id: string,
    workspaceId: string,
    updates: Partial<import('../shopify/types').ShopifySyncRunRecord>
  ): Promise<import('../shopify/types').ShopifySyncRunRecord> {
    const existing = this.shopifySyncRuns.get(id);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new Error(`ShopifySyncRun ${id} not found for workspace ${workspaceId}.`);
    }
    const updated = {
      ...existing,
      ...JSON.parse(JSON.stringify(updates)),
      id: existing.id,
      workspaceId: existing.workspaceId,
      updatedAt: new Date().toISOString(),
    };
    this.shopifySyncRuns.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async getShopifySyncRunById(id: string, workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null> {
    const run = this.shopifySyncRuns.get(id);
    if (!run || run.workspaceId !== workspaceId) return null;
    return JSON.parse(JSON.stringify(run));
  }

  async getLatestShopifySyncRun(workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null> {
    const runs = Array.from(this.shopifySyncRuns.values())
      .filter(r => r.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return runs[0] ? JSON.parse(JSON.stringify(runs[0])) : null;
  }

  async getShopifySyncRuns(workspaceId: string, limit = 20): Promise<import('../shopify/types').ShopifySyncRunRecord[]> {
    const runs = Array.from(this.shopifySyncRuns.values())
      .filter(r => r.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
    return JSON.parse(JSON.stringify(runs));
  }

  async claimShopifyWebhookEvent(
    event: import('../shopify/types').ShopifyWebhookEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<import('../shopify/types').ShopifyWebhookClaimResult> {
    const key = `${event.shopDomain}:${event.topic}:${event.eventId}`;
    const existing = this.shopifyWebhookEvents.get(key);
    const now = Date.now();
    const leaseDurationMs = Math.max(50, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `wh_worker_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();

    if (existing) {
      const existingExpired =
        existing.status === 'processing' &&
        (existing.leaseExpiresAt
          ? new Date(existing.leaseExpiresAt).getTime() < now
          : new Date(existing.updatedAt).getTime() < now - 5 * 60 * 1000);

      if (existing.status === 'failed' || existingExpired) {
        const reclaimed: import('../shopify/types').ShopifyWebhookEventRecord = {
          ...existing,
          payload: event.payload || existing.payload,
          deliveryId: event.deliveryId ?? existing.deliveryId,
          status: 'processing',
          leaseOwner,
          leaseExpiresAt,
          attemptCount: (existing.attemptCount ?? existing.retryCount ?? 1) + 1,
          retryCount: (existing.retryCount ?? 0) + 1,
          updatedAt: new Date(now).toISOString(),
        };
        this.shopifyWebhookEvents.set(key, reclaimed);
        return {
          claimed: true,
          outcome: existing.status === 'failed' ? 'RETRYABLE_FAILED' : 'CLAIMED',
          leaseOwner,
          event: JSON.parse(JSON.stringify(reclaimed)),
        };
      }

      if (existing.status === 'processing') {
        return {
          claimed: false,
          outcome: 'CURRENTLY_PROCESSING',
          event: JSON.parse(JSON.stringify(existing)),
        };
      }

      return {
        claimed: false,
        outcome: 'ALREADY_PROCESSED',
        event: JSON.parse(JSON.stringify(existing)),
      };
    }

    const copy: import('../shopify/types').ShopifyWebhookEventRecord = {
      ...JSON.parse(JSON.stringify(event)),
      status: 'processing',
      leaseOwner,
      leaseExpiresAt,
      attemptCount: 1,
    };
    this.shopifyWebhookEvents.set(key, copy);
    return {
      claimed: true,
      outcome: 'CLAIMED',
      leaseOwner,
      event: JSON.parse(JSON.stringify(copy)),
    };
  }

  async updateShopifyWebhookEventStatus(
    eventId: string,
    shopDomain: string,
    topic: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    error?: string,
    leaseOwner?: string
  ): Promise<void> {
    const key = `${shopDomain}:${topic}:${eventId}`;
    const existing = this.shopifyWebhookEvents.get(key);
    if (!existing) return;

    if (leaseOwner) {
      const now = Date.now();
      const expired = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt).getTime() < now : false;
      if (existing.status !== 'processing' || existing.leaseOwner !== leaseOwner || expired) {
        throw new Error(
          `Shopify webhook lease lost or expired for event ${eventId}: stale worker "${leaseOwner}" rejected.`
        );
      }
    }

    existing.status = status;
    if (status !== 'processing') {
      existing.leaseExpiresAt = null;
    }
    if (error !== undefined) existing.lastError = error;
    if (status === 'processed') existing.processedAt = new Date().toISOString();
    existing.updatedAt = new Date().toISOString();
  }

  private shopifyRefreshLocks = new Map<string, Promise<any>>();

  async withShopifyRefreshLock<T>(
    workspaceId: string,
    fn: (
      connection: import('../shopify/types').ShopifyConnectionRecord,
      saveConnection: (conn: import('../shopify/types').ShopifyConnectionRecord) => Promise<import('../shopify/types').ShopifyConnectionRecord>
    ) => Promise<T>
  ): Promise<T> {
    const prevLock = this.shopifyRefreshLocks.get(workspaceId) || Promise.resolve();
    let releaseCurrent: () => void;
    const currentPromise = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    const chainTail = prevLock.catch(() => {}).then(() => currentPromise);
    this.shopifyRefreshLocks.set(workspaceId, chainTail);

    try {
      await prevLock.catch(() => {});
      const connection = await this.getShopifyConnection(workspaceId);
      if (!connection) {
        throw new Error(`[AIXSHOP Shopify Refresh] No Shopify connection found for workspace ${workspaceId}.`);
      }
      const saveConnection = async (conn: import('../shopify/types').ShopifyConnectionRecord) => {
        return this.saveShopifyConnection(conn);
      };
      return await fn(connection, saveConnection);
    } finally {
      releaseCurrent!();
      if (this.shopifyRefreshLocks.get(workspaceId) === chainTail) {
        this.shopifyRefreshLocks.delete(workspaceId);
      }
    }
  }

  private businessProfiles = new Map<string, import('../../domain/businessProfile/types').WorkspaceBusinessProfile>();
  private visibilityImports = new Map<string, import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord>();
  private visibilityMetrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[] = [];

  async getWorkspaceBusinessProfile(workspaceId: string): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile | null> {
    const profile = this.businessProfiles.get(workspaceId);
    return profile ? JSON.parse(JSON.stringify(profile)) : null;
  }

  async saveWorkspaceBusinessProfile(profile: import('../../domain/businessProfile/types').WorkspaceBusinessProfile): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile> {
    const copy = {
      ...profile,
      updatedAt: new Date().toISOString(),
      createdAt: profile.createdAt || new Date().toISOString(),
    };
    this.businessProfiles.set(profile.workspaceId, JSON.parse(JSON.stringify(copy)));
    return copy;
  }

  async saveVisibilityImport(record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord> {
    const copy = {
      ...JSON.parse(JSON.stringify(record)),
      contentHash: record.contentHash ?? null,
      status: record.status || 'completed',
      rejectedRowCount: record.rejectedRowCount ?? 0,
      errors: record.errors ? JSON.parse(JSON.stringify(record.errors)) : [],
      createdAt: record.createdAt || new Date().toISOString(),
    };
    this.visibilityImports.set(record.id, copy);
    return JSON.parse(JSON.stringify(copy));
  }

  async getVisibilityImportByHash(
    workspaceId: string,
    contentHash: string
  ): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord | null> {
    if (!contentHash) return null;
    const matches = Array.from(this.visibilityImports.values())
      .filter(
        (imp) =>
          imp.workspaceId === workspaceId &&
          imp.contentHash === contentHash &&
          (imp.status || 'completed') === 'completed'
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return matches[0] ? JSON.parse(JSON.stringify(matches[0])) : null;
  }

  private visibilityObservationHistory: VisibilityObservationHistoryRecord[] = [];
  private visibilityKeyLocks: Map<string, Promise<unknown>> = new Map();

  private async withVisibilityKeysLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    if (keys.length === 0) {
      return await fn();
    }
    const sortedKeys = Array.from(new Set(keys)).sort();
    const releases: Array<() => void> = [];
    const tails: Array<{ key: string; tail: Promise<void> }> = [];

    for (const key of sortedKeys) {
      const prevLock = this.visibilityKeyLocks.get(key) || Promise.resolve();
      let releaseCurrent: () => void;
      const currentTurnPromise = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const tail = prevLock.catch(() => {}).then(() => currentTurnPromise);
      this.visibilityKeyLocks.set(key, tail);
      tails.push({ key, tail });
      await prevLock.catch(() => {});
      releases.push(releaseCurrent!);
    }

    try {
      return await fn();
    } finally {
      for (const rel of releases.reverse()) {
        rel();
      }
      for (const { key, tail } of tails) {
        if (this.visibilityKeyLocks.get(key) === tail) {
          this.visibilityKeyLocks.delete(key);
        }
      }
    }
  }

  private resolveTopicKey(metric: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord): {
    topicValue: string | null;
    topicPresence: TopicPresenceState;
  } {
    if (metric.discoveryTopic === null || metric.discoveryTopic === undefined) {
      return { topicValue: null, topicPresence: metric.topicPresence || 'unspecified' };
    }
    if (metric.discoveryTopic === '') {
      return { topicValue: '', topicPresence: metric.topicPresence || 'explicit_blank' };
    }
    return { topicValue: metric.discoveryTopic, topicPresence: metric.topicPresence || 'specified' };
  }

  private buildCanonicalVisibilityLockKey(metric: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord): string {
    const { topicValue } = this.resolveTopicKey(metric);
    const topicPart = topicValue === null ? '__NULL__' : `STR:${topicValue}`;
    return `${metric.workspaceId}::${metric.observationDate}::${metric.platform}::${topicPart}`;
  }

  async saveVisibilityMetrics(metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]): Promise<void> {
    for (const m of metrics) {
      const { topicValue, topicPresence } = this.resolveTopicKey(m);
      const idx = this.visibilityMetrics.findIndex(
        (existing) => {
          const exKey = this.resolveTopicKey(existing);
          return (
            existing.workspaceId === m.workspaceId &&
            existing.observationDate === m.observationDate &&
            existing.platform === m.platform &&
            exKey.topicValue === topicValue &&
            exKey.topicPresence === topicPresence
          );
        }
      );
      const copy = { ...JSON.parse(JSON.stringify(m)), discoveryTopic: topicValue, topicPresence };
      if (idx >= 0) {
        this.visibilityMetrics[idx] = copy;
      } else {
        this.visibilityMetrics.push(copy);
      }
    }
  }

  async saveVisibilityImportAtomic(
    record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord,
    metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[],
    options: { conflictPolicy?: VisibilityConflictPolicy } = {}
  ): Promise<{
    importRecord: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord;
    metricsSaved: number;
    duplicateImport?: boolean;
    replacedCount?: number;
  }> {
    const policy: VisibilityConflictPolicy = options.conflictPolicy || 'reject_on_conflict';
    const lockKeys = [
      ...(record.contentHash ? [`hash::${record.workspaceId}::${record.contentHash}`] : []),
      ...metrics.map((m) => this.buildCanonicalVisibilityLockKey(m)),
    ];

    return this.withVisibilityKeysLock(lockKeys, async () => {
      // Atomic duplicate hash check across concurrent callers
      if (record.contentHash && (record.status || 'completed') === 'completed') {
        const existingDup = await this.getVisibilityImportByHash(record.workspaceId, record.contentHash);
        if (existingDup) {
          return { importRecord: existingDup, metricsSaved: 0, duplicateImport: true };
        }
      }

    const prevImports = new Map(this.visibilityImports);
    const prevMetrics = JSON.parse(JSON.stringify(this.visibilityMetrics));
    const prevHistory = JSON.parse(JSON.stringify(this.visibilityObservationHistory));

    try {
      const conflicts: VisibilityObservationConflict[] = [];
      let replacedCount = 0;

      for (const m of metrics) {
        const { topicValue, topicPresence } = this.resolveTopicKey(m);
        const existingMetric = this.visibilityMetrics.find((ex) => {
          const exKey = this.resolveTopicKey(ex);
          return (
            ex.workspaceId === m.workspaceId &&
            ex.observationDate === m.observationDate &&
            ex.platform === m.platform &&
            exKey.topicValue === topicValue &&
            exKey.topicPresence === topicPresence
          );
        });

        if (existingMetric && existingMetric.importId !== record.id) {
          if (policy === 'reject_on_conflict') {
            conflicts.push({
              observationDate: m.observationDate,
              platform: m.platform,
              discoveryTopic: topicValue,
              topicPresence,
              existingImportId: existingMetric.importId || null,
              existingValues: {
                brandMentions: existingMetric.brandMentions,
                productMentions: existingMetric.productMentions,
                websiteClicks: existingMetric.websiteClicks,
              },
              incomingValues: {
                brandMentions: m.brandMentions,
                productMentions: m.productMentions,
                websiteClicks: m.websiteClicks,
              },
            });
          } else {
            replacedCount++;
          }
        }
      }

      if (conflicts.length > 0) {
        throw new VisibilityObservationConflictError(conflicts);
      }

      const savedImport = await this.saveVisibilityImport(record);

      for (const m of metrics) {
        const { topicValue, topicPresence } = this.resolveTopicKey(m);
        const existingHistory = this.visibilityObservationHistory
          .filter((h) => {
            const hKey = h.discoveryTopic ?? null;
            return (
              h.workspaceId === m.workspaceId &&
              h.observationDate === m.observationDate &&
              h.platform === m.platform &&
              hKey === topicValue &&
              h.topicPresence === topicPresence
            );
          })
          .sort((a, b) => a.versionNumber - b.versionNumber);
        const maxVer = existingHistory.reduce((max, h) => Math.max(max, h.versionNumber), 0);
        const lastHist = existingHistory[existingHistory.length - 1];

        this.visibilityObservationHistory.push({
          id: `vhist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          workspaceId: m.workspaceId,
          importId: savedImport.id,
          observationDate: m.observationDate,
          platform: m.platform,
          discoveryTopic: topicValue,
          topicPresence,
          brandMentions: m.brandMentions,
          productMentions: m.productMentions,
          websiteClicks: m.websiteClicks,
          evidenceSource: m.evidenceSource || null,
          eventType: maxVer > 0 ? 'replaced' : 'recorded',
          versionNumber: maxVer + 1,
          supersedesHistoryId: lastHist ? lastHist.id : null,
          createdAt: new Date().toISOString(),
        });
      }

      await this.saveVisibilityMetrics(metrics);
      return {
        importRecord: savedImport,
        metricsSaved: metrics.length,
        duplicateImport: false,
        replacedCount,
      };
    } catch (err) {
      this.visibilityImports = prevImports;
      this.visibilityMetrics = prevMetrics;
      this.visibilityObservationHistory = prevHistory;
      throw err;
    }
    });
  }

  async getVisibilityObservationHistory(
    workspaceId: string,
    limit = 100
  ): Promise<VisibilityObservationHistoryRecord[]> {
    return JSON.parse(
      JSON.stringify(
        this.visibilityObservationHistory
          .filter((h) => h.workspaceId === workspaceId)
          .slice(-limit)
          .reverse()
      )
    );
  }

  async getVisibilitySummary(workspaceId: string): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilitySummary> {
    const wsMetrics = this.visibilityMetrics.filter(m => m.workspaceId === workspaceId);
    const wsImports = Array.from(this.visibilityImports.values()).filter(i => i.workspaceId === workspaceId);

    if (wsMetrics.length === 0 && wsImports.length === 0) {
      return {
        connected: false,
        status: 'DATA_SOURCE_NOT_CONNECTED',
        message: 'DATA SOURCE NOT CONNECTED - No official AI platform analytics API or verified telemetry connected',
        totalBrandMentions: 0,
        totalProductMentions: 0,
        totalWebsiteClicks: 0,
        platforms: [],
        recentObservations: [],
        imports: [],
      };
    }

    let totalBrandMentions = 0;
    let totalProductMentions = 0;
    let totalWebsiteClicks = 0;
    const platformMap = new Map<string, { mentions: number; clicks: number }>();

    for (const m of wsMetrics) {
      totalBrandMentions += m.brandMentions || 0;
      totalProductMentions += m.productMentions || 0;
      totalWebsiteClicks += m.websiteClicks || 0;

      const plat = platformMap.get(m.platform) || { mentions: 0, clicks: 0 };
      plat.mentions += (m.brandMentions || 0) + (m.productMentions || 0);
      plat.clicks += (m.websiteClicks || 0);
      platformMap.set(m.platform, plat);
    }

    const platforms = Array.from(platformMap.entries()).map(([platform, data]) => ({
      platform,
      mentions: data.mentions,
      clicks: data.clicks,
    }));

    const sortedObservations = [...wsMetrics].sort(
      (a, b) => new Date(b.observationDate).getTime() - new Date(a.observationDate).getTime()
    );

    return {
      connected: true,
      status: 'CONNECTED',
      message: 'Merchant-verified AI discovery analytics active',
      totalBrandMentions,
      totalProductMentions,
      totalWebsiteClicks,
      platforms,
      recentObservations: sortedObservations.slice(0, 50),
      imports: wsImports,
    };
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.passwordHash = passwordHash;
      user.updatedAt = new Date().toISOString();
    }
  }

  async createPasswordResetToken(data: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
    requestedIp?: string;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    // Invalidate any prior unused reset tokens for this user
    for (const token of this.passwordResetTokens.values()) {
      if (token.userId === data.userId && token.usedAt === null) {
        token.usedAt = nowIso;
      }
    }
    this.passwordResetTokens.set(data.tokenHash, {
      id: data.id,
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      usedAt: null,
      requestedIp: data.requestedIp,
      createdAt: nowIso,
    });
  }

  async invalidatePasswordResetToken(tokenId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    for (const token of this.passwordResetTokens.values()) {
      if (token.id === tokenId && token.usedAt === null) {
        token.usedAt = nowIso;
      }
    }
  }

  async consumePasswordResetTokenAndUpdatePassword(
    tokenHash: string,
    newPasswordHash: string
  ): Promise<{ userId: string } | null> {
    const record = this.passwordResetTokens.get(tokenHash);
    if (!record || record.usedAt !== null) {
      return null;
    }
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    const user = this.users.get(record.userId);
    if (!user) {
      return null;
    }
    const nowIso = new Date().toISOString();
    record.usedAt = nowIso;
    for (const token of this.passwordResetTokens.values()) {
      if (token.userId === record.userId && token.usedAt === null) {
        token.usedAt = nowIso;
      }
    }
    user.passwordHash = newPasswordHash;
    user.updatedAt = nowIso;
    await this.deleteUserSessions(record.userId);
    return { userId: record.userId };
  }

  async acquireWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string,
    ttlMs: number
  ): Promise<{ acquired: boolean; leaseOwner?: string; expiresAt?: string }> {
    const key = `${workspaceId}::${operationKey}`;
    const now = Date.now();
    const safeTtlMs = Math.max(1000, ttlMs);
    const existing = this.workspaceOperationLeases.get(key);

    if (existing && existing.leaseExpiresAt > now && existing.leaseOwner !== leaseOwner) {
      return {
        acquired: false,
        leaseOwner: existing.leaseOwner,
        expiresAt: new Date(existing.leaseExpiresAt).toISOString(),
      };
    }

    const leaseExpiresAt = now + safeTtlMs;
    this.workspaceOperationLeases.set(key, {
      workspaceId,
      operationKey,
      leaseOwner,
      leaseExpiresAt,
    });
    return {
      acquired: true,
      leaseOwner,
      expiresAt: new Date(leaseExpiresAt).toISOString(),
    };
  }

  async releaseWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string
  ): Promise<void> {
    const key = `${workspaceId}::${operationKey}`;
    const existing = this.workspaceOperationLeases.get(key);
    if (existing && existing.leaseOwner === leaseOwner) {
      this.workspaceOperationLeases.delete(key);
    }
  }

  // ==========================================
  // GTIN Evidence Verification & Shopify Provenance (Migration 015)
  // ==========================================

  async submitEvidenceDocument(params: {
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
  }): Promise<{ evidence: EvidenceDocument; catalogVersion?: number }> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(params.workspaceId);
      if (!catalog) {
        const err: any = new Error(`Workspace ${params.workspaceId} catalog not found`);
        err.statusCode = 404;
        err.code = 'CATALOG_NOT_FOUND';
        throw err;
      }

      const targetProduct = catalog.products.find(p => p.id === params.productId);
      if (!targetProduct) {
        const err: any = new Error(`Product "${params.productId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'PRODUCT_NOT_FOUND';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const id =
        params.id?.trim() ||
        `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const purpose: EvidencePurpose =
        params.evidencePurpose === 'gtin_exemption' ||
        params.evidencePurpose === 'product_claim' ||
        params.evidencePurpose === 'general'
          ? params.evidencePurpose
          : 'general';

      // Enforce client submissions strictly start as pending/unverified
      const newDoc: EvidenceDocument = {
        id,
        title: String(params.title || '').trim(),
        type: params.type,
        issuer: String(params.issuer || '').trim(),
        dateVerified: String(params.dateVerified || '').trim(),
        url: params.url ? String(params.url).trim() : undefined,
        status: 'pending',
        evidencePurpose: purpose,
        verificationSource: 'client_submission',
        externalVerificationStatus: 'not_externally_verified',
        submittedByUserId: params.submittedByUserId,
        decision: 'pending',
        createdAt: nowIso,
      };
      newDoc.integrityHash = computeEvidenceIntegrityHash(params.workspaceId, params.productId, newDoc);

      const nextProducts = catalog.products.map(p => {
        if (p.id !== params.productId) return p;
        const filtered = (p.evidenceDocuments || []).filter(d => d.id !== id);
        return {
          ...p,
          evidenceDocuments: [...filtered, newDoc],
        };
      });

      const updatedCatalog: StoragePayloadV1 = {
        ...catalog,
        products: nextProducts,
        evidence: nextProducts.flatMap(p => p.evidenceDocuments || []),
      };
      await this.saveWorkspaceCatalogInternal(params.workspaceId, updatedCatalog);

      const logList = this.evidenceReviewAuditLog.get(params.workspaceId) || [];
      logList.push({
        id: `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: params.workspaceId,
        evidenceId: id,
        productId: params.productId,
        action: 'submitted',
        decision: 'pending',
        reviewerId: params.submittedByUserId,
        reviewerRole: 'merchant_submitter',
        principalType: 'merchant_submitter',
        authMethod: 'workspace_session',
        integrityHash: newDoc.integrityHash,
        metadata: {
          evidencePurpose: purpose,
          verificationSource: 'client_submission',
          externalVerificationStatus: 'not_externally_verified',
        },
        createdAt: nowIso,
      });
      this.evidenceReviewAuditLog.set(params.workspaceId, logList);

      return {
        evidence: JSON.parse(JSON.stringify(newDoc)),
        catalogVersion: this.catalogVersions.get(params.workspaceId),
      };
    });
  }

  async getEvidenceDocumentById(
    workspaceId: string,
    evidenceId: string
  ): Promise<{ evidence: EvidenceDocument; productId: string; product?: Product } | null> {
    const catalog = await this.loadWorkspaceCatalog(workspaceId);
    if (!catalog) return null;
    for (const p of catalog.products) {
      const match = (p.evidenceDocuments || []).find(d => d.id === evidenceId);
      if (match) {
        return {
          evidence: JSON.parse(JSON.stringify(match)),
          productId: p.id,
          product: JSON.parse(JSON.stringify(p)),
        };
      }
    }
    return null;
  }

  async reviewEvidenceDocument(params: {
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
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(params.workspaceId);
      if (!catalog) {
        const err: any = new Error(`Workspace ${params.workspaceId} catalog not found`);
        err.statusCode = 404;
        err.code = 'CATALOG_NOT_FOUND';
        throw err;
      }

      let foundProduct: Product | undefined;
      let foundDoc: EvidenceDocument | undefined;
      for (const p of catalog.products) {
        const match = (p.evidenceDocuments || []).find(d => d.id === params.evidenceId);
        if (match) {
          foundProduct = p;
          foundDoc = match;
          break;
        }
      }

      if (!foundProduct || !foundDoc) {
        const err: any = new Error(`Evidence document "${params.evidenceId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'EVIDENCE_NOT_FOUND';
        throw err;
      }

      const expectedHash = computeEvidenceIntegrityHash(params.workspaceId, foundProduct.id, foundDoc);
      if (foundDoc.integrityHash && foundDoc.integrityHash !== expectedHash) {
        const err: any = new Error(
          `Evidence document "${params.evidenceId}" integrity hash mismatch: content may have been altered.`
        );
        err.statusCode = 409;
        err.code = 'EVIDENCE_INTEGRITY_MISMATCH';
        throw err;
      }

      const nowIso = new Date().toISOString();
      // Reviewer action is ALWAYS 'server_reviewer' and NEVER elevates to 'external_registry_verified'
      const source: 'server_reviewer' = 'server_reviewer';
      const externalStatus: ExternalVerificationStatus =
        params.decision === 'approved' ? 'reviewer_verified' : 'not_externally_verified';
      const principalType: ReviewerPrincipalType = params.principalType || 'service_principal';
      const authMethod = params.authMethod || 'platform_service_secret';
      const effectiveDateVerified = foundDoc.dateVerified || nowIso;
      const updatedIntegrityHash = computeEvidenceIntegrityHash(params.workspaceId, foundProduct.id, {
        ...foundDoc,
        dateVerified: effectiveDateVerified,
      });
      const updatedDoc: EvidenceDocument = {
        ...foundDoc,
        status: params.decision === 'approved' ? 'verified' : 'rejected',
        decision: params.decision,
        decisionReason: params.reason,
        verificationSource: source,
        externalVerificationStatus: externalStatus,
        verifiedBy: params.reviewerId,
        reviewerPrincipalType: principalType,
        reviewerAuthMethod: authMethod,
        reviewedAt: nowIso,
        dateVerified: effectiveDateVerified,
        integrityHash: updatedIntegrityHash,
      };

      const nextProducts = catalog.products.map(p => {
        if (p.id !== foundProduct!.id) return p;
        return {
          ...p,
          evidenceDocuments: (p.evidenceDocuments || []).map(d =>
            d.id === params.evidenceId ? updatedDoc : d
          ),
        };
      });

      const updatedCatalog: StoragePayloadV1 = {
        ...catalog,
        products: nextProducts,
        evidence: nextProducts.flatMap(p => p.evidenceDocuments || []),
      };
      await this.saveWorkspaceCatalogInternal(params.workspaceId, updatedCatalog);

      const auditEntry: EvidenceReviewAuditEntry = {
        id: `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: params.workspaceId,
        evidenceId: foundDoc.id,
        productId: foundProduct.id,
        action: params.decision === 'approved' ? 'approved' : 'rejected',
        decision: params.decision,
        reviewerId: params.reviewerId,
        reviewerRole: params.reviewerRole,
        principalType,
        authMethod,
        reason: params.reason,
        integrityHash: updatedIntegrityHash,
        metadata: {
          evidencePurpose: updatedDoc.evidencePurpose || 'general',
          verificationSource: source,
          externalVerificationStatus: externalStatus,
          previousStatus: foundDoc.status,
          ...(params.claimedReviewerId ? { claimedReviewerId: params.claimedReviewerId } : {}),
        },
        createdAt: nowIso,
      };

      const logList = this.evidenceReviewAuditLog.get(params.workspaceId) || [];
      logList.push(auditEntry);
      this.evidenceReviewAuditLog.set(params.workspaceId, logList);

      return {
        evidence: JSON.parse(JSON.stringify(updatedDoc)),
        auditEntry: JSON.parse(JSON.stringify(auditEntry)),
        catalogVersion: this.catalogVersions.get(params.workspaceId),
      };
    });
  }

  async recordExternalRegistryVerification(params: {
    workspaceId: string;
    evidenceId: string;
    initiatedByReviewerId: string;
    initiatedByPrincipalType: ReviewerPrincipalType;
    initiatedByAuthMethod: string;
    claimedReviewerId?: string;
    evaluation: ExternalRegistryVerificationEvaluation;
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(params.workspaceId);
      if (!catalog) {
        const err: any = new Error(`Workspace ${params.workspaceId} catalog not found`);
        err.statusCode = 404;
        err.code = 'CATALOG_NOT_FOUND';
        throw err;
      }

      let foundProduct: Product | undefined;
      let foundDoc: EvidenceDocument | undefined;
      for (const p of catalog.products) {
        const match = (p.evidenceDocuments || []).find(d => d.id === params.evidenceId);
        if (match) {
          foundProduct = p;
          foundDoc = match;
          break;
        }
      }

      if (!foundProduct || !foundDoc) {
        const err: any = new Error(`Evidence document "${params.evidenceId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'EVIDENCE_NOT_FOUND';
        throw err;
      }

      const expectedHash = computeEvidenceIntegrityHash(params.workspaceId, foundProduct.id, foundDoc);
      if (foundDoc.integrityHash && foundDoc.integrityHash !== expectedHash) {
        const err: any = new Error(
          `Evidence document "${params.evidenceId}" integrity hash mismatch: content may have been altered.`
        );
        err.statusCode = 409;
        err.code = 'EVIDENCE_INTEGRITY_MISMATCH';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const evalRes = params.evaluation;
      let updatedDoc: EvidenceDocument;

      if (evalRes.verified) {
        const effectiveDateVerified = foundDoc.dateVerified || nowIso;
        const updatedIntegrityHash = computeEvidenceIntegrityHash(params.workspaceId, foundProduct.id, {
          ...foundDoc,
          dateVerified: effectiveDateVerified,
        });
        updatedDoc = {
          ...foundDoc,
          status: 'verified',
          decision: 'approved',
          decisionReason: evalRes.reason,
          verificationSource: 'external_registry',
          externalVerificationStatus: 'external_registry_verified',
          verifiedBy: evalRes.providerName || params.initiatedByReviewerId,
          reviewerPrincipalType: 'external_registry_provider',
          reviewerAuthMethod: 'external_registry_adapter',
          reviewedAt: evalRes.responseAt || nowIso,
          dateVerified: effectiveDateVerified,
          externalProviderName: evalRes.providerName,
          externalProviderRef: evalRes.providerRef,
          externalRequestAt: evalRes.requestAt,
          externalResponseAt: evalRes.responseAt,
          externalVerificationResult: evalRes.outcome,
          externalVerificationEvidence: evalRes.sanitizedEvidence,
          integrityHash: updatedIntegrityHash,
        };
      } else {
        // Never elevate verification status on failed, mismatched, ambiguous, or timed-out external lookups
        updatedDoc = {
          ...foundDoc,
          externalProviderName: evalRes.providerName || foundDoc.externalProviderName,
          externalProviderRef: evalRes.providerRef || foundDoc.externalProviderRef,
          externalRequestAt: evalRes.requestAt || nowIso,
          externalResponseAt: evalRes.responseAt || nowIso,
          externalVerificationResult: evalRes.outcome,
          externalVerificationStatus:
            foundDoc.externalVerificationStatus === 'reviewer_verified'
              ? 'reviewer_verified'
              : 'not_externally_verified',
        };
      }

      const nextProducts = catalog.products.map(p => {
        if (p.id !== foundProduct!.id) return p;
        return {
          ...p,
          evidenceDocuments: (p.evidenceDocuments || []).map(d =>
            d.id === params.evidenceId ? updatedDoc : d
          ),
        };
      });

      const updatedCatalog: StoragePayloadV1 = {
        ...catalog,
        products: nextProducts,
        evidence: nextProducts.flatMap(p => p.evidenceDocuments || []),
      };
      await this.saveWorkspaceCatalogInternal(params.workspaceId, updatedCatalog);

      const auditEntry: EvidenceReviewAuditEntry = {
        id: `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: params.workspaceId,
        evidenceId: foundDoc.id,
        productId: foundProduct.id,
        action: evalRes.verified ? 'external_verified' : 'external_verification_failed',
        decision: updatedDoc.decision || 'pending',
        reviewerId: params.initiatedByReviewerId,
        reviewerRole: 'platform_reviewer',
        principalType: evalRes.verified ? 'external_registry_provider' : params.initiatedByPrincipalType,
        authMethod: evalRes.verified ? 'external_registry_adapter' : params.initiatedByAuthMethod,
        reason: evalRes.reason,
        integrityHash: updatedDoc.integrityHash || expectedHash,
        metadata: {
          evidencePurpose: updatedDoc.evidencePurpose || 'general',
          verificationSource: updatedDoc.verificationSource || 'client_submission',
          externalVerificationStatus: updatedDoc.externalVerificationStatus,
          externalOutcome: evalRes.outcome,
          externalProviderName: evalRes.providerName || null,
          externalProviderRef: evalRes.providerRef || null,
          externalRequestAt: evalRes.requestAt || null,
          externalResponseAt: evalRes.responseAt || null,
          initiatedByReviewerId: params.initiatedByReviewerId,
          ...(params.claimedReviewerId ? { claimedReviewerId: params.claimedReviewerId } : {}),
        },
        createdAt: nowIso,
      };

      const logList = this.evidenceReviewAuditLog.get(params.workspaceId) || [];
      logList.push(auditEntry);
      this.evidenceReviewAuditLog.set(params.workspaceId, logList);

      return {
        evidence: JSON.parse(JSON.stringify(updatedDoc)),
        auditEntry: JSON.parse(JSON.stringify(auditEntry)),
        catalogVersion: this.catalogVersions.get(params.workspaceId),
      };
    });
  }

  async getPlatformReviewerGrant(userId: string): Promise<{
    platformRole: 'none' | 'platform_reviewer';
    scopes: string[];
    revokedAt?: string | null;
  } | null> {
    const grant = this.userPlatformGrants.get(userId);
    if (!grant) return null;
    return {
      platformRole: grant.platformRole,
      scopes: [...grant.scopes],
      revokedAt: grant.revokedAt ?? null,
    };
  }

  async setPlatformReviewerGrant(params: {
    userId: string;
    platformRole: 'none' | 'platform_reviewer';
    scopes?: string[];
    revokedAt?: string | null;
  }): Promise<void> {
    this.userPlatformGrants.set(params.userId, {
      platformRole: params.platformRole,
      scopes: params.scopes ? [...params.scopes] : [],
      revokedAt: params.revokedAt ?? null,
    });
  }

  async listReviewerServicePrincipals(): Promise<ReviewerServicePrincipalRecord[]> {
    return JSON.parse(JSON.stringify(Array.from(this.reviewerServicePrincipals.values())));
  }

  async saveReviewerServicePrincipal(principal: ReviewerServicePrincipalRecord): Promise<ReviewerServicePrincipalRecord> {
    const nowIso = new Date().toISOString();
    const existing = this.reviewerServicePrincipals.get(principal.principalId);
    const saved: ReviewerServicePrincipalRecord = {
      ...JSON.parse(JSON.stringify(principal)),
      createdAt: existing?.createdAt || principal.createdAt || nowIso,
      updatedAt: nowIso,
    };
    this.reviewerServicePrincipals.set(principal.principalId, saved);
    return JSON.parse(JSON.stringify(saved));
  }

  async revokeReviewerServicePrincipal(principalId: string): Promise<void> {
    const existing = this.reviewerServicePrincipals.get(principalId);
    if (existing) {
      const nowIso = new Date().toISOString();
      this.reviewerServicePrincipals.set(principalId, {
        ...existing,
        status: 'revoked',
        revokedAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  async getEvidenceReviewAuditLog(workspaceId: string, evidenceId?: string): Promise<EvidenceReviewAuditEntry[]> {
    const entries = this.evidenceReviewAuditLog.get(workspaceId) || [];
    const filtered = evidenceId ? entries.filter(e => e.evidenceId === evidenceId) : entries;
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return JSON.parse(JSON.stringify(sorted));
  }

  async upsertShopifyProductProvenance(record: ShopifyProductProvenanceRecord): Promise<void> {
    let wsMap = this.shopifyProductProvenance.get(record.workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.shopifyProductProvenance.set(record.workspaceId, wsMap);
    }
    const nowIso = new Date().toISOString();
    const existing = wsMap.get(record.productId);
    const saved: ShopifyProductProvenanceRecord = {
      ...JSON.parse(JSON.stringify(record)),
      createdAt: existing?.createdAt || record.createdAt || nowIso,
      updatedAt: nowIso,
    };
    wsMap.set(record.productId, saved);
  }

  async getShopifyProductProvenance(workspaceId: string): Promise<ShopifyProductProvenanceRecord[]> {
    const wsMap = this.shopifyProductProvenance.get(workspaceId);
    if (!wsMap) return [];
    return JSON.parse(JSON.stringify(Array.from(wsMap.values())));
  }

  async deleteShopifyProductProvenance(workspaceId: string, productId: string): Promise<void> {
    const wsMap = this.shopifyProductProvenance.get(workspaceId);
    if (wsMap) {
      wsMap.delete(productId);
    }
  }

  async commitShopifyCatalogSyncAtomic(params: {
    workspaceId: string;
    syncRunId: string;
    syncRunUpdates: Partial<import('../shopify/types').ShopifySyncRunRecord>;
    buildNextCatalog: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{
      nextCatalog?: StoragePayloadV1;
      provenanceRecords: ShopifyProductProvenanceRecord[];
    }> | {
      nextCatalog?: StoragePayloadV1;
      provenanceRecords: ShopifyProductProvenanceRecord[];
    };
  }): Promise<{
    syncRun: import('../shopify/types').ShopifySyncRunRecord;
    catalogVersion?: number;
  }> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      if (!this.workspaces.has(params.workspaceId)) {
        throw new Error(`Workspace ${params.workspaceId} catalog not found`);
      }

      const prevCatalog = this.catalogs.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.catalogs.get(params.workspaceId)))
        : undefined;
      const prevStore = this.stores.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.stores.get(params.workspaceId)))
        : undefined;
      const prevVersion = this.catalogVersions.get(params.workspaceId);
      const prevProvMap = this.shopifyProductProvenance.get(params.workspaceId);
      const prevProvEntries = prevProvMap
        ? new Map<string, ShopifyProductProvenanceRecord>(
            Array.from(prevProvMap.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
          )
        : undefined;
      const prevSyncRun = this.shopifySyncRuns.get(params.syncRunId)
        ? JSON.parse(JSON.stringify(this.shopifySyncRuns.get(params.syncRunId)))
        : undefined;

      try {
        if (!this.stores.has(params.workspaceId)) {
          this.stores.set(params.workspaceId, {
            name: `${params.workspaceId} Store`,
            domain: '',
            websiteUrl: '',
            sourceClassification: 'unconfigured',
            shopifyConnected: false,
            currency: 'USD',
            skuCount: 0,
            catalogCompletenessAvg: 0,
            truthBoundaryStrictness: 'standard',
            tier: 'Free Audit',
            connectors: [],
          });
        }
        const catalog = await this.loadWorkspaceCatalog(params.workspaceId);
        if (!catalog) {
          throw new Error(`Workspace ${params.workspaceId} catalog not found`);
        }
        const currentVersion = this.catalogVersions.get(params.workspaceId) || 1;
        catalog.catalogVersion = currentVersion;
        const authoritativeStore = this.stores.get(params.workspaceId) || catalog.storeProfile;

        const { nextCatalog, provenanceRecords } = await params.buildNextCatalog(catalog, authoritativeStore);
        if (nextCatalog) {
          if (nextCatalog.catalogVersion === undefined) {
            nextCatalog.catalogVersion = currentVersion;
          }
          await this.saveWorkspaceCatalogInternal(params.workspaceId, nextCatalog);
        }

        for (const provRecord of provenanceRecords) {
          await this.upsertShopifyProductProvenance(provRecord);
        }

        const syncRun = await this.updateShopifySyncRun(
          params.syncRunId,
          params.workspaceId,
          params.syncRunUpdates
        );

        return {
          syncRun,
          catalogVersion: this.catalogVersions.get(params.workspaceId) || currentVersion,
        };
      } catch (err) {
        if (prevCatalog !== undefined) this.catalogs.set(params.workspaceId, prevCatalog);
        else this.catalogs.delete(params.workspaceId);
        if (prevStore !== undefined) this.stores.set(params.workspaceId, prevStore);
        else this.stores.delete(params.workspaceId);
        if (prevVersion !== undefined) this.catalogVersions.set(params.workspaceId, prevVersion);
        else this.catalogVersions.delete(params.workspaceId);
        if (prevProvEntries !== undefined) this.shopifyProductProvenance.set(params.workspaceId, prevProvEntries);
        else this.shopifyProductProvenance.delete(params.workspaceId);
        if (prevSyncRun !== undefined) this.shopifySyncRuns.set(params.syncRunId, prevSyncRun);
        throw err;
      }
    });
  }

  async commitShopifyWebhookMutationAtomic<T = void>(params: {
    workspaceId: string;
    shopDomain: string;
    topic: string;
    eventId: string;
    leaseOwner?: string;
    defaultWebhookStatus: 'processed' | 'ignored';
    applyMutation: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile,
      subscription: SubscriptionRecord | null
    ) => Promise<{
      nextCatalog?: StoragePayloadV1;
      nextStoreProfile?: StoreProfile;
      provenanceUpserts?: ShopifyProductProvenanceRecord[];
      provenanceDeletes?: string[];
      disconnectShopifyConnection?: boolean;
      webhookStatus?: 'processed' | 'ignored';
      webhookError?: string;
      result: T;
    }> | {
      nextCatalog?: StoragePayloadV1;
      nextStoreProfile?: StoreProfile;
      provenanceUpserts?: ShopifyProductProvenanceRecord[];
      provenanceDeletes?: string[];
      disconnectShopifyConnection?: boolean;
      webhookStatus?: 'processed' | 'ignored';
      webhookError?: string;
      result: T;
    };
  }): Promise<{
    result: T;
    catalogVersion?: number;
  }> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      if (!this.workspaces.has(params.workspaceId)) {
        throw new Error(`Workspace ${params.workspaceId} catalog not found`);
      }

      const webhookKey = `${params.shopDomain}:${params.topic}:${params.eventId}`;
      const prevCatalog = this.catalogs.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.catalogs.get(params.workspaceId)))
        : undefined;
      const prevStore = this.stores.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.stores.get(params.workspaceId)))
        : undefined;
      const prevVersion = this.catalogVersions.get(params.workspaceId);
      const prevProvMap = this.shopifyProductProvenance.get(params.workspaceId);
      const prevProvEntries = prevProvMap
        ? new Map<string, ShopifyProductProvenanceRecord>(
            Array.from(prevProvMap.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
          )
        : undefined;
      const prevConnection = this.shopifyConnections.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.shopifyConnections.get(params.workspaceId)))
        : undefined;
      const prevWebhookEvent = this.shopifyWebhookEvents.get(webhookKey)
        ? JSON.parse(JSON.stringify(this.shopifyWebhookEvents.get(webhookKey)))
        : undefined;

      try {
        if (!this.stores.has(params.workspaceId)) {
          this.stores.set(params.workspaceId, {
            name: `${params.workspaceId} Store`,
            domain: '',
            websiteUrl: '',
            sourceClassification: 'unconfigured',
            shopifyConnected: false,
            currency: 'USD',
            skuCount: 0,
            catalogCompletenessAvg: 0,
            truthBoundaryStrictness: 'standard',
            tier: 'Free Audit',
            connectors: [],
          });
        }
        const catalog = await this.loadWorkspaceCatalog(params.workspaceId);
        if (!catalog) {
          throw new Error(`Workspace ${params.workspaceId} catalog not found`);
        }
        const currentVersion = this.catalogVersions.get(params.workspaceId) || 1;
        catalog.catalogVersion = currentVersion;
        const authoritativeStore = this.stores.get(params.workspaceId) || catalog.storeProfile;
        const subscription = await this.getSubscriptionByWorkspace(params.workspaceId);

        const mutation = await params.applyMutation(catalog, authoritativeStore, subscription);

        if (mutation.disconnectShopifyConnection) {
          await this.deleteShopifyConnection(params.workspaceId);
          if (mutation.nextStoreProfile) {
            await this.saveStoreProfile(params.workspaceId, mutation.nextStoreProfile);
          }
        } else if (mutation.nextCatalog) {
          if (mutation.nextCatalog.catalogVersion === undefined) {
            mutation.nextCatalog.catalogVersion = currentVersion;
          }
          await this.saveWorkspaceCatalogInternal(params.workspaceId, mutation.nextCatalog);
        }

        for (const provRecord of mutation.provenanceUpserts || []) {
          await this.upsertShopifyProductProvenance(provRecord);
        }

        for (const productId of mutation.provenanceDeletes || []) {
          await this.deleteShopifyProductProvenance(params.workspaceId, productId);
        }

        await this.updateShopifyWebhookEventStatus(
          params.eventId,
          params.shopDomain,
          params.topic,
          mutation.webhookStatus ?? params.defaultWebhookStatus,
          mutation.webhookError,
          params.leaseOwner
        );

        return {
          result: mutation.result,
          catalogVersion: this.catalogVersions.get(params.workspaceId) || currentVersion,
        };
      } catch (err) {
        if (prevCatalog !== undefined) this.catalogs.set(params.workspaceId, prevCatalog);
        else this.catalogs.delete(params.workspaceId);
        if (prevStore !== undefined) this.stores.set(params.workspaceId, prevStore);
        else this.stores.delete(params.workspaceId);
        if (prevVersion !== undefined) this.catalogVersions.set(params.workspaceId, prevVersion);
        else this.catalogVersions.delete(params.workspaceId);
        if (prevProvEntries !== undefined) this.shopifyProductProvenance.set(params.workspaceId, prevProvEntries);
        else this.shopifyProductProvenance.delete(params.workspaceId);
        if (prevConnection !== undefined) this.shopifyConnections.set(params.workspaceId, prevConnection);
        else this.shopifyConnections.delete(params.workspaceId);
        if (prevWebhookEvent !== undefined) this.shopifyWebhookEvents.set(webhookKey, prevWebhookEvent);
        else this.shopifyWebhookEvents.delete(webhookKey);
        throw err;
      }
    });
  }

  async createGuestTransferAuthorization(
    record: GuestTransferAuthorizationRecord
  ): Promise<GuestTransferAuthorizationRecord> {
    const cloned: GuestTransferAuthorizationRecord = JSON.parse(JSON.stringify(record));
    // Enforce unique (workspaceId, userId, idempotencyKey) for non-expired or existing active/committed rows
    for (const [existingId, existing] of this.guestTransferAuthorizations.entries()) {
      if (
        existing.workspaceId === cloned.workspaceId &&
        existing.userId === cloned.userId &&
        existing.idempotencyKey === cloned.idempotencyKey
      ) {
        if (existing.status === 'committed') {
          const err: any = new Error('duplicate idempotency key already committed');
          err.code = '23505';
          throw err;
        }
        // Replace superseded pending/expired authorization with the same idempotencyKey
        this.guestTransferAuthorizations.delete(existingId);
      }
    }
    this.guestTransferAuthorizations.set(cloned.id, cloned);
    return JSON.parse(JSON.stringify(cloned));
  }

  async getGuestTransferAuthorizationByTokenHash(
    tokenHash: string
  ): Promise<GuestTransferAuthorizationRecord | null> {
    for (const rec of this.guestTransferAuthorizations.values()) {
      if (rec.tokenHash === tokenHash) {
        return JSON.parse(JSON.stringify(rec));
      }
    }
    return null;
  }

  async getGuestTransferAuthorizationByIdempotencyKey(
    workspaceId: string,
    userId: string,
    idempotencyKey: string
  ): Promise<GuestTransferAuthorizationRecord | null> {
    for (const rec of this.guestTransferAuthorizations.values()) {
      if (
        rec.workspaceId === workspaceId &&
        rec.userId === userId &&
        rec.idempotencyKey === idempotencyKey
      ) {
        return JSON.parse(JSON.stringify(rec));
      }
    }
    return null;
  }

  async markGuestTransferAuthorizationExpired(id: string): Promise<void> {
    const existing = this.guestTransferAuthorizations.get(id);
    if (existing && existing.status === 'pending') {
      existing.status = 'expired';
      existing.updatedAt = new Date().toISOString();
    }
  }

  async commitGuestTransferAtomic(params: {
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
  }): Promise<GuestTransferCommitResult> {
    return this.withWorkspaceLock(params.workspaceId, async () => {
      const auth = this.guestTransferAuthorizations.get(params.authorizationId);
      if (!auth) {
        throw new GuestTransferError('Invalid guest transfer authorization.', 'TRANSFER_AUTHORIZATION_INVALID', 403);
      }
      if (auth.workspaceId !== params.workspaceId || auth.userId !== params.userId) {
        throw new GuestTransferError(
          'Forbidden: guest transfer authorization is bound to a different user or workspace.',
          'TRANSFER_TENANT_MISMATCH',
          403
        );
      }
      if (auth.status === 'committed') {
        if (auth.payloadSha256 === params.payloadSha256 && auth.resultSummary) {
          return { ...JSON.parse(JSON.stringify(auth.resultSummary)), idempotentReplay: true };
        }
        throw new GuestTransferError(
          'Single-use guest transfer authorization has already been consumed.',
          'TRANSFER_TOKEN_ALREADY_USED',
          409
        );
      }
      if (auth.status === 'expired' || new Date(auth.expiresAt).getTime() <= Date.now()) {
        auth.status = 'expired';
        auth.updatedAt = new Date().toISOString();
        throw new GuestTransferError('Guest transfer authorization has expired.', 'TRANSFER_AUTHORIZATION_EXPIRED', 410);
      }

      const prevCatalog = this.catalogs.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.catalogs.get(params.workspaceId)))
        : undefined;
      const prevStore = this.stores.get(params.workspaceId)
        ? JSON.parse(JSON.stringify(this.stores.get(params.workspaceId)))
        : undefined;
      const prevVersion = this.catalogVersions.get(params.workspaceId);
      const prevAuth = JSON.parse(JSON.stringify(auth));
      const prevAudit = JSON.parse(JSON.stringify(this.guestTransferAuditLog.get(params.workspaceId) || []));

      try {
        const currentVersion = prevVersion || 1;
        const authoritativeStore: StoreProfile = prevStore || {
          name: `${params.workspaceId} Store`,
          domain: '',
          websiteUrl: '',
          sourceClassification: 'unconfigured',
          shopifyConnected: false,
          currency: 'USD',
          skuCount: 0,
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard',
          tier: 'Free Audit',
          connectors: [],
        };
        const subscription = await this.getSubscriptionByWorkspace(params.workspaceId);

        const built = params.buildMergedCatalog({
          existingCatalog: prevCatalog ?? null,
          authoritativeStore,
          subscription,
          catalogVersionBefore: currentVersion,
        });

        await this.saveWorkspaceCatalogInternal(params.workspaceId, built.mergedPayload, {
          expectedVersion: currentVersion,
        });

        const nextVersion = this.catalogVersions.get(params.workspaceId) || currentVersion + 1;
        const summary: GuestTransferCommitResult = {
          ...built.summary,
          catalogVersion: nextVersion,
        };

        const nowIso = new Date().toISOString();
        auth.status = 'committed';
        auth.conflictStrategy = params.conflictStrategy;
        auth.committedAt = summary.committedAt || nowIso;
        auth.resultSummary = JSON.parse(JSON.stringify(summary));
        auth.updatedAt = nowIso;

        const auditEntry: GuestTransferAuditRecord = {
          id: `gta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          transferId: auth.id,
          workspaceId: params.workspaceId,
          userId: params.userId,
          outcome: 'committed',
          conflictStrategy: params.conflictStrategy,
          importedCount: built.importedCount,
          skippedCount: built.skippedCount,
          conflictsCount: built.conflictsCount,
          catalogVersionBefore: currentVersion,
          catalogVersionAfter: nextVersion,
          details: {
            renamedCount: summary.renamedCount,
            preservedSourceClassifications: summary.preservedSourceClassifications,
            totalWorkspaceProducts: summary.totalWorkspaceProducts,
          },
          createdAt: nowIso,
        };
        const entries = this.guestTransferAuditLog.get(params.workspaceId) || [];
        entries.push(auditEntry);
        this.guestTransferAuditLog.set(params.workspaceId, entries);

        return summary;
      } catch (err) {
        // Atomic rollback of in-memory state on any persistence failure
        if (prevCatalog !== undefined) this.catalogs.set(params.workspaceId, prevCatalog);
        else this.catalogs.delete(params.workspaceId);
        if (prevStore !== undefined) this.stores.set(params.workspaceId, prevStore);
        else this.stores.delete(params.workspaceId);
        if (prevVersion !== undefined) this.catalogVersions.set(params.workspaceId, prevVersion);
        else this.catalogVersions.delete(params.workspaceId);
        this.guestTransferAuthorizations.set(params.authorizationId, prevAuth);
        this.guestTransferAuditLog.set(params.workspaceId, prevAudit);
        throw err;
      }
    });
  }

  async recordGuestTransferAudit(record: GuestTransferAuditRecord): Promise<void> {
    const entries = this.guestTransferAuditLog.get(record.workspaceId) || [];
    entries.push(JSON.parse(JSON.stringify(record)));
    this.guestTransferAuditLog.set(record.workspaceId, entries);
  }

  async getGuestTransferAuditLog(workspaceId: string): Promise<GuestTransferAuditRecord[]> {
    const entries = this.guestTransferAuditLog.get(workspaceId) || [];
    return JSON.parse(
      JSON.stringify(
        [...entries].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      )
    );
  }
}


