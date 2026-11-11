export interface ShopifyConnectionRecord {
  id: string;
  workspaceId: string;
  shopDomain: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string | null;
  tokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  lastRefreshedAt?: string | null;
  webhookSubscriptions?: Array<string | { id?: string; topic: string; callbackUrl?: string; active?: boolean }>;
  grantedScopes: string;
  keyVersion: string;
  status: 'connected' | 'disconnected' | 'reauth_required' | 'reauthorization_required';
  installedAt: string;
  lastVerifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifySyncRunRecord {
  id: string;
  workspaceId: string;
  shopDomain: string;
  status: 'pending' | 'syncing' | 'completed' | 'partially_completed' | 'failed';
  productsDiscovered: number;
  productsImported: number;
  variantsImported: number;
  excludedByPlan: number;
  cursorResumed?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyWebhookEventRecord {
  id: string;
  workspaceId: string;
  shopDomain: string;
  eventId: string;
  topic: string;
  deliveryId?: string | null;
  payload: any;
  status: 'processing' | 'processed' | 'failed' | 'ignored';
  retryCount: number;
  lastError?: string | null;
  processedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyOAuthStateRecord {
  id: string;
  workspaceId: string;
  shopDomain: string;
  expiresAt: string;
  createdAt: string;
}

export interface ShopifyPublicStatus {
  connected: boolean;
  status: 'not_connected' | 'connected' | 'reauth_required' | 'reauthorization_required' | 'disconnected';
  shopDomain: string | null;
  grantedScopes: string[];
  installedAt: string | null;
  lastVerifiedAt: string | null;
  latestSync: ShopifySyncRunRecord | null;
  tokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  webhookStatus?: 'active' | 'not_configured' | 'pending' | 'inactive' | 'partially_registered' | 'registered_unverified' | 'verification_failed';
  activeWebhooks?: string[];
  canResumeSync?: boolean;
}

/**
 * Shopify Admin GraphQL node schemas
 */
export interface ShopifyGraphQLImageEdge {
  node: {
    url?: string;
    originalSrc?: string;
    altText?: string | null;
  };
}

export interface ShopifyGraphQLVariantEdge {
  cursor?: string;
  node: {
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: string | null;
    compareAtPrice?: string | null;
    inventoryQuantity?: number | null;
    selectedOptions?: Array<{ name: string; value: string }>;
  };
}

export interface ShopifyGraphQLProductNode {
  id: string;
  title: string;
  descriptionHtml?: string | null;
  description?: string | null;
  vendor?: string | null;
  productType?: string | null;
  handle?: string | null;
  status?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  images?: {
    edges: ShopifyGraphQLImageEdge[];
  };
  variants?: {
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: ShopifyGraphQLVariantEdge[];
  };
}

export interface ShopifyProductConnectionQueryResponse {
  products: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: Array<{
      cursor: string;
      node: ShopifyGraphQLProductNode;
    }>;
  };
}
