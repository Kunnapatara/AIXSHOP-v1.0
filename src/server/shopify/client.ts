import {
  ShopifyProductConnectionQueryResponse,
  ShopifyGraphQLProductNode
} from './types';

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

/**
 * Validates that the provided hostname matches the required Shopify format:
 * [a-zA-Z0-9][a-zA-Z0-9-]*.myshopify.com
 * Prevents SSRF, URL injection, and unverified redirect destinations.
 */
export function isValidShopDomain(shop: string): boolean {
  if (!shop || typeof shop !== 'string') return false;
  const trimmed = shop.trim().toLowerCase();
  // Valid shop name must not start or end with a hyphen, and end strictly with .myshopify.com
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(trimmed);
}

/**
 * Normalizes a raw shop input string into a canonical myshopify.com domain.
 * Handles inputs like "my-store", "my-store.myshopify.com", "https://my-store.myshopify.com/".
 */
export function normalizeShopDomain(rawShop: string): string {
  if (!rawShop || typeof rawShop !== 'string') return '';
  let cleaned = rawShop.trim().toLowerCase();

  // Strip protocol
  if (cleaned.startsWith('https://')) cleaned = cleaned.slice(8);
  if (cleaned.startsWith('http://')) cleaned = cleaned.slice(7);

  // Strip path/query if present
  cleaned = cleaned.split('/')[0];
  cleaned = cleaned.split('?')[0];
  cleaned = cleaned.split(':')[0]; // strip port

  // Append .myshopify.com if bare name provided
  if (!cleaned.includes('.')) {
    cleaned = `${cleaned}.myshopify.com`;
  }

  return cleaned;
}

export interface GraphQLThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphQLCostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: GraphQLThrottleStatus;
}

export interface GraphQLExecutionResult<T> {
  data: T;
  cost?: GraphQLCostExtension;
  extensions?: any;
}

export interface GraphQLClientOptions {
  customFetch?: typeof fetch;
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
}

/**
 * Executes an authenticated GraphQL query or mutation against the Shopify Admin API.
 * Pinned to official supported version (2025-01).
 * Features query cost and throttle inspection, rate limit backoff with jitter, and retries.
 */
export async function executeShopifyGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, any> = {},
  options: GraphQLClientOptions = {}
): Promise<GraphQLExecutionResult<T>> {
  const shop = normalizeShopDomain(shopDomain);
  if (!isValidShopDomain(shop)) {
    throw new Error(`[AIXSHOP Shopify Client] Invalid Shopify domain "${shopDomain}". Expected *.myshopify.com format.`);
  }

  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new Error('[AIXSHOP Shopify Client] Shopify access token is missing or empty.');
  }

  const endpoint = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const fetchFn = options.customFetch || fetch;
  const maxRetries = options.maxRetries ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 15000;

  let attempt = 0;

  while (attempt <= maxRetries) {
    let controller: AbortController | null = null;
    let timer: NodeJS.Timeout | null = null;

    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(() => controller?.abort(), timeoutMs);
      }

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller ? controller.signal : undefined,
      });

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      // Handle HTTP 429 Too Many Requests (Rate limit hit)
      if (response.status === 429) {
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(`[AIXSHOP Shopify Client] Rate limit exceeded (HTTP 429) after ${maxRetries} retries.`);
        }
        const retryAfterSec = parseFloat(response.headers.get('Retry-After') || '1');
        const sleepMs = Math.max(retryAfterSec * 1000, baseBackoffMs * Math.pow(2, attempt)) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }

      // Handle transient server errors (500, 502, 503, 504)
      if (response.status >= 500 && response.status < 600) {
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(`[AIXSHOP Shopify Client] Transient server error HTTP ${response.status} from Shopify after ${maxRetries} retries.`);
        }
        const sleepMs = baseBackoffMs * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }

      // Handle 401 Unauthorized or 403 Forbidden
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `[AIXSHOP Shopify Client] Shopify authorization error HTTP ${response.status}: Invalid, expired, or insufficient access token.`
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[AIXSHOP Shopify Client] HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, 300)}`);
      }

      const json = await response.json();

      // Separate GraphQL-level errors from HTTP 200 success
      if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
        const firstErr = json.errors[0];
        const msg = firstErr.message || JSON.stringify(firstErr);
        // Check if throttled via GraphQL extension error
        if (msg.toLowerCase().includes('throttled')) {
          attempt++;
          if (attempt <= maxRetries) {
            const sleepMs = baseBackoffMs * Math.pow(2, attempt) + Math.random() * 200;
            await new Promise((r) => setTimeout(r, sleepMs));
            continue;
          }
        }
        throw new Error(`[AIXSHOP Shopify GraphQL Error] ${msg}`);
      }

      // Query cost and throttle status inspection
      const cost: GraphQLCostExtension | undefined = json.extensions?.cost;
      if (cost?.throttleStatus) {
        const { currentlyAvailable, restoreRate } = cost.throttleStatus;
        const requestedQueryCost = cost.requestedQueryCost;
        if (requestedQueryCost && currentlyAvailable < requestedQueryCost && restoreRate > 0) {
          // Store is nearing throttle limit, throttle proactively
          const deficit = requestedQueryCost - currentlyAvailable;
          const waitMs = Math.ceil((deficit / restoreRate) * 1000);
          if (waitMs > 0 && waitMs < 5000) {
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      }

      return {
        data: json.data as T,
        cost,
        extensions: json.extensions,
      };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      const isTransient =
        err.name === 'AbortError' ||
        err.message?.includes('fetch failed') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('network timeout');

      if (isTransient && attempt < maxRetries) {
        attempt++;
        const sleepMs = baseBackoffMs * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`[AIXSHOP Shopify Client] Failed request to ${shop} after ${maxRetries} attempts.`);
}

/**
 * Verifies that the Shopify connection credentials are valid and active
 * by issuing a lightweight Shop metadata query.
 */
export async function verifyShopifyConnection(
  shopDomain: string,
  accessToken: string,
  options?: GraphQLClientOptions
): Promise<{ valid: boolean; shopName?: string; myshopifyDomain?: string; currencyCode?: string; error?: string }> {
  const query = `
    query getShopMetadata {
      shop {
        name
        myshopifyDomain
        currencyCode
      }
    }
  `;

  try {
    const res = await executeShopifyGraphQL<{ shop: { name: string; myshopifyDomain: string; currencyCode: string } }>(
      shopDomain,
      accessToken,
      query,
      {},
      options
    );

    if (res.data?.shop?.myshopifyDomain) {
      return {
        valid: true,
        shopName: res.data.shop.name,
        myshopifyDomain: res.data.shop.myshopifyDomain,
        currencyCode: res.data.shop.currencyCode,
      };
    }

    return { valid: false, error: 'Shop metadata query returned empty payload' };
  } catch (err: any) {
    return { valid: false, error: err?.message || 'Connection verification failed' };
  }
}

/**
 * Fetches a single page of products and their variants using cursor-based pagination.
 */
export async function fetchProductsPage(
  shopDomain: string,
  accessToken: string,
  cursor: string | null = null,
  limit = 50,
  options?: GraphQLClientOptions
): Promise<{
  products: ShopifyGraphQLProductNode[];
  hasNextPage: boolean;
  endCursor: string | null;
  cost?: GraphQLCostExtension;
}> {
  const query = `
    query getProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            id
            title
            descriptionHtml
            description
            vendor
            productType
            handle
            status
            tags
            createdAt
            updatedAt
            images(first: 20) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  inventoryQuantity
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const variables: { first: number; after?: string | null } = {
    first: Math.min(Math.max(limit, 1), 250),
    after: cursor || null,
  };

  const res = await executeShopifyGraphQL<ShopifyProductConnectionQueryResponse>(
    shopDomain,
    accessToken,
    query,
    variables,
    options
  );

  const productEdges = res.data?.products?.edges || [];
  const products = productEdges.map(e => e.node);
  const pageInfo = res.data?.products?.pageInfo;

  return {
    products,
    hasNextPage: Boolean(pageInfo?.hasNextPage),
    endCursor: pageInfo?.endCursor || null,
    cost: res.cost,
  };
}
