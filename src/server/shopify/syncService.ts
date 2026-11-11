import { DatabaseRepository } from '../db/repository';
import { Product, Variant, Offer } from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { ShopifyGraphQLProductNode, ShopifySyncRunRecord } from './types';
import { fetchProductsPage, isValidShopDomain, normalizeShopDomain } from './client';
import { decryptCredential } from '../security/encryption';
import { getValidShopifyAccessToken } from './oauthService';
import { parseSourcePrice } from '../../domain/validation/price';
import { calculateProductCompleteness } from '../../domain/catalog/completeness';
import { 
  resolveWorkspacePlanEntitlement, 
  countCatalogSkus, 
  withWorkspaceLock 
} from '../services/entitlementService';
import { detectProductConflict } from '../../domain/ingestion/storeIngestion';

/**
 * Extracts numeric ID from Shopify GID format: "gid://shopify/Product/12345678" -> "12345678"
 */
export function extractShopifyNumericId(gid: string): string {
  if (!gid || typeof gid !== 'string') return '';
  const parts = gid.split('/');
  return parts[parts.length - 1] || gid;
}

/**
 * Maps a Shopify Admin GraphQL Product node to the canonical AIXSHOP domain Product model.
 * Preserves actual image URLs, price decimal accuracy, SKU, barcode, and source GID references.
 */
export function mapShopifyProductNodeToDomain(
  node: ShopifyGraphQLProductNode,
  currency = 'USD'
): Product {
  const numericId = extractShopifyNumericId(node.id);
  const prodId = `p_shopify_${numericId || Math.random().toString(36).substring(2, 9)}`;

  // 1. Map variants
  const variantEdges = node.variants?.edges || [];
  const variants: Variant[] = variantEdges.map((edge, idx) => {
    const vNode = edge.node;
    const vNumId = extractShopifyNumericId(vNode.id);
    const variantId = `v_shopify_${vNumId || `${numericId}_${idx}`}`;
    const parsedPrice = parseSourcePrice(vNode.price);

    const variantAttrs: Record<string, string> = {
      shopifyVariantGid: vNode.id,
      sourceVariantId: vNumId,
    };

    if (vNode.selectedOptions && Array.isArray(vNode.selectedOptions)) {
      for (const opt of vNode.selectedOptions) {
        if (opt.name && opt.value) {
          variantAttrs[`option_${opt.name.toLowerCase().replace(/\s+/g, '_')}`] = opt.value;
        }
      }
    }

    if (vNode.compareAtPrice) {
      variantAttrs.compareAtPrice = String(vNode.compareAtPrice);
    }

    return {
      id: variantId,
      sku: (vNode.sku || '').trim(),
      title: (vNode.title || '').trim(),
      barcode: (vNode.barcode || '').trim(),
      price: parsedPrice.price,
      inventoryCount: typeof vNode.inventoryQuantity === 'number' ? vNode.inventoryQuantity : null,
      attributes: variantAttrs,
    };
  });

  // 2. Map primary image and additional assets
  const imageEdges = node.images?.edges || [];
  const primaryImageUrl = imageEdges[0]?.node?.url || imageEdges[0]?.node?.originalSrc || '';

  // 3. Clean and normalize description
  const rawDesc = node.descriptionHtml || node.description || '';
  const cleanDesc = rawDesc.replace(/<[^>]*>?/gm, '').trim();

  // 4. Map direct storefront offer
  const offers: Offer[] = [];
  if (variants.length > 0 && variants[0].price !== null) {
    offers.push({
      id: `off_${prodId}_storefront`,
      channel: 'Direct Storefront',
      price: variants[0].price,
      currency,
      availability: variants.some(v => (v.inventoryCount ?? 1) > 0) ? 'in_stock' : 'out_of_stock',
      condition: 'new',
      url: `https://myshopify.com/products/${node.handle || numericId}`,
      merchantId: 'shopify',
      lastSync: new Date().toISOString(),
    });
  }

  // 5. Build canonical Product entity
  const prod: Product = {
    id: prodId,
    title: (node.title || '').trim() || 'Untitled Product',
    brand: (node.vendor || '').trim(),
    category: (node.productType || '').trim(),
    description: cleanDesc,
    image: primaryImageUrl,
    status: node.status === 'ARCHIVED' ? 'archived' : node.status === 'DRAFT' ? 'draft' : 'active',
    completenessScore: 0,
    evidenceCoverageScore: 0,
    externalDiscoveryStatus: 'observed_in_sample',
    attributes: {
      sourcePlatform: 'shopify',
      sourceProductId: numericId,
      shopifyGid: node.id,
      shopifyHandle: node.handle || '',
      shopifyStatus: node.status || 'ACTIVE',
      provenance: 'shopify_graphql_admin_api',
    },
    variants,
    offers,
    evidenceDocuments: [],
    findingsCount: 0,
    lastAudited: new Date().toISOString(),
  };

  prod.completenessScore = calculateProductCompleteness(prod);
  return prod;
}

export interface SyncCatalogOptions {
  customFetch?: typeof fetch;
  maxPages?: number;
  pageSize?: number;
  resumeCursor?: string;
}

export interface SyncCatalogResult {
  syncRun: ShopifySyncRunRecord;
  productsDiscovered: number;
  productsImported: number;
  variantsImported: number;
  excludedByPlan: number;
  status: 'completed' | 'partially_completed' | 'failed';
  message: string;
}

/**
 * Synchronizes an authorized Shopify merchant store catalog into the workspace's catalog.
 * Uses Admin GraphQL cursor pagination, enforces SKU plan limits honestly, protects merchant edits,
 * and maintains atomic transactional durability.
 */
export async function syncShopifyCatalog(
  repo: DatabaseRepository,
  workspaceId: string,
  options: SyncCatalogOptions = {}
): Promise<SyncCatalogResult> {
  return withWorkspaceLock(workspaceId, async () => {
    const connection = await repo.getShopifyConnection(workspaceId);
    if (!connection || connection.status === 'disconnected') {
      throw new Error(`[AIXSHOP Shopify Sync] No active Shopify connection found for workspace ${workspaceId}.`);
    }

    const shop = normalizeShopDomain(connection.shopDomain);
    if (!isValidShopDomain(shop)) {
      throw new Error(`[AIXSHOP Shopify Sync] Stored shop domain "${connection.shopDomain}" is invalid.`);
    }

    // Resolves fresh access token, auto-refreshing if expiring or expired
    const accessToken = await getValidShopifyAccessToken(repo, workspaceId, { customFetch: options.customFetch });
    const storeProfile = await repo.getStoreByWorkspace(workspaceId);
    const subscription = await repo.getSubscriptionByWorkspace(workspaceId);

    const entitlement = resolveWorkspacePlanEntitlement(storeProfile, subscription);
    if (!entitlement.isValid) {
      throw new Error(`[AIXSHOP Shopify Sync] ${entitlement.error || 'Invalid workspace plan entitlement'}`);
    }

    const syncRunId = `sync_${workspaceId}_${Date.now()}`;
    let syncRun = await repo.createShopifySyncRun({
      id: syncRunId,
      workspaceId,
      shopDomain: shop,
      status: 'syncing',
      productsDiscovered: 0,
      productsImported: 0,
      variantsImported: 0,
      excludedByPlan: 0,
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    try {
      const existingCatalog: StoragePayloadV1 = (await repo.loadWorkspaceCatalog(workspaceId)) || {
        storeProfile: storeProfile || {
          name: 'Merchant Store',
          domain: shop,
          currency: 'USD',
          catalogCompletenessAvg: 0,
          truthBoundaryStrictness: 'standard',
          connectors: [],
          tier: entitlement.tier as any,
          skuLimit: entitlement.skuLimit,
          skuCount: 0,
        },
        products: [],
        variants: [],
        offers: [],
        findings: [],
        actions: [],
        evidence: [],
      };

      const existingProducts = [...existingCatalog.products];
      const existingProductMap = new Map<string, Product>();
      for (const p of existingProducts) {
        if (p.id) existingProductMap.set(p.id, p);
        if (p.attributes?.sourceProductId) existingProductMap.set(`shopify_${p.attributes.sourceProductId}`, p);
      }

      let currentUsage = countCatalogSkus(existingProducts);
      const isUnlimited = entitlement.isUnlimited;
      const skuLimit = entitlement.skuLimit;

      let hasNextPage = true;
      let cursor: string | null = options.resumeCursor || null;
      let pageCount = 0;
      const maxPages = options.maxPages ?? 200; // Safe pagination ceiling
      const pageSize = options.pageSize ?? 50;

      let totalDiscoveredProducts = 0;
      let totalDiscoveredVariants = 0;
      let importedProductsCount = 0;
      let importedVariantsCount = 0;
      let excludedSkusCount = 0;
      let planLimitHit = false;

      const mergedProducts: Product[] = [];

      while (hasNextPage && pageCount < maxPages) {
        pageCount++;
        const pageResult = await fetchProductsPage(
          shop,
          accessToken,
          cursor,
          pageSize,
          { customFetch: options.customFetch }
        );

        for (const rawNode of pageResult.products) {
          totalDiscoveredProducts++;
          const variantCount = rawNode.variants?.edges?.length || 1;
          totalDiscoveredVariants += variantCount;

          if (planLimitHit) {
            excludedSkusCount += variantCount;
            continue;
          }

          // Check if adding this product exceeds the plan SKU limit
          if (!isUnlimited && currentUsage + variantCount > skuLimit) {
            planLimitHit = true;
            excludedSkusCount += variantCount;
            continue;
          }

          // Map node to domain Product
          const mappedProduct = mapShopifyProductNodeToDomain(rawNode, storeProfile?.currency || 'USD');

          // Check for existing product in catalog to protect merchant edits
          const existingMatch = 
            existingProductMap.get(mappedProduct.id) ||
            existingProductMap.get(`shopify_${mappedProduct.attributes.sourceProductId}`);

          if (existingMatch) {
            // Protect merchant-edited fields from being silently overwritten
            const conflict = detectProductConflict(mappedProduct, existingMatch);
            const preservedProduct: Product = {
              ...mappedProduct,
              title: conflict.isConflict ? existingMatch.title : mappedProduct.title,
              brand: conflict.isConflict ? existingMatch.brand : mappedProduct.brand,
              category: conflict.isConflict ? existingMatch.category : mappedProduct.category,
              description: conflict.isConflict ? existingMatch.description : mappedProduct.description,
              image: mappedProduct.image || existingMatch.image,
              evidenceDocuments: existingMatch.evidenceDocuments || [],
              findingsCount: existingMatch.findingsCount || 0,
            };
            preservedProduct.completenessScore = calculateProductCompleteness(preservedProduct);
            mergedProducts.push(preservedProduct);
          } else {
            mergedProducts.push(mappedProduct);
            currentUsage += variantCount;
          }

          importedProductsCount++;
          importedVariantsCount += variantCount;
        }

        hasNextPage = pageResult.hasNextPage;
        cursor = pageResult.endCursor;
      }

      // Merge new and preserved products into final catalog
      const finalProductIds = new Set(mergedProducts.map(p => p.id));
      const untouchedExisting = existingProducts.filter(p => !finalProductIds.has(p.id));
      const finalCatalogProducts = [...untouchedExisting, ...mergedProducts];

      const isPartiallyCompleted = planLimitHit || (hasNextPage && pageCount >= maxPages);
      const finalStatus = isPartiallyCompleted ? 'partially_completed' : 'completed';
      const message = planLimitHit
        ? `Imported ${importedProductsCount} products (${importedVariantsCount} SKUs). Reached ${entitlement.tier} plan limit of ${skuLimit} SKUs. ${excludedSkusCount} SKU(s) excluded.`
        : (hasNextPage && pageCount >= maxPages)
        ? `Partially completed import of ${importedProductsCount} products (${importedVariantsCount} variants) from ${shop}. Pagination ceiling reached (${maxPages} pages); pass cursor '${cursor}' to resume.`
        : `Successfully imported ${importedProductsCount} products and ${importedVariantsCount} variants from ${shop}.`;

      // Persist updated catalog
      const updatedCatalog: StoragePayloadV1 = {
        ...existingCatalog,
        products: finalCatalogProducts,
      };
      await repo.saveWorkspaceCatalog(workspaceId, updatedCatalog);

      // Update sync run in database
      syncRun = await repo.updateShopifySyncRun(syncRunId, {
        status: finalStatus,
        productsDiscovered: totalDiscoveredProducts,
        productsImported: importedProductsCount,
        variantsImported: importedVariantsCount,
        excludedByPlan: excludedSkusCount,
        cursorResumed: isPartiallyCompleted ? (cursor ?? undefined) : undefined,
        completedAt: new Date().toISOString(),
        errorMessage: isPartiallyCompleted ? message : null,
      });

      // Update connector on store profile
      if (storeProfile) {
        const connectors = storeProfile.connectors || [];
        const shopifyConnectorIdx = connectors.findIndex(c => c.id === 'shopify');
        const updatedConnector = {
          id: 'shopify',
          name: `Shopify (${shop})`,
          type: 'shopify' as const,
          status: 'connected' as const,
          productCountSynced: importedVariantsCount,
          lastSync: new Date().toISOString(),
          writeBackAuthorized: false,
        };

        let nextConnectors = [...connectors];
        if (shopifyConnectorIdx >= 0) {
          nextConnectors[shopifyConnectorIdx] = updatedConnector;
        } else {
          nextConnectors.push(updatedConnector);
        }

        await repo.saveStoreProfile(workspaceId, {
          ...storeProfile,
          connectors: nextConnectors,
          skuCount: countCatalogSkus(finalCatalogProducts),
        });
      }

      return {
        syncRun,
        productsDiscovered: totalDiscoveredProducts,
        productsImported: importedProductsCount,
        variantsImported: importedVariantsCount,
        excludedByPlan: excludedSkusCount,
        status: finalStatus,
        message,
      };
    } catch (err: any) {
      await repo.updateShopifySyncRun(syncRunId, {
        status: 'failed',
        errorMessage: err?.message || 'Sync failed due to an unexpected error',
        completedAt: new Date().toISOString(),
      });
      throw err;
    }
  });
}
