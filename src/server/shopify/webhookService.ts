import { DatabaseRepository } from '../db/repository';
import { verifyShopifyWebhookHmac } from '../security/encryption';
import { getShopifyOAuthEnv, disconnectShopify, getValidShopifyAccessToken } from './oauthService';
import { normalizeShopDomain, executeShopifyGraphQL } from './client';
import { Product, Variant } from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { parseSourcePrice } from '../../domain/validation/price';
import { calculateProductCompleteness } from '../../domain/catalog/completeness';
import { resolveWorkspacePlanEntitlement, countCatalogSkus, withWorkspaceLock } from '../services/entitlementService';
import { detectProductConflict } from '../../domain/ingestion/storeIngestion';
import { PaginationCompletenessStatus, WebhookStatusCategory } from './types';

export const DEFAULT_SHOPIFY_WEBHOOK_TOPICS = [
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'APP_UNINSTALLED',
];

export interface WebhookRegistrationResult {
  topic: string;
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Registers webhook subscriptions on Shopify via Admin GraphQL webhookSubscriptionCreate mutation.
 */
export async function registerShopifyWebhookSubscriptions(
  shopDomain: string,
  accessToken: string,
  callbackUrl: string,
  topics: string[] = DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
  options: { customFetch?: typeof fetch } = {}
): Promise<WebhookRegistrationResult[]> {
  const results: WebhookRegistrationResult[] = [];

  const mutation = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        userErrors {
          field
          message
        }
        webhookSubscription {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
      }
    }
  `;

  for (const rawTopic of topics) {
    const formattedTopic = rawTopic.toUpperCase().replace(/\//g, '_');
    try {
      const response = await executeShopifyGraphQL<{
        webhookSubscriptionCreate: {
          userErrors: Array<{ field: string[]; message: string }>;
          webhookSubscription: { id: string; topic: string } | null;
        };
      }>(
        shopDomain,
        accessToken,
        mutation,
        {
          topic: formattedTopic,
          webhookSubscription: {
            callbackUrl,
            format: 'JSON',
          },
        },
        options
      );

      const payload = response.data?.webhookSubscriptionCreate;
      if (payload?.userErrors && payload.userErrors.length > 0) {
        const errMsg = payload.userErrors.map(e => e.message).join('; ');
        results.push({
          topic: formattedTopic,
          success: errMsg.toLowerCase().includes('already taken') || errMsg.toLowerCase().includes('already exists'),
          error: errMsg,
        });
      } else if (payload?.webhookSubscription) {
        results.push({
          topic: formattedTopic,
          success: true,
          id: payload.webhookSubscription.id,
        });
      } else {
        results.push({
          topic: formattedTopic,
          success: false,
          error: 'No subscription created in response',
        });
      }
    } catch (err: any) {
      results.push({
        topic: formattedTopic,
        success: false,
        error: err?.message || 'Failed to register webhook',
      });
    }
  }

  return results;
}

export interface WebhookSubscriptionsFetchResult {
  subscriptions: Array<{ id: string; topic: string; callbackUrl?: string }>;
  isComplete: boolean;
  status: PaginationCompletenessStatus;
  pagesFetched: number;
  lastCursor: string | null;
  reason?: string;
  error?: string;
}

/**
 * Queries active webhook subscriptions from Shopify Admin API with full cursor pagination safeguards.
 * Detects missing cursors, repeated/non-advancing cursors, safety page limit exhaustion, and API errors.
 */
export async function getShopifyWebhookSubscriptionsWithStatus(
  shopDomain: string,
  accessToken: string,
  options: { customFetch?: typeof fetch; maxPages?: number } = {}
): Promise<WebhookSubscriptionsFetchResult> {
  const allSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string }> = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageSafety = 0;
  const maxPages = options.maxPages ?? 100;
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();

  const query = `
    query getWebhooks($first: Int!, $after: String) {
      webhookSubscriptions(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
        }
      }
    }
  `;

  type WebhookSubscriptionsPageData = {
    webhookSubscriptions: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          id: string;
          topic: string;
          endpoint?: { callbackUrl?: string };
        };
      }>;
    };
  };

  while (hasNextPage && pageSafety < maxPages) {
    pageSafety++;
    let response: { data?: WebhookSubscriptionsPageData };
    try {
      response = await executeShopifyGraphQL<WebhookSubscriptionsPageData>(
        shopDomain,
        accessToken,
        query,
        { first: 50, after: cursor },
        options
      );
    } catch (err: any) {
      return {
        subscriptions: allSubscriptions,
        isComplete: false,
        status: 'failed_api_error',
        pagesFetched: pageSafety,
        lastCursor: cursor,
        reason: `Shopify Admin API error on webhook subscriptions page ${pageSafety}: ${err?.message || 'unknown error'}`,
        error: err?.message || 'Admin API error',
      };
    }

    const edges = response.data?.webhookSubscriptions?.edges || [];
    for (const edge of edges) {
      if (!seenIds.has(edge.node.id)) {
        seenIds.add(edge.node.id);
        allSubscriptions.push({
          id: edge.node.id,
          topic: edge.node.topic,
          callbackUrl: edge.node.endpoint?.callbackUrl,
        });
      }
    }

    const pageInfo = response.data?.webhookSubscriptions?.pageInfo;
    const nextHasNext = Boolean(pageInfo?.hasNextPage);
    const nextCursor = pageInfo?.endCursor || null;

    if (nextHasNext && !nextCursor) {
      return {
        subscriptions: allSubscriptions,
        isComplete: false,
        status: 'incomplete_missing_cursor',
        pagesFetched: pageSafety,
        lastCursor: cursor,
        reason: `Webhook subscriptions page ${pageSafety} reported hasNextPage=true with null endCursor.`,
      };
    }

    if (nextCursor && nextCursor === cursor) {
      return {
        subscriptions: allSubscriptions,
        isComplete: false,
        status: 'incomplete_non_advancing_cursor',
        pagesFetched: pageSafety,
        lastCursor: nextCursor,
        reason: `Webhook subscriptions cursor did not advance from '${cursor}'.`,
      };
    }

    if (nextCursor && seenCursors.has(nextCursor)) {
      return {
        subscriptions: allSubscriptions,
        isComplete: false,
        status: 'incomplete_repeated_cursor',
        pagesFetched: pageSafety,
        lastCursor: nextCursor,
        reason: `Webhook subscriptions pagination repeated cursor '${nextCursor}'.`,
      };
    }

    if (nextCursor) {
      seenCursors.add(nextCursor);
    }

    hasNextPage = nextHasNext;
    cursor = nextCursor;

    if (hasNextPage && pageSafety >= maxPages) {
      return {
        subscriptions: allSubscriptions,
        isComplete: false,
        status: 'incomplete_page_limit',
        pagesFetched: pageSafety,
        lastCursor: cursor,
        reason: `Reached webhook pagination safety limit (${maxPages} pages) while more subscriptions remained.`,
      };
    }
  }

  return {
    subscriptions: allSubscriptions,
    isComplete: true,
    status: 'complete',
    pagesFetched: pageSafety,
    lastCursor: cursor,
  };
}

/**
 * Queries active webhook subscriptions from Shopify Admin API with cursor pagination.
 */
export async function getShopifyWebhookSubscriptions(
  shopDomain: string,
  accessToken: string,
  options: { customFetch?: typeof fetch; maxPages?: number } = {}
): Promise<Array<{ id: string; topic: string; callbackUrl?: string }>> {
  const res = await getShopifyWebhookSubscriptionsWithStatus(shopDomain, accessToken, options);
  if (res.status === 'failed_api_error') {
    throw new Error(res.error || res.reason || 'Failed to query webhook subscriptions');
  }
  return res.subscriptions;
}

export interface WebhookVerificationResult {
  verified: boolean;
  status: WebhookStatusCategory;
  verificationMode: 'live';
  requiredTopics: string[];
  activeTopics: string[];
  missingTopics: string[];
  mismatchedTopics: string[];
  mismatchedSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string; expectedUrl: string }>;
  liveSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string }>;
  completenessStatus: PaginationCompletenessStatus;
  verifiedAt: string;
  webhookLastVerifiedAt: string | null;
  message: string;
}

function normalizeWebhookUrl(u?: string): string {
  if (!u) return '';
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u.trim().replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Actively queries Shopify Admin GraphQL API to verify existing webhook subscriptions.
 * Validates both required topics and configured callback URL, tracks complete pagination,
 * and stores a dedicated webhookLastVerifiedAt timestamp only when live inspection succeeds cleanly.
 */
export async function verifyShopifyWebhookSubscriptionsLive(
  repo: DatabaseRepository,
  workspaceId: string,
  options: { customFetch?: typeof fetch; maxPages?: number } = {}
): Promise<WebhookVerificationResult> {
  const connection = await repo.getShopifyConnection(workspaceId);
  const nowIso = new Date().toISOString();

  if (!connection || connection.status !== 'connected') {
    return {
      verified: false,
      status: 'not_configured',
      verificationMode: 'live',
      requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
      activeTopics: [],
      missingTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
      mismatchedTopics: [],
      mismatchedSubscriptions: [],
      liveSubscriptions: [],
      completenessStatus: 'complete',
      verifiedAt: nowIso,
      webhookLastVerifiedAt: null,
      message: 'Shopify is not currently connected to this workspace.',
    };
  }

  try {
    const accessToken = await getValidShopifyAccessToken(repo, workspaceId, { customFetch: options.customFetch });
    const subResult = await getShopifyWebhookSubscriptionsWithStatus(connection.shopDomain, accessToken, options);

    if (subResult.status === 'failed_api_error') {
      const preservedLastVerified = connection.webhookLastVerifiedAt || null;
      await repo.saveShopifyConnection({
        ...connection,
        webhookVerificationStatus: 'verification_unavailable',
        webhookVerificationDetails: {
          completenessStatus: subResult.status,
          error: subResult.error || subResult.reason,
          checkedAt: nowIso,
        },
        updatedAt: nowIso,
      });

      return {
        verified: false,
        status: 'verification_unavailable',
        verificationMode: 'live',
        requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
        activeTopics: [],
        missingTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
        mismatchedTopics: [],
        mismatchedSubscriptions: [],
        liveSubscriptions: subResult.subscriptions,
        completenessStatus: subResult.status,
        verifiedAt: nowIso,
        webhookLastVerifiedAt: preservedLastVerified,
        message: `Live webhook verification unavailable: ${subResult.error || subResult.reason}`,
      };
    }

    if (!subResult.isComplete) {
      const preservedLastVerified = connection.webhookLastVerifiedAt || null;
      await repo.saveShopifyConnection({
        ...connection,
        webhookVerificationStatus: 'verification_incomplete',
        webhookVerificationDetails: {
          completenessStatus: subResult.status,
          reason: subResult.reason,
          pagesFetched: subResult.pagesFetched,
          lastCursor: subResult.lastCursor,
          checkedAt: nowIso,
        },
        updatedAt: nowIso,
      });

      return {
        verified: false,
        status: 'verification_incomplete',
        verificationMode: 'live',
        requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
        activeTopics: [],
        missingTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
        mismatchedTopics: [],
        mismatchedSubscriptions: [],
        liveSubscriptions: subResult.subscriptions,
        completenessStatus: subResult.status,
        verifiedAt: nowIso,
        webhookLastVerifiedAt: preservedLastVerified,
        message: `Live webhook verification incomplete (${subResult.status}): ${subResult.reason}`,
      };
    }

    const liveSubs = subResult.subscriptions;
    const { webhookUrl } = getShopifyOAuthEnv();
    const expectedNormalizedUrl = normalizeWebhookUrl(webhookUrl);

    const activeTopics: string[] = [];
    const missingTopics: string[] = [];
    const mismatchedTopics: string[] = [];
    const mismatchedSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string; expectedUrl: string }> = [];

    for (const requiredTopic of DEFAULT_SHOPIFY_WEBHOOK_TOPICS) {
      const matchingSubs = liveSubs.filter(
        s => s.topic.toUpperCase().replace(/\//g, '_') === requiredTopic
      );

      if (matchingSubs.length === 0) {
        missingTopics.push(requiredTopic);
      } else {
        const hasUrlMatch = expectedNormalizedUrl
          ? matchingSubs.some(s => normalizeWebhookUrl(s.callbackUrl) === expectedNormalizedUrl)
          : true;

        if (hasUrlMatch) {
          activeTopics.push(requiredTopic);
        } else {
          mismatchedTopics.push(requiredTopic);
          for (const sub of matchingSubs) {
            mismatchedSubscriptions.push({
              id: sub.id,
              topic: sub.topic,
              callbackUrl: sub.callbackUrl,
              expectedUrl: webhookUrl,
            });
          }
        }
      }
    }

    const isAllActive = missingTopics.length === 0 && mismatchedTopics.length === 0;
    const hasMismatch = mismatchedTopics.length > 0;
    const status: WebhookStatusCategory = isAllActive
      ? 'active'
      : hasMismatch
      ? 'mismatch'
      : activeTopics.length > 0
      ? 'partially_registered'
      : 'unverified';

    const message = isAllActive
      ? `All ${activeTopics.length} required webhook subscriptions are actively verified on Shopify Admin API pointing to ${webhookUrl}.`
      : hasMismatch
      ? `Webhook callback URL mismatch: ${mismatchedTopics.join(', ')} point to different endpoints than configured ${webhookUrl}.`
      : activeTopics.length > 0
      ? `Partially verified: ${activeTopics.length} of ${DEFAULT_SHOPIFY_WEBHOOK_TOPICS.length} webhooks active on Shopify. Missing: ${missingTopics.join(', ')}.`
      : `No matching webhooks found active on Shopify Admin API for required topics: ${DEFAULT_SHOPIFY_WEBHOOK_TOPICS.join(', ')}.`;

    // Persist verified live subscriptions and dedicated webhookLastVerifiedAt timestamp
    await repo.saveShopifyConnection({
      ...connection,
      webhookSubscriptions: liveSubs.map(s => {
        const normSubUrl = normalizeWebhookUrl(s.callbackUrl);
        const matchesExpected = !expectedNormalizedUrl || normSubUrl === expectedNormalizedUrl;
        return {
          id: s.id,
          topic: s.topic,
          callbackUrl: s.callbackUrl,
          active: matchesExpected,
          status: matchesExpected ? ('verified' as const) : ('mismatch' as const),
          mismatchReason: matchesExpected
            ? undefined
            : `Callback URL ${s.callbackUrl || 'missing'} does not match expected ${webhookUrl}`,
        };
      }),
      webhookLastVerifiedAt: nowIso,
      webhookVerificationStatus: status,
      webhookVerificationDetails: {
        completenessStatus: 'complete',
        requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
        activeTopics,
        missingTopics,
        mismatchedTopics,
        mismatchedSubscriptions,
        expectedCallbackUrl: webhookUrl,
        verifiedAt: nowIso,
      },
      updatedAt: nowIso,
    });

    return {
      verified: isAllActive,
      status,
      verificationMode: 'live',
      requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
      activeTopics,
      missingTopics,
      mismatchedTopics,
      mismatchedSubscriptions,
      liveSubscriptions: liveSubs,
      completenessStatus: 'complete',
      verifiedAt: nowIso,
      webhookLastVerifiedAt: nowIso,
      message,
    };
  } catch (err: any) {
    const preservedLastVerified = connection.webhookLastVerifiedAt || null;
    await repo.saveShopifyConnection({
      ...connection,
      webhookVerificationStatus: 'verification_unavailable',
      webhookVerificationDetails: {
        completenessStatus: 'failed_api_error',
        error: err?.message || 'Admin API error',
        checkedAt: nowIso,
      },
      updatedAt: nowIso,
    }).catch(() => {});

    return {
      verified: false,
      status: 'verification_unavailable',
      verificationMode: 'live',
      requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
      activeTopics: [],
      missingTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
      mismatchedTopics: [],
      mismatchedSubscriptions: [],
      liveSubscriptions: [],
      completenessStatus: 'failed_api_error',
      verifiedAt: nowIso,
      webhookLastVerifiedAt: preservedLastVerified,
      message: `Failed to verify Shopify webhook subscriptions: ${err?.message || 'Admin API error'}`,
    };
  }
}

export interface WebhookProcessResult {
  processed: boolean;
  duplicate: boolean;
  topic: string;
  shopDomain: string;
  message?: string;
}

/**
 * Maps a Shopify REST-format webhook payload (which Shopify sends in webhooks)
 * into the AIXSHOP domain Product model.
 */
export function mapWebhookPayloadToDomainProduct(
  payload: any,
  currency = 'USD',
  storeDomain?: string
): Product {
  const numericId = String(payload.id || '');
  const prodId = `p_shopify_${numericId}`;

  const variants: Variant[] = (payload.variants || []).map((v: any, idx: number) => {
    const vNumId = String(v.id || `${numericId}_${idx}`);
    const parsedPrice = parseSourcePrice(v.price);

    return {
      id: `v_shopify_${vNumId}`,
      sku: (v.sku || '').trim(),
      title: (v.title || '').trim(),
      barcode: (v.barcode || '').trim(),
      price: parsedPrice.price,
      inventoryCount: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
      attributes: {
        sourceVariantId: vNumId,
        shopifyVariantGid: `gid://shopify/ProductVariant/${vNumId}`,
      },
    };
  });

  const images = payload.images || [];
  const primaryImageUrl = images[0]?.src || payload.image?.src || '';

  const cleanDesc = (payload.body_html || '')
    .replace(/<[^>]*>?/gm, '')
    .trim();

  const canonicalDomain = storeDomain
    ? normalizeShopDomain(storeDomain)
    : '';
  const productUrl = canonicalDomain && payload.handle
    ? `https://${canonicalDomain}/products/${payload.handle}`
    : canonicalDomain && numericId
    ? `https://${canonicalDomain}/products/${numericId}`
    : '';

  const prod: Product = {
    id: prodId,
    title: (payload.title || '').trim() || 'Untitled Product',
    brand: (payload.vendor || '').trim(),
    category: (payload.product_type || '').trim(),
    description: cleanDesc,
    image: primaryImageUrl,
    status: payload.status === 'archived' ? 'archived' : payload.status === 'draft' ? 'draft' : 'active',
    completenessScore: 0,
    evidenceCoverageScore: 0,
    externalDiscoveryStatus: 'observed_in_sample',
    attributes: {
      sourcePlatform: 'shopify',
      sourceProductId: numericId,
      shopifyGid: `gid://shopify/Product/${numericId}`,
      shopifyHandle: payload.handle || '',
      shopifyStatus: payload.status || 'active',
      shopifyUpdatedAt: payload.updated_at || new Date().toISOString(),
      provenance: 'shopify_webhook',
      canonicalProductUrl: productUrl,
      urlProvenance: canonicalDomain ? 'verified_shopify_store_domain' : 'unavailable_store_domain',
    },
    variants,
    offers: variants.length > 0 && variants[0].price !== null ? [{
      id: `off_${prodId}_storefront`,
      channel: 'Direct Storefront',
      price: variants[0].price,
      currency,
      availability: variants.some(v => (v.inventoryCount ?? 1) > 0) ? 'in_stock' : 'out_of_stock',
      condition: 'new',
      url: productUrl,
      merchantId: 'shopify',
      lastSync: new Date().toISOString(),
    }] : [],
    evidenceDocuments: [],
    findingsCount: 0,
    lastAudited: new Date().toISOString(),
  };

  prod.completenessScore = calculateProductCompleteness(prod);
  return prod;
}

/**
 * Verifies and processes incoming Shopify webhook events.
 * Enforces raw body HMAC verification, delivery ID idempotency, and tenant isolation.
 */
export async function processShopifyWebhook(
  repo: DatabaseRepository,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<WebhookProcessResult> {
  const getHeader = (name: string): string => {
    const val = headers[name.toLowerCase()] || headers[name];
    if (Array.isArray(val)) return val[0] || '';
    return val || '';
  };

  const hmacHeader = getHeader('X-Shopify-Hmac-Sha256');
  const topic = getHeader('X-Shopify-Topic');
  const rawShop = getHeader('X-Shopify-Shop-Domain');
  const deliveryId = getHeader('X-Shopify-Delivery-Id');

  if (!hmacHeader) {
    throw new Error('[AIXSHOP Webhook Error] Missing X-Shopify-Hmac-Sha256 header.');
  }

  const { apiSecret } = getShopifyOAuthEnv();
  if (!apiSecret) {
    throw new Error('[AIXSHOP Webhook Error] SHOPIFY_API_SECRET is not configured on server.');
  }

  // 1. Verify HMAC against exact raw request body
  const isValidHmac = verifyShopifyWebhookHmac(rawBody, apiSecret, hmacHeader);
  if (!isValidHmac) {
    throw new Error('[AIXSHOP Webhook Error] Invalid webhook HMAC signature. Unauthorized webhook delivery.');
  }

  const shop = normalizeShopDomain(rawShop);
  const connection = await repo.getShopifyConnectionByShop(shop);
  if (!connection) {
    return {
      processed: false,
      duplicate: false,
      topic,
      shopDomain: shop,
      message: `No active AIXSHOP connection found for shop ${shop}.`,
    };
  }

  const workspaceId = connection.workspaceId;

  // 2. Parse payload safely
  let payload: any;
  try {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    payload = JSON.parse(bodyStr);
  } catch (err: any) {
    throw new Error(`[AIXSHOP Webhook Error] Failed to parse JSON payload: ${err.message}`);
  }

  const eventId = deliveryId || String(payload.id || `${Date.now()}_${Math.random()}`);

  // 3. Atomically claim webhook event for idempotency
  const claimResult = await repo.claimShopifyWebhookEvent({
    id: `whevt_${shop}_${topic.replace(/\//g, '_')}_${eventId}`,
    workspaceId,
    shopDomain: shop,
    eventId,
    topic,
    deliveryId: deliveryId || null,
    payload,
    status: 'processing',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (!claimResult.claimed) {
    // Duplicate delivery already processed or processing
    return {
      processed: true,
      duplicate: true,
      topic,
      shopDomain: shop,
      message: 'Duplicate webhook delivery acknowledged and skipped.',
    };
  }

  // 4. Process event based on topic with workspace isolation
  try {
    await withWorkspaceLock(workspaceId, async () => {
      const catalog: StoragePayloadV1 = (await repo.loadWorkspaceCatalog(workspaceId)) || {
        storeProfile: {
          name: 'Merchant Store',
          domain: shop,
          currency: 'USD',
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard',
          connectors: [],
          tier: 'Free Audit',
          skuLimit: 2500,
          skuCount: 0,
        },
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
      };

      if (topic === 'app/uninstalled') {
        await disconnectShopify(repo, workspaceId);
      } else if (topic === 'products/create' || topic === 'products/update') {
        const storeProfile = await repo.getStoreByWorkspace(workspaceId);
        const subscription = await repo.getSubscriptionByWorkspace(workspaceId);
        const entitlement = resolveWorkspacePlanEntitlement(storeProfile, subscription);

        const incomingProduct = mapWebhookPayloadToDomainProduct(payload, storeProfile?.currency || 'USD', shop);
        const incomingSkus = incomingProduct.variants.length || 1;

        const currentProducts = [...catalog.products];
        const existingIdx = currentProducts.findIndex(
          p => p.id === incomingProduct.id || p.attributes?.sourceProductId === incomingProduct.attributes?.sourceProductId
        );

        if (existingIdx >= 0) {
          // Update: preserve merchant edits and check for out-of-order delivery
          const existing = currentProducts[existingIdx];

          // Out-of-order delivery protection: discard older updates
          if (payload.updated_at && existing.attributes?.shopifyUpdatedAt) {
            const incomingTime = new Date(payload.updated_at).getTime();
            const existingTime = new Date(existing.attributes.shopifyUpdatedAt).getTime();
            if (!isNaN(incomingTime) && !isNaN(existingTime) && incomingTime < existingTime) {
              console.warn(`[AIXSHOP Webhook] Out-of-order webhook event discarded for product ${incomingProduct.id}. Incoming: ${payload.updated_at}, Existing: ${existing.attributes.shopifyUpdatedAt}`);
              await repo.updateShopifyWebhookEventStatus(
                eventId,
                shop,
                topic,
                'ignored',
                'Stale out-of-order event skipped: payload updated_at is older than existing product state.'
              );
              return;
            }
          }

          const conflict = detectProductConflict(incomingProduct, existing);
          const updatedProduct: Product = {
            ...incomingProduct,
            title: conflict.isConflict ? existing.title : incomingProduct.title,
            brand: conflict.isConflict ? existing.brand : incomingProduct.brand,
            category: conflict.isConflict ? existing.category : incomingProduct.category,
            description: conflict.isConflict ? existing.description : incomingProduct.description,
            image: incomingProduct.image || existing.image,
            evidenceDocuments: existing.evidenceDocuments || [],
            findingsCount: existing.findingsCount || 0,
          };
          updatedProduct.completenessScore = calculateProductCompleteness(updatedProduct);
          currentProducts[existingIdx] = updatedProduct;
        } else {
          // Create: check plan quota
          const currentUsage = countCatalogSkus(currentProducts);
          if (!entitlement.isUnlimited && currentUsage + incomingSkus > entitlement.skuLimit) {
            // Exceeds quota: fail safely without crashing
            console.warn(`[AIXSHOP Webhook] Product ${incomingProduct.id} rejected: exceeds workspace SKU quota (${entitlement.skuLimit}).`);
            await repo.updateShopifyWebhookEventStatus(
              eventId,
              shop,
              topic,
              'ignored',
              `Product creation skipped: workspace reached SKU limit of ${entitlement.skuLimit}.`
            );
            return;
          }
          currentProducts.push(incomingProduct);
        }

        await repo.saveWorkspaceCatalog(workspaceId, {
          ...catalog,
          products: currentProducts,
        });

        if (storeProfile) {
          await repo.saveStoreProfile(workspaceId, {
            ...storeProfile,
            skuCount: countCatalogSkus(currentProducts),
          });
        }
      } else if (topic === 'products/delete') {
        const numericId = String(payload.id || '');
        const targetId = `p_shopify_${numericId}`;
        const currentProducts = catalog.products.filter(
          (p: Product) => p.id !== targetId && p.attributes?.sourceProductId !== numericId
        );

        await repo.saveWorkspaceCatalog(workspaceId, {
          ...catalog,
          products: currentProducts,
        });

        const storeProfile = await repo.getStoreByWorkspace(workspaceId);
        if (storeProfile) {
          await repo.saveStoreProfile(workspaceId, {
            ...storeProfile,
            skuCount: countCatalogSkus(currentProducts),
          });
        }
      }
    });

    await repo.updateShopifyWebhookEventStatus(eventId, shop, topic, 'processed');

    return {
      processed: true,
      duplicate: false,
      topic,
      shopDomain: shop,
      message: `Successfully processed Shopify webhook for ${topic}.`,
    };
  } catch (err: any) {
    await repo.updateShopifyWebhookEventStatus(eventId, shop, topic, 'failed', err?.message);
    throw err;
  }
}
