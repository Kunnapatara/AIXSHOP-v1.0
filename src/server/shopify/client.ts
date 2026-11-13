import {
  ShopifyProductConnectionQueryResponse,
  ShopifyGraphQLProductNode
} from './types';

/**
 * SAFE QUARTERLY SHOPIFY API VERSION UPGRADE PROCEDURE:
 * 1. Shopify releases stable Admin GraphQL versions quarterly (YYYY-01, YYYY-04, YYYY-07, YYYY-10).
 * 2. Each stable version is officially supported for 12 months.
 * 3. AIXSHOP pins to the latest stable release (currently 2026-10).
 * 4. To upgrade:
 *    a) Verify schema changes in Shopify API Release Notes: https://shopify.dev/docs/api/usage/versioning
 *    b) Update SHOPIFY_API_VERSION in .env / environment configurations.
 *    c) Run `npm test` and `npm run lint` to verify query compatibility.
 *    d) Inspect the X-Shopify-API-Version response header in production diagnostics to verify pinning.
 */
export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

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
  apiVersionReturned?: string | null;
  versionFallForwardDetected?: boolean;
}

export interface GraphQLClientOptions {
  customFetch?: typeof fetch;
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
}

/**
 * Executes an authenticated GraphQL query or mutation against the Shopify Admin API.
 * Pinned to official supported version (2026-10).
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

      // Inspect actual API version returned by Shopify
      const apiVersionReturned = response.headers?.get
        ? (response.headers.get('x-shopify-api-version') || response.headers.get('X-Shopify-API-Version'))
        : null;
      const versionFallForwardDetected = Boolean(apiVersionReturned && apiVersionReturned !== SHOPIFY_API_VERSION);
      if (versionFallForwardDetected) {
        console.warn(
          `[AIXSHOP Shopify Client Warning] API version mismatch/fall-forward: requested "${SHOPIFY_API_VERSION}", but Shopify returned "${apiVersionReturned}".`
        );
      }

      return {
        data: json.data as T,
        cost,
        extensions: json.extensions,
        apiVersionReturned: apiVersionReturned || null,
        versionFallForwardDetected,
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
  variantCompleteness?: Record<string, import('./types').ProductVariantCompleteness>;
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
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                cursor
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
  const variantCompleteness: Record<string, import('./types').ProductVariantCompleteness> = {};

  // Retrieve complete variants for products exceeding the single-page limit (100 variants)
  for (const product of products) {
    const initialEdges = product.variants?.edges || [];
    const hasNext = Boolean(product.variants?.pageInfo?.hasNextPage);
    const endCursor = product.variants?.pageInfo?.endCursor || null;

    if (!hasNext) {
      variantCompleteness[product.id] = {
        productId: product.id,
        productTitle: product.title || 'Untitled',
        isComplete: true,
        status: 'complete',
        variantsFetched: initialEdges.length,
        uniqueVariantsCount: initialEdges.length,
        pagesFetched: 1,
        lastCursor: endCursor,
        hasNextPage: false,
      };
      continue;
    }

    if (hasNext && !endCursor) {
      variantCompleteness[product.id] = {
        productId: product.id,
        productTitle: product.title || 'Untitled',
        isComplete: false,
        status: 'incomplete_missing_cursor',
        variantsFetched: initialEdges.length,
        uniqueVariantsCount: initialEdges.length,
        pagesFetched: 1,
        lastCursor: null,
        hasNextPage: true,
        reason: 'Shopify reported hasNextPage=true on variants but endCursor was null.',
      };
      continue;
    }

    let vHasNext = true;
    let vCursor: string | null = endCursor;
    let vSafetyPages = 1;
    let terminationStatus: import('./types').VariantCompletenessStatus = 'complete';
    let terminationReason: string | undefined;
    let errorDetail: string | undefined;

    const seenVariantCursors = new Set<string>();
    if (vCursor) seenVariantCursors.add(vCursor);
    const seenVariantIds = new Set(initialEdges.map(e => e.node.id));

    while (vHasNext && vCursor && vSafetyPages < 50) {
      vSafetyPages++;
      let more: { variants: import('./types').ShopifyGraphQLVariantEdge[]; hasNextPage: boolean; endCursor: string | null };
      try {
        more = await fetchRemainingProductVariants(
          shopDomain,
          accessToken,
          product.id,
          vCursor,
          options
        );
      } catch (err: any) {
        terminationStatus = 'failed_api_error';
        terminationReason = `GraphQL API error during variant pagination: ${err?.message || 'unknown error'}`;
        errorDetail = err?.message;
        break;
      }

      for (const vEdge of more.variants) {
        if (!seenVariantIds.has(vEdge.node.id)) {
          seenVariantIds.add(vEdge.node.id);
          product.variants?.edges.push(vEdge);
        }
      }

      if (more.hasNextPage && !more.endCursor) {
        terminationStatus = 'incomplete_missing_cursor';
        terminationReason = 'Shopify variant page reported hasNextPage=true but endCursor was null.';
        break;
      }

      if (more.endCursor && seenVariantCursors.has(more.endCursor)) {
        terminationStatus = 'incomplete_repeated_cursor';
        terminationReason = `Variant pagination repeated cursor ${more.endCursor}.`;
        break;
      }

      if (more.endCursor && more.endCursor === vCursor) {
        terminationStatus = 'incomplete_non_advancing_cursor';
        terminationReason = `Variant cursor did not advance from ${vCursor}.`;
        break;
      }

      if (vSafetyPages >= 50 && more.hasNextPage) {
        terminationStatus = 'incomplete_page_limit';
        terminationReason = 'Exhausted safety page limit (50 pages) while variants remained.';
        break;
      }

      if (more.endCursor) {
        seenVariantCursors.add(more.endCursor);
      }
      vHasNext = more.hasNextPage;
      vCursor = more.endCursor;
    }

    const isComplete = terminationStatus === 'complete' && !vHasNext;
    variantCompleteness[product.id] = {
      productId: product.id,
      productTitle: product.title || 'Untitled',
      isComplete,
      status: isComplete ? 'complete' : terminationStatus,
      variantsFetched: product.variants?.edges?.length || 0,
      uniqueVariantsCount: seenVariantIds.size,
      pagesFetched: vSafetyPages,
      lastCursor: vCursor,
      hasNextPage: vHasNext,
      reason: terminationReason,
      error: errorDetail,
    };
  }

  return {
    products,
    hasNextPage: Boolean(pageInfo?.hasNextPage),
    endCursor: pageInfo?.endCursor || null,
    cost: res.cost,
    variantCompleteness,
  };
}

/**
 * Paginates remaining product variants for large catalogs where a single product
 * has more than 100 variants (e.g. apparel, size/color matrices).
 */
export async function fetchRemainingProductVariants(
  shopDomain: string,
  accessToken: string,
  productId: string,
  afterCursor: string,
  options?: GraphQLClientOptions
): Promise<{
  variants: import('./types').ShopifyGraphQLVariantEdge[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const query = `
    query getProductVariants($id: ID!, $after: String) {
      product(id: $id) {
        variants(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            cursor
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
  `;

  const res = await executeShopifyGraphQL<{
    product?: {
      variants?: {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        edges?: import('./types').ShopifyGraphQLVariantEdge[];
      };
    };
  }>(shopDomain, accessToken, query, { id: productId, after: afterCursor }, options);

  const edges = res.data?.product?.variants?.edges || [];
  const pageInfo = res.data?.product?.variants?.pageInfo;

  return {
    variants: edges,
    hasNextPage: Boolean(pageInfo?.hasNextPage),
    endCursor: pageInfo?.endCursor || null,
  };
}
