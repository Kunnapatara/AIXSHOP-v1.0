import { 
  DatabaseRepository, 
  CreateUserData, 
  CreateWorkspaceData, 
  CreateSessionData 
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

export class MemoryRepository implements DatabaseRepository {
  private users: Map<string, UserRecord> = new Map();
  private workspaces: Map<string, WorkspaceRecord> = new Map();
  private memberships: Map<string, WorkspaceMembershipRecord> = new Map(); // id -> record
  private sessions: Map<string, SessionRecord> = new Map(); // tokenHash -> record
  private stores: Map<string, StoreProfile> = new Map(); // workspaceId -> store
  private catalogs: Map<string, StoragePayloadV1> = new Map(); // workspaceId -> catalog

  constructor(seedDefaultDemoWorkspace = false) {
    if (seedDefaultDemoWorkspace) {
      this.seedDemo();
    }
  }

  getBackendType(): 'memory' {
    return 'memory';
  }

  async ping(): Promise<boolean> {
    return true;
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
    if (!cat) return null;
    // Return deep clone
    return JSON.parse(JSON.stringify(cat));
  }

  async saveWorkspaceCatalog(workspaceId: string, payload: StoragePayloadV1): Promise<void> {
    // Validate workspace exists
    if (!this.workspaces.has(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    this.catalogs.set(workspaceId, JSON.parse(JSON.stringify(payload)));
    this.stores.set(workspaceId, JSON.parse(JSON.stringify(payload.storeProfile)));
  }

  async approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product }> {
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
    await this.saveWorkspaceCatalog(workspaceId, updatedCatalog);

    const updatedAction = result.nextActions.find(a => a.id === actionId);
    if (!updatedAction) throw new Error(`Action ${actionId} not found`);
    const updatedProduct = updatedAction.productId
      ? result.nextProducts.find(p => p.id === updatedAction.productId)
      : undefined;

    return { action: updatedAction, product: updatedProduct };
  }

  async dismissAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
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

    await this.saveWorkspaceCatalog(workspaceId, {
      ...catalog,
      actions: result.nextActions,
    });

    const updatedAction = result.nextActions.find(a => a.id === actionId);
    if (!updatedAction) throw new Error(`Action ${actionId} not found`);
    return { action: updatedAction };
  }

  async recheckAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
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

    await this.saveWorkspaceCatalog(workspaceId, {
      ...catalog,
      actions: result.nextActions,
      findings: result.nextFindings || catalog.findings,
    });

    const updatedAction = result.nextActions.find(a => a.id === actionId);
    if (!updatedAction) throw new Error(`Action ${actionId} not found`);
    return { action: updatedAction };
  }

  async importCatalog(
    workspaceId: string,
    candidates: any[]
  ): Promise<CatalogImportResult> {
    const catalog = await this.loadWorkspaceCatalog(workspaceId);
    if (!catalog) throw new Error(`Workspace ${workspaceId} catalog not found`);

    const importRes = executeCatalogImport(candidates, {
      products: catalog.products,
      findings: catalog.findings,
      actionItems: catalog.actions,
      storeProfile: catalog.storeProfile,
      isReadOnly: false,
    });

    if (importRes.importedCount > 0) {
      await this.saveWorkspaceCatalog(workspaceId, {
        ...catalog,
        products: importRes.nextProducts,
        storeProfile: importRes.nextStoreProfile,
      });
    }

    return importRes;
  }
}
