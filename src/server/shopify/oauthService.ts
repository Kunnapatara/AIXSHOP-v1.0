import crypto from 'node:crypto';
import { DatabaseRepository } from '../db/repository';
import { ShopifyConnectionRecord } from './types';
import { isValidShopDomain, normalizeShopDomain, verifyShopifyConnection } from './client';
import { encryptCredential, verifyHmacSha256 } from '../security/encryption';

export const DEFAULT_SHOPIFY_SCOPES = 'read_products';

export interface ShopifyOAuthEnv {
  apiKey: string;
  apiSecret: string;
  appUrl: string;
  redirectUri: string;
  scopes: string;
}

/**
 * Resolves Shopify OAuth configuration from environment.
 */
export function getShopifyOAuthEnv(): ShopifyOAuthEnv {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  const apiSecret = process.env.SHOPIFY_API_SECRET || '';
  const appUrl = process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI || `${appUrl}/api/shopify/callback`;
  const scopes = process.env.SHOPIFY_SCOPES || DEFAULT_SHOPIFY_SCOPES;

  return { apiKey, apiSecret, appUrl, redirectUri, scopes };
}

/**
 * Generates authorization URL for merchant installation.
 * Uses a cryptographically secure random nonce stored with an expiration timestamp.
 */
export async function initiateShopifyConnect(
  repo: DatabaseRepository,
  workspaceId: string,
  rawShopDomain: string
): Promise<{ authUrl: string; state: string; shopDomain: string }> {
  const shop = normalizeShopDomain(rawShopDomain);
  if (!isValidShopDomain(shop)) {
    throw new Error(`[AIXSHOP Shopify OAuth] Invalid shop domain "${rawShopDomain}". Must be a valid *.myshopify.com hostname.`);
  }

  const { apiKey, redirectUri, scopes } = getShopifyOAuthEnv();
  if (!apiKey) {
    throw new Error(
      '[AIXSHOP Shopify OAuth] SHOPIFY_API_KEY is not configured in the environment. Configure app credentials in Settings or .env.'
    );
  }

  // Generate 32-byte cryptographic state nonce
  const stateNonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes expiry

  // Persist state in repository to prevent CSRF
  await repo.saveShopifyOAuthState({
    id: stateNonce,
    workspaceId,
    shopDomain: shop,
    expiresAt,
  });

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes,
    redirect_uri: redirectUri,
    state: stateNonce,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${params.toString()}`;

  return {
    authUrl,
    state: stateNonce,
    shopDomain: shop,
  };
}

/**
 * Verifies the Shopify OAuth callback HMAC signature according to official specification:
 * 1. Remove `hmac` and `signature` keys from query.
 * 2. Sort remaining keys alphabetically.
 * 3. Construct URL-encoded query string `key1=val1&key2=val2...`.
 * 4. Compute SHA256 HMAC using SHOPIFY_API_SECRET.
 * 5. Compare in constant time with provided `hmac`.
 */
export function verifyShopifyCallbackHmac(
  queryParams: Record<string, any>,
  apiSecret: string
): boolean {
  if (!queryParams || !apiSecret || !queryParams.hmac) {
    return false;
  }

  const providedHmac = String(queryParams.hmac);
  const keys = Object.keys(queryParams)
    .filter(k => k !== 'hmac' && k !== 'signature')
    .sort();

  const message = keys
    .map(key => `${key}=${queryParams[key]}`)
    .join('&');

  return verifyHmacSha256(message, apiSecret, providedHmac);
}

export interface CallbackExchangeResult {
  connection: ShopifyConnectionRecord;
  shopDomain: string;
  grantedScopes: string;
  shopName?: string;
}

/**
 * Handles the OAuth callback:
 * - Validates HMAC signature.
 * - Validates state nonce and expiration.
 * - Exchanges code for access token.
 * - Validates required scopes.
 * - Encrypts and securely persists token.
 * - Verifies live Admin API connection.
 */
export async function handleShopifyCallback(
  repo: DatabaseRepository,
  queryParams: Record<string, any>,
  options: { customFetch?: typeof fetch } = {}
): Promise<CallbackExchangeResult> {
  const { apiSecret, apiKey } = getShopifyOAuthEnv();
  if (!apiSecret || !apiKey) {
    throw new Error('[AIXSHOP Shopify OAuth] SHOPIFY_API_KEY or SHOPIFY_API_SECRET is not configured.');
  }

  const rawShop = String(queryParams.shop || '');
  const shop = normalizeShopDomain(rawShop);
  if (!isValidShopDomain(shop)) {
    throw new Error(`[AIXSHOP Shopify OAuth] Invalid shop domain "${rawShop}" in callback.`);
  }

  // 1. Verify HMAC
  const isHmacValid = verifyShopifyCallbackHmac(queryParams, apiSecret);
  if (!isHmacValid) {
    throw new Error('[AIXSHOP Shopify OAuth] HMAC verification failed. Unauthorized or tampered callback request.');
  }

  // 2. Verify state nonce
  const stateNonce = String(queryParams.state || '');
  if (!stateNonce) {
    throw new Error('[AIXSHOP Shopify OAuth] Missing state parameter in callback.');
  }

  const oauthState = await repo.getAndConsumeShopifyOAuthState(stateNonce);
  if (!oauthState) {
    throw new Error('[AIXSHOP Shopify OAuth] Invalid or expired OAuth state nonce. Please restart connection.');
  }

  if (new Date(oauthState.expiresAt).getTime() < Date.now()) {
    throw new Error('[AIXSHOP Shopify OAuth] OAuth state nonce has expired. Please restart connection.');
  }

  if (oauthState.shopDomain !== shop) {
    throw new Error(`[AIXSHOP Shopify OAuth] State shop mismatch: expected ${oauthState.shopDomain}, got ${shop}.`);
  }

  const workspaceId = oauthState.workspaceId;
  const code = String(queryParams.code || '');
  if (!code) {
    throw new Error('[AIXSHOP Shopify OAuth] Missing authorization code in callback.');
  }

  // 3. Exchange authorization code for access token
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;
  const fetchFn = options.customFetch || fetch;

  const tokenResponse = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(
      `[AIXSHOP Shopify OAuth] Token exchange failed with HTTP ${tokenResponse.status}: ${errText.slice(0, 300)}`
    );
  }

  const tokenData = await tokenResponse.json();
  const rawAccessToken = tokenData.access_token;
  if (!rawAccessToken || typeof rawAccessToken !== 'string') {
    throw new Error('[AIXSHOP Shopify OAuth] Shopify access token response did not contain access_token.');
  }

  const grantedScopes = tokenData.scope || '';
  if (!grantedScopes.includes('read_products')) {
    throw new Error(
      `[AIXSHOP Shopify OAuth] Insufficient scopes granted: expected "read_products", got "${grantedScopes}".`
    );
  }

  // 4. Verify live connection before reporting connected
  const verifyResult = await verifyShopifyConnection(shop, rawAccessToken, { customFetch: fetchFn });
  if (!verifyResult.valid) {
    throw new Error(
      `[AIXSHOP Shopify OAuth] Live connection verification failed: ${verifyResult.error || 'Unable to query shop metadata'}`
    );
  }

  // 5. Encrypt credentials at rest
  const accessTokenEncrypted = encryptCredential(rawAccessToken);
  const refreshTokenEncrypted = tokenData.refresh_token
    ? encryptCredential(tokenData.refresh_token)
    : null;

  const tokenExpiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  const connectionId = `conn_shopify_${workspaceId}`;
  const now = new Date().toISOString();

  const connection: ShopifyConnectionRecord = {
    id: connectionId,
    workspaceId,
    shopDomain: shop,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    tokenExpiresAt,
    grantedScopes,
    keyVersion: 'v1',
    status: 'connected',
    installedAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const savedConnection = await repo.saveShopifyConnection(connection);

  // Update store profile connector status
  const storeProfile = await repo.getStoreByWorkspace(workspaceId);
  if (storeProfile) {
    const connectors = storeProfile.connectors || [];
    const shopifyIdx = connectors.findIndex(c => c.id === 'shopify');
    const updatedConnector = {
      id: 'shopify',
      name: `Shopify (${verifyResult.shopName || shop})`,
      type: 'shopify' as const,
      status: 'connected' as const,
      productCountSynced: storeProfile.skuCount || 0,
      lastSync: now,
      writeBackAuthorized: false,
    };

    let nextConnectors = [...connectors];
    if (shopifyIdx >= 0) {
      nextConnectors[shopifyIdx] = updatedConnector;
    } else {
      nextConnectors.push(updatedConnector);
    }

    await repo.saveStoreProfile(workspaceId, {
      ...storeProfile,
      domain: shop,
      connectors: nextConnectors,
    });
  }

  return {
    connection: savedConnection,
    shopDomain: shop,
    grantedScopes,
    shopName: verifyResult.shopName,
  };
}

/**
 * Disconnects the workspace's Shopify connection:
 * - Deletes encrypted tokens.
 * - Marks connection status as 'disconnected'.
 * - Preserves previously imported catalog products and audit history.
 */
export async function disconnectShopify(
  repo: DatabaseRepository,
  workspaceId: string
): Promise<{ success: boolean; message: string }> {
  const connection = await repo.getShopifyConnection(workspaceId);
  if (!connection) {
    return { success: true, message: 'No Shopify connection existed for workspace.' };
  }

  await repo.deleteShopifyConnection(workspaceId);

  // Update store profile connector
  const storeProfile = await repo.getStoreByWorkspace(workspaceId);
  if (storeProfile) {
    const connectors = (storeProfile.connectors || []).map(c =>
      c.id === 'shopify' ? { ...c, status: 'disconnected' as const } : c
    );
    await repo.saveStoreProfile(workspaceId, {
      ...storeProfile,
      connectors,
    });
  }

  return {
    success: true,
    message: `Successfully disconnected Shopify store ${connection.shopDomain}. Catalog data and audit history preserved.`,
  };
}
