import { 
  DatabaseRepository, 
  CreateUserData, 
  CreateWorkspaceData, 
  CreateSessionData,
  RegisterUserData,
  RegisterUserResult,
  SchemaReadinessResult
} from './repository';
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

  async claimBillingEvent(event: BillingEventRecord): Promise<{ claimed: boolean; event: BillingEventRecord | null }> {
    const existing = this.billingEvents.get(event.eventId);
    const now = Date.now();

    if (!existing) {
      const record: BillingEventRecord = {
        ...JSON.parse(JSON.stringify(event)),
        status: 'processing',
        processedAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      this.billingEvents.set(event.eventId, record);
      return { claimed: true, event: JSON.parse(JSON.stringify(record)) };
    }

    const processedTime = new Date(existing.processedAt).getTime();
    const isStale = existing.status === 'processing' && (now - processedTime > 5 * 60 * 1000);
    const isFailed = existing.status === 'failed';

    if (isFailed || isStale) {
      existing.status = 'processing';
      existing.processedAt = new Date(now).toISOString();
      existing.updatedAt = new Date(now).toISOString();
      if (event.payload) {
        existing.payload = JSON.parse(JSON.stringify(event.payload));
      }
      return { claimed: true, event: JSON.parse(JSON.stringify(existing)) };
    }

    return { claimed: false, event: JSON.parse(JSON.stringify(existing)) };
  }

  async updateBillingEventStatus(
    eventId: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    payload?: any
  ): Promise<void> {
    const existing = this.billingEvents.get(eventId);
    if (existing) {
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
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
  }): Promise<void> {
    // Snapshot state for atomic rollback simulation
    const prevSub = this.subscriptions.get(params.subscription.workspaceId);
    const prevStore = this.stores.get(params.subscription.workspaceId);
    const prevEvent = this.billingEvents.get(params.eventId);

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
        prevEvent.processedAt = new Date().toISOString();
        prevEvent.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      // Rollback
      if (prevSub) this.subscriptions.set(params.subscription.workspaceId, prevSub);
      else this.subscriptions.delete(params.subscription.workspaceId);

      if (prevStore) this.stores.set(params.subscription.workspaceId, prevStore);
      if (prevEvent) this.billingEvents.set(params.eventId, prevEvent);
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
  }
}

