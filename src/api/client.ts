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
}

export const apiClient = new ApiClient();
