import { DatabaseRepository } from '../db/repository';
import { verifyShopifyWebhookHmac } from '../security/encryption';
import { getShopifyOAuthEnv, disconnectShopify } from './oauthService';
import { normalizeShopDomain, executeShopifyGraphQL } from './client';
import { Product, Variant } from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { parseSourcePrice } from '../../domain/validation/price';
import { calculateProductCompleteness } from '../../domain/catalog/completeness';
import { resolveWorkspacePlanEntitlement, countCatalogSkus, withWorkspaceLock } from '../services/entitlementService';
import { detectProductConflict } from '../../domain/ingestion/storeIngestion';

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

/**
 * Queries active webhook subscriptions from Shopify Admin API.
 */
export async function getShopifyWebhookSubscriptions(
  shopDomain: string,
  accessToken: string,
  options: { customFetch?: typeof fetch } = {}
): Promise<Array<{ id: string; topic: string; callbackUrl?: string }>> {
  const query = `
    query getWebhooks {
      webhookSubscriptions(first: 25) {
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

  try {
    const response = await executeShopifyGraphQL<{
      webhookSubscriptions: {
        edges: Array<{
          node: {
            id: string;
            topic: string;
            endpoint?: { callbackUrl?: string };
          };
        }>;
      };
    }>(shopDomain, accessToken, query, {}, options);

    return (response.data?.webhookSubscriptions?.edges || []).map(e => ({
      id: e.node.id,
      topic: e.node.topic,
      callbackUrl: e.node.endpoint?.callbackUrl,
    }));
  } catch (err: any) {
    console.warn(`[AIXSHOP Webhooks] Failed to fetch webhook subscriptions for ${shopDomain}:`, err.message);
    return [];
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
export function mapWebhookPayloadToDomainProduct(payload: any, currency = 'USD'): Product {
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
    },
    variants,
    offers: variants.length > 0 && variants[0].price !== null ? [{
      id: `off_${prodId}_storefront`,
      channel: 'Direct Storefront',
      price: variants[0].price,
      currency,
      availability: variants.some(v => (v.inventoryCount ?? 1) > 0) ? 'in_stock' : 'out_of_stock',
      condition: 'new',
      url: `https://myshopify.com/products/${payload.handle || numericId}`,
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

        const incomingProduct = mapWebhookPayloadToDomainProduct(payload, storeProfile?.currency || 'USD');
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
