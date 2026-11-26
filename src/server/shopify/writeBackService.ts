import crypto from 'node:crypto';
import { DatabaseRepository } from '../db/repository';
import { withWorkspaceOperationLease } from '../middleware/auth';
import { resolveReportEntitlement } from '../services/entitlementService';
import { ActionItem, Product } from '../../types';
import { validateGtin } from '../../domain/validation/gtin';
import { parseDecimalPrice } from '../../domain/validation/price';
import {
  fetchShopifyProductVerificationSnapshot,
  updateShopifyProductTitle,
  updateShopifyProductVariant,
} from './client';
import { getValidShopifyAccessToken, hasShopifyWriteScope } from './oauthService';
import { ShopifyWriteBackOperationRecord } from './types';

export type SupportedShopifyWriteBackTarget =
  | {
      kind: 'variant';
      variantIndex: number;
      property: 'barcode' | 'sku' | 'price';
      fieldPath: string;
    }
  | {
      kind: 'product';
      property: 'title';
      fieldPath: 'title';
    };

export class ShopifyWriteBackError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly operation?: ShopifyWriteBackOperationRecord;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    operation?: ShopifyWriteBackOperationRecord
  ) {
    super(message);
    this.name = 'ShopifyWriteBackError';
    this.statusCode = statusCode;
    this.code = code;
    this.operation = operation;
  }
}

export function parseAllowlistedShopifyWriteBackField(
  rawField: string
): SupportedShopifyWriteBackTarget | null {
  if (!rawField || typeof rawField !== 'string') return null;
  const field = rawField.trim();
  if (field === 'title') {
    return {
      kind: 'product',
      property: 'title',
      fieldPath: 'title',
    };
  }
  const variantMatch = field.match(/^variants\[(\d+)\]\.(barcode|sku|price)$/);
  if (variantMatch) {
    return {
      kind: 'variant',
      variantIndex: parseInt(variantMatch[1], 10),
      property: variantMatch[2] as 'barcode' | 'sku' | 'price',
      fieldPath: field,
    };
  }
  return null;
}

function validateAndNormalizeApprovedValue(
  target: SupportedShopifyWriteBackTarget,
  rawValue: unknown
): { valid: true; normalized: string } | { valid: false; reason: string } {
  if (rawValue === undefined || rawValue === null) {
    return { valid: false, reason: 'Approved value is missing.' };
  }
  const str = String(rawValue).trim();
  if (!str) {
    return { valid: false, reason: 'Approved value cannot be empty.' };
  }

  if (target.kind === 'variant' && target.property === 'barcode') {
    const gtinCheck = validateGtin(str);
    if (!gtinCheck.isValid) {
      return {
        valid: false,
        reason: gtinCheck.reason || `Barcode "${str}" failed GS1 GTIN validation.`,
      };
    }
    return { valid: true, normalized: gtinCheck.normalized };
  }

  if (target.kind === 'variant' && target.property === 'price') {
    const priceCheck = parseDecimalPrice(str);
    if (!priceCheck.isValid || priceCheck.price === null || !priceCheck.formattedPrice) {
      return {
        valid: false,
        reason: priceCheck.reason || `Price "${str}" is not a valid decimal monetary amount.`,
      };
    }
    return { valid: true, normalized: priceCheck.formattedPrice };
  }

  if (str.length > 255) {
    return {
      valid: false,
      reason: `${target.property} exceeds 255 character maximum for Shopify write-back.`,
    };
  }

  return { valid: true, normalized: str };
}

function sanitizeErrorForLogAndRecord(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unexpected write-back failure');
  return raw
    .replace(/shpat_[A-Za-z0-9_-]{6,}/gi, 'shpat_[REDACTED]')
    .replace(/shpca_[A-Za-z0-9_-]{6,}/gi, 'shpca_[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 400);
}

export interface ExecuteShopifyWriteBackParams {
  workspaceId: string;
  actionId: string;
  operatorUserId: string;
  idempotencyKey?: string;
  customFetch?: typeof fetch;
}

export interface ExecuteShopifyWriteBackResult {
  success: true;
  operation: ShopifyWriteBackOperationRecord;
  action: ActionItem;
  catalogVersion?: number;
}

/**
 * Executes a strictly gated, idempotent, post-mutation verified Shopify Admin GraphQL write-back
 * for an already merchant-approved remediation action.
 */
export async function executeShopifyWriteBack(
  repo: DatabaseRepository,
  params: ExecuteShopifyWriteBackParams
): Promise<ExecuteShopifyWriteBackResult> {
  const { workspaceId, actionId, operatorUserId } = params;

  const [store, subscription] = await Promise.all([
    repo.getStoreByWorkspace(workspaceId),
    repo.getSubscriptionByWorkspace(workspaceId),
  ]);
  const entitlement = resolveReportEntitlement(store, subscription);
  if (!entitlement.hasFullReportAccess) {
    throw new ShopifyWriteBackError(
      403,
      'REPORT_PAYMENT_REQUIRED',
      entitlement.reasonMessage ||
        'An active paid plan is required to write approved remediation actions back to Shopify.'
    );
  }

  return withWorkspaceOperationLease(repo, workspaceId, `shopify_writeback_${actionId}`, 120_000, async () => {
    const connection = await repo.getShopifyConnection(workspaceId);
    if (!connection || connection.status !== 'connected') {
      throw new ShopifyWriteBackError(
        400,
        'SHOPIFY_NOT_CONNECTED',
        'Workspace does not have an active connected Shopify store.'
      );
    }

    if (!hasShopifyWriteScope(connection.grantedScopes)) {
      throw new ShopifyWriteBackError(
        403,
        'SHOPIFY_WRITE_SCOPE_REQUIRED',
        'Connected Shopify store is authorized for read_products only. Re-authorize with write_products permission in Settings -> Connectors before running live write-back.'
      );
    }

    const catalog = await repo.loadWorkspaceCatalog(workspaceId);
    const action = catalog?.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new ShopifyWriteBackError(
        404,
        'ACTION_NOT_FOUND',
        `Action "${actionId}" was not found in the current workspace.`
      );
    }

    if (action.status === 'applied_externally') {
      throw new ShopifyWriteBackError(
        409,
        'WRITEBACK_ALREADY_APPLIED',
        `Action "${actionId}" has already been applied externally and verified on Shopify.`
      );
    }

    if (action.status !== 'approved') {
      throw new ShopifyWriteBackError(
        409,
        'ACTION_NOT_APPROVED',
        `Action "${actionId}" must have merchant approval (status "approved") before Shopify write-back. Current status: "${action.status}".`
      );
    }

    const target = parseAllowlistedShopifyWriteBackField(action.proposedChange?.field);
    if (!target) {
      throw new ShopifyWriteBackError(
        422,
        'UNSUPPORTED_SHOPIFY_WRITEBACK_FIELD',
        `Field "${action.proposedChange?.field || ''}" is not allowlisted for automated Shopify write-back. Supported targets: product title and variant barcode, sku, or price.`
      );
    }

    const product: Product | undefined = catalog?.products.find((p) => p.id === action.productId);
    if (!product) {
      throw new ShopifyWriteBackError(
        404,
        'PRODUCT_NOT_FOUND',
        `Target product "${action.productId}" for action "${actionId}" was not found in workspace catalog.`
      );
    }

    const provenanceList = await repo.getShopifyProductProvenance(workspaceId);
    const provenance = provenanceList.find((p) => p.productId === product.id);
    if (
      !provenance ||
      provenance.shopDomain !== connection.shopDomain ||
      !provenance.shopifyGid ||
      !provenance.shopifyGid.startsWith('gid://shopify/Product/')
    ) {
      throw new ShopifyWriteBackError(
        422,
        'MISSING_SHOPIFY_PROVENANCE',
        `Product "${product.id}" lacks verified Shopify provenance matching connected store "${connection.shopDomain}". Re-sync catalog via Shopify OAuth first.`
      );
    }

    if (
      product.attributes?.shopifyGid &&
      product.attributes.shopifyGid !== provenance.shopifyGid
    ) {
      throw new ShopifyWriteBackError(
        422,
        'MISSING_SHOPIFY_PROVENANCE',
        `Product "${product.id}" Shopify GID does not match authoritative provenance record.`
      );
    }

    let shopifyVariantGid: string | null = null;
    let beforeValue: string | null = action.proposedChange?.from ?? null;

    if (target.kind === 'variant') {
      const targetVariant = product.variants?.[target.variantIndex];
      if (!targetVariant) {
        throw new ShopifyWriteBackError(
          422,
          'VARIANT_NOT_FOUND',
          `Variant index [${target.variantIndex}] not found on product "${product.id}".`
        );
      }
      const vGid = targetVariant.attributes?.shopifyVariantGid;
      if (!vGid || !vGid.startsWith('gid://shopify/ProductVariant/')) {
        throw new ShopifyWriteBackError(
          422,
          'MISSING_SHOPIFY_VARIANT_GID',
          `Variant "${targetVariant.id}" lacks a verified Shopify ProductVariant GID. Re-sync from Shopify Admin API first.`
        );
      }
      shopifyVariantGid = vGid;
      const currentVal = targetVariant[target.property];
      if (beforeValue === null && currentVal !== undefined && currentVal !== null) {
        beforeValue = String(currentVal);
      }
    } else if (beforeValue === null && product.title) {
      beforeValue = product.title;
    }

    const rawApprovedValue = action.merchantApprovedValue ?? action.proposedChange?.to;
    const valueValidation = validateAndNormalizeApprovedValue(target, rawApprovedValue);
    if (!valueValidation.valid) {
      throw new ShopifyWriteBackError(422, 'INVALID_WRITEBACK_VALUE', valueValidation.reason);
    }
    const approvedValue = valueValidation.normalized;

    const deterministicKey = crypto
      .createHash('sha256')
      .update(
        `${workspaceId}:${actionId}:${provenance.shopifyGid}:${shopifyVariantGid || ''}:${target.fieldPath}:${approvedValue}`
      )
      .digest('hex');
    const idempotencyKey =
      params.idempotencyKey && params.idempotencyKey.trim()
        ? params.idempotencyKey.trim().slice(0, 128)
        : deterministicKey;

    const operationId = `wb_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const claim = await repo.createOrClaimShopifyWriteBackOperation({
      id: operationId,
      workspaceId,
      actionId,
      productId: product.id,
      shopDomain: connection.shopDomain,
      shopifyProductGid: provenance.shopifyGid,
      shopifyVariantGid,
      fieldPath: target.fieldPath,
      beforeValue,
      approvedValue,
      idempotencyKey,
      operatorUserId,
      auditMetadata: {
        actionTitle: action.title,
        findingId: action.findingId,
        targetKind: target.kind,
        targetProperty: target.property,
      },
    });

    if (!claim.claimed) {
      if (claim.conflictReason === 'WRITEBACK_ALREADY_VERIFIED') {
        throw new ShopifyWriteBackError(
          409,
          'WRITEBACK_ALREADY_APPLIED',
          `Write-back operation for action "${actionId}" is already verified and applied on Shopify.`,
          claim.record
        );
      }
      throw new ShopifyWriteBackError(
        409,
        claim.conflictReason || 'WRITEBACK_IN_PROGRESS',
        `A write-back operation for action "${actionId}" is already in progress.`,
        claim.record
      );
    }

    const claimedOpId = claim.record.id;
    let shopifyMutationId: string | null = null;

    try {
      const accessToken = await getValidShopifyAccessToken(repo, workspaceId, {
        customFetch: params.customFetch,
      });

      if (target.kind === 'variant') {
        const mutRes = await updateShopifyProductVariant(
          connection.shopDomain,
          accessToken,
          {
            productId: provenance.shopifyGid,
            variantId: shopifyVariantGid!,
            ...(target.property === 'barcode' ? { barcode: approvedValue } : {}),
            ...(target.property === 'sku' ? { sku: approvedValue } : {}),
            ...(target.property === 'price' ? { price: approvedValue } : {}),
          },
          { customFetch: params.customFetch }
        );

        if (!mutRes.success || mutRes.userErrors.length > 0) {
          const errMsg =
            mutRes.userErrors.map((e) => e.message).join('; ') ||
            'Shopify productVariantsBulkUpdate rejected mutation.';
          const completed = await repo.completeShopifyWriteBackOperation({
            operationId: claimedOpId,
            workspaceId,
            actionId,
            status: 'failed',
            errorCode: 'SHOPIFY_USER_ERROR',
            errorMessage: errMsg,
            auditMetadata: { userErrors: mutRes.userErrors },
            markActionAppliedExternally: false,
            operatorUserId,
            shopDomain: connection.shopDomain,
            beforeValue,
            approvedValue,
            fieldPath: target.fieldPath,
            shopifyProductGid: provenance.shopifyGid,
            shopifyVariantGid,
          });
          throw new ShopifyWriteBackError(422, 'SHOPIFY_USER_ERROR', errMsg, completed.operation);
        }

        shopifyMutationId = mutRes.mutationId || shopifyVariantGid;
      } else {
        const mutRes = await updateShopifyProductTitle(
          connection.shopDomain,
          accessToken,
          {
            productId: provenance.shopifyGid,
            title: approvedValue,
          },
          { customFetch: params.customFetch }
        );

        if (!mutRes.success || mutRes.userErrors.length > 0) {
          const errMsg =
            mutRes.userErrors.map((e) => e.message).join('; ') ||
            'Shopify productUpdate rejected mutation.';
          const completed = await repo.completeShopifyWriteBackOperation({
            operationId: claimedOpId,
            workspaceId,
            actionId,
            status: 'failed',
            errorCode: 'SHOPIFY_USER_ERROR',
            errorMessage: errMsg,
            auditMetadata: { userErrors: mutRes.userErrors },
            markActionAppliedExternally: false,
            operatorUserId,
            shopDomain: connection.shopDomain,
            beforeValue,
            approvedValue,
            fieldPath: target.fieldPath,
            shopifyProductGid: provenance.shopifyGid,
            shopifyVariantGid,
          });
          throw new ShopifyWriteBackError(422, 'SHOPIFY_USER_ERROR', errMsg, completed.operation);
        }

        shopifyMutationId = mutRes.mutationId || provenance.shopifyGid;
      }

      // Mandatory post-mutation read-back verification from live Shopify Admin GraphQL
      const snapshot = await fetchShopifyProductVerificationSnapshot(
        connection.shopDomain,
        accessToken,
        provenance.shopifyGid,
        shopifyVariantGid,
        { customFetch: params.customFetch }
      );

      let verifiedValue: string | null = null;
      let matches = false;

      if (snapshot) {
        if (target.kind === 'product') {
          verifiedValue = (snapshot.title || '').trim();
          matches = verifiedValue === approvedValue;
        } else {
          const liveVariant = snapshot.variants.find((v) => v.id === shopifyVariantGid);
          if (liveVariant) {
            if (target.property === 'price') {
              const parsedLive = parseDecimalPrice(liveVariant.price);
              verifiedValue = parsedLive.formattedPrice || (liveVariant.price ?? null);
              matches = Boolean(parsedLive.isValid && parsedLive.formattedPrice === approvedValue);
            } else {
              const rawLive = liveVariant[target.property];
              verifiedValue = rawLive !== null && rawLive !== undefined ? String(rawLive).trim() : null;
              matches = verifiedValue === approvedValue;
            }
          }
        }
      }

      if (!matches) {
        const mismatchMsg = snapshot
          ? `Shopify read-back verification mismatch for ${target.fieldPath}: expected "${approvedValue}", observed "${verifiedValue ?? 'null'}". Action remains approved and was NOT marked applied_externally.`
          : `Shopify read-back verification failed: product "${provenance.shopifyGid}" was not returned after mutation.`;
        const completed = await repo.completeShopifyWriteBackOperation({
          operationId: claimedOpId,
          workspaceId,
          actionId,
          status: 'verification_failed',
          verifiedValue,
          shopifyMutationId,
          errorCode: 'WRITEBACK_READBACK_MISMATCH',
          errorMessage: mismatchMsg,
          auditMetadata: {
            expectedValue: approvedValue,
            observedValue: verifiedValue,
          },
          markActionAppliedExternally: false,
          operatorUserId,
          shopDomain: connection.shopDomain,
          beforeValue,
          approvedValue,
          fieldPath: target.fieldPath,
          shopifyProductGid: provenance.shopifyGid,
          shopifyVariantGid,
        });
        throw new ShopifyWriteBackError(
          502,
          'WRITEBACK_READBACK_MISMATCH',
          mismatchMsg,
          completed.operation
        );
      }

      // Confirmed on Shopify via read-back query -> mark verified_applied and applied_externally atomically
      const completed = await repo.completeShopifyWriteBackOperation({
        operationId: claimedOpId,
        workspaceId,
        actionId,
        status: 'verified_applied',
        verifiedValue: verifiedValue ?? approvedValue,
        shopifyMutationId,
        errorCode: null,
        errorMessage: null,
        auditMetadata: {
          readBackVerified: true,
          expectedValue: approvedValue,
          observedValue: verifiedValue ?? approvedValue,
        },
        markActionAppliedExternally: true,
        operatorUserId,
        shopDomain: connection.shopDomain,
        beforeValue,
        approvedValue,
        fieldPath: target.fieldPath,
        shopifyProductGid: provenance.shopifyGid,
        shopifyVariantGid,
      });

      if (!completed.action) {
        throw new ShopifyWriteBackError(
          500,
          'ACTION_UPDATE_MISSING',
          `Write-back verified on Shopify, but action "${actionId}" could not be reloaded from workspace catalog.`,
          completed.operation
        );
      }

      return {
        success: true,
        operation: completed.operation,
        action: completed.action,
        catalogVersion: completed.catalogVersion,
      };
    } catch (err: any) {
      if (err instanceof ShopifyWriteBackError) {
        throw err;
      }
      const safeErrMsg = sanitizeErrorForLogAndRecord(err);
      const completed = await repo
        .completeShopifyWriteBackOperation({
          operationId: claimedOpId,
          workspaceId,
          actionId,
          status: 'failed',
          shopifyMutationId,
          errorCode: 'SHOPIFY_GRAPHQL_ERROR',
          errorMessage: safeErrMsg,
          auditMetadata: { errorMessage: safeErrMsg },
          markActionAppliedExternally: false,
          operatorUserId,
          shopDomain: connection.shopDomain,
          beforeValue,
          approvedValue,
          fieldPath: target.fieldPath,
          shopifyProductGid: provenance.shopifyGid,
          shopifyVariantGid,
        })
        .catch(() => null);

      throw new ShopifyWriteBackError(
        502,
        'SHOPIFY_GRAPHQL_ERROR',
        safeErrMsg,
        completed?.operation
      );
    }
  });
}
