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
  UpdateAuditRunData
} from './repository';
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
  ProductCandidate
} from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { SubscriptionRecord, BillingEventRecord, PlanTier } from '../billing/types';
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
        ],
        appliedMigrations: ['001_initial_schema.sql'],
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
      domain: `${workspace.slug}.myshopify.com`,
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
      domain: `${workspace.slug}.myshopify.com`,
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
      };
      this.catalogs.set(workspaceId, initialCatalog);
      return JSON.parse(JSON.stringify(initialCatalog));
    }
    // Return deep clone
    return JSON.parse(JSON.stringify(cat));
  }

  private workspaceLocks: Map<string, Promise<unknown>> = new Map();

  async withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prevLock = this.workspaceLocks.get(workspaceId) || Promise.resolve();
    let releaseCurrent: () => void;
    const currentTurnPromise = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    const chainTail = prevLock.catch(() => {}).then(() => currentTurnPromise);
    this.workspaceLocks.set(workspaceId, chainTail);

    try {
      await prevLock.catch(() => {});
      return await fn();
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

  private async saveWorkspaceCatalogInternal(workspaceId: string, payload: StoragePayloadV1): Promise<void> {
    // Validate workspace exists
    if (!this.workspaces.has(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }

    const store = this.stores.get(workspaceId);
    const authoritativeStore: StoreProfile = store || {
      name: payload.storeProfile?.name || `${workspaceId} Store`,
      domain: payload.storeProfile?.domain || `${workspaceId}.myshopify.com`,
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

    const payloadToStore: StoragePayloadV1 = JSON.parse(JSON.stringify(payload));
    payloadToStore.storeProfile = updatedStoreProfile;

    this.catalogs.set(workspaceId, payloadToStore);
    this.stores.set(workspaceId, updatedStoreProfile);
  }

  async saveWorkspaceCatalog(workspaceId: string, payload: StoragePayloadV1): Promise<void> {
    return this.withWorkspaceLock(workspaceId, async () => {
      await this.saveWorkspaceCatalogInternal(workspaceId, payload);
    });
  }

  async approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product }> {
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

      return { action: updatedAction, product: updatedProduct };
    });
  }

  async dismissAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
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
      return { action: updatedAction };
    });
  }

  async recheckAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
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
      return { action: updatedAction };
    });
  }

  async importCatalog(
    workspaceId: string,
    candidates: any[]
  ): Promise<CatalogImportResult> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const catalog = await this.loadWorkspaceCatalog(workspaceId);
      if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

      const store = await this.getStoreByWorkspace(workspaceId);
      const { additionalSkus } = calculateImportUsage(candidates, catalog.products);
      const quotaCheck = checkPlanQuota(store, catalog.products, additionalSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      const importRes = executeCatalogImport(candidates, {
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
    const leaseDurationMs = Math.max(1000, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `worker_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();

    if (!existing) {
      const record: BillingEventRecord = {
        ...JSON.parse(JSON.stringify(event)),
        status: 'processing',
        leaseOwner,
        leaseExpiresAt,
        attemptCount: 1,
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
      existing.processedAt = nowIso;
      existing.updatedAt = nowIso;
      if (event.payload) {
        existing.payload = JSON.parse(JSON.stringify(event.payload));
      }
      return { claimed: true, event: JSON.parse(JSON.stringify(existing)), leaseOwner };
    }

    return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
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
    existing.leaseExpiresAt = new Date(now + Math.max(1000, extendMs)).toISOString();
    existing.updatedAt = new Date(now).toISOString();
    return true;
  }

  async updateBillingEventStatus(
    eventId: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    payload?: any,
    leaseOwner?: string
  ): Promise<void> {
    const existing = this.billingEvents.get(eventId);
    if (existing) {
      if (leaseOwner && (existing.status !== 'processing' || existing.leaseOwner !== leaseOwner)) {
        throw new Error(`Billing lease ownership lost for event ${eventId}: stale worker "${leaseOwner}" rejected.`);
      }
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
      if (status !== 'processing') {
        existing.leaseExpiresAt = null;
      }
      if (payload !== undefined) {
        existing.payload = JSON.parse(JSON.stringify(payload));
      }
    }
  }

  async applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
    leaseOwner?: string;
  }): Promise<void> {
    // Verify lease ownership BEFORE modifying any workspace/subscription state
    const prevEvent = this.billingEvents.get(params.eventId);
    if (params.leaseOwner) {
      if (!prevEvent || prevEvent.status !== 'processing' || prevEvent.leaseOwner !== params.leaseOwner) {
        throw new Error(`Billing lease ownership lost for event ${params.eventId}: stale worker rejected.`);
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
          domain: 'store.myshopify.com',
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

        // Execute domain rules on actual persisted catalog
        const auditResult = executeCatalogAudit(catalog.products, catalog.storeProfile || store, catalog.actions);

        // Update catalog with real evaluation results
        const updatedCatalog: StoragePayloadV1 = {
          ...catalog,
          products: auditResult.updatedProducts,
          findings: auditResult.findings,
          actions: auditResult.actionItems,
          storeProfile: auditResult.updatedStoreProfile,
        };

        // Persist updated catalog atomically
        await this.saveWorkspaceCatalogInternal(workspaceId, updatedCatalog);

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
          metadata: {},
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

  async claimShopifyWebhookEvent(event: import('../shopify/types').ShopifyWebhookEventRecord): Promise<{ claimed: boolean; event: import('../shopify/types').ShopifyWebhookEventRecord | null }> {
    const key = `${event.shopDomain}:${event.topic}:${event.eventId}`;
    const existing = this.shopifyWebhookEvents.get(key);
    if (existing) {
      return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
    }
    const copy = JSON.parse(JSON.stringify(event));
    this.shopifyWebhookEvents.set(key, copy);
    return { claimed: true, event: JSON.parse(JSON.stringify(copy)) };
  }

  async updateShopifyWebhookEventStatus(eventId: string, shopDomain: string, topic: string, status: 'processing' | 'processed' | 'failed' | 'ignored', error?: string): Promise<void> {
    const key = `${shopDomain}:${topic}:${eventId}`;
    const existing = this.shopifyWebhookEvents.get(key);
    if (existing) {
      existing.status = status;
      if (error) existing.lastError = error;
      if (status === 'processed') existing.processedAt = new Date().toISOString();
      existing.updatedAt = new Date().toISOString();
    }
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
      status: record.status || 'completed',
      rejectedRowCount: record.rejectedRowCount ?? 0,
      errors: record.errors ? JSON.parse(JSON.stringify(record.errors)) : [],
      createdAt: record.createdAt || new Date().toISOString(),
    };
    this.visibilityImports.set(record.id, copy);
    return JSON.parse(JSON.stringify(copy));
  }

  async saveVisibilityMetrics(metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]): Promise<void> {
    for (const m of metrics) {
      const idx = this.visibilityMetrics.findIndex(
        (existing) =>
          existing.workspaceId === m.workspaceId &&
          existing.observationDate === m.observationDate &&
          existing.platform === m.platform &&
          (existing.discoveryTopic || '') === (m.discoveryTopic || '')
      );
      const copy = JSON.parse(JSON.stringify(m));
      if (idx >= 0) {
        this.visibilityMetrics[idx] = copy;
      } else {
        this.visibilityMetrics.push(copy);
      }
    }
  }

  async saveVisibilityImportAtomic(
    record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord,
    metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]
  ): Promise<{ importRecord: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord; metricsSaved: number }> {
    const prevImports = new Map(this.visibilityImports);
    const prevMetrics = JSON.parse(JSON.stringify(this.visibilityMetrics));
    try {
      const savedImport = await this.saveVisibilityImport(record);
      await this.saveVisibilityMetrics(metrics);
      return { importRecord: savedImport, metricsSaved: metrics.length };
    } catch (err) {
      this.visibilityImports = prevImports;
      this.visibilityMetrics = prevMetrics;
      throw err;
    }
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
}

