import crypto from 'node:crypto';
import {
  VerificationCheckResult,
  StageVerificationSummary,
  evaluateCommercialReadiness,
  summarizeStage,
  redactSecrets,
} from './statusModel';
import {
  executeShopifyGraphQL,
  fetchProductsPage,
  isValidShopDomain,
  normalizeShopDomain,
  verifyShopifyConnection,
} from '../shopify/client';
import { initiateShopifyConnect, verifyShopifyCallbackHmac } from '../shopify/oauthService';
import {
  DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
  getShopifyWebhookSubscriptionsWithStatus,
} from '../shopify/webhookService';
import { validateShopifyUrlConfig } from '../config/productionConfig';
import { verifyShopifyWebhookHmac } from '../security/encryption';
import { syncShopifyCatalog, resumeShopifySync } from '../shopify/syncService';
import { MemoryRepository } from '../db/memoryRepository';

export interface ShopifyExternalVerifyOptions {
  targetEnvironment?: string;
  allowTestProductMutation?: boolean;
  customFetch?: typeof fetch;
}

const ALL_SHOPIFY_CHECK_DEFS: Array<{ testId: string; name: string; purpose: string }> = [
  {
    testId: 'S1-OAUTH-URL',
    name: 'Shopify OAuth connect initiation & state/HMAC verification',
    purpose: 'Verify OAuth authorize URL, state nonce generation, domain validation, and HMAC calculation',
  },
  {
    testId: 'S1-ADMIN-AUTH',
    name: 'Shopify Development Store Admin GraphQL authentication',
    purpose: 'Verify real Admin GraphQL authentication against configured Shopify Development Store',
  },
  {
    testId: 'S1-PRODUCT-PAGINATION',
    name: 'Shopify cursor-based product pagination & sync integrity',
    purpose: 'Read Dev Store products across pages (pageSize=5), check zero duplicates, and verify termination',
  },
  {
    testId: 'S1-WEBHOOK-SUBSCRIPTIONS',
    name: 'Shopify webhook subscription topic & callback URL audit',
    purpose: 'Compare registered Dev Store webhook topics and callbackUrls against required app topics and SHOPIFY_WEBHOOK_URL / app URL',
  },
  {
    testId: 'S1-WEBHOOK-HMAC-SIMULATION',
    name: 'Shopify webhook HMAC signature validation (local simulation)',
    purpose: 'Verify local X-Shopify-Hmac-Sha256 calculation and invalid HMAC rejection (does not prove live Shopify delivery)',
  },
  {
    testId: 'S1-WEBHOOK-LIVE-DELIVERY',
    name: 'Shopify real external webhook delivery verification',
    purpose: 'Verify Shopify actually delivered a live webhook event to the deployed callback URL',
  },
  {
    testId: 'S1-TEST-PRODUCT-LIFECYCLE',
    name: 'Shopify safe test product create, delete & read-back cleanup (opt-in)',
    purpose: 'Verify product mutation + verified deletion via API response and follow-up read when SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION=true',
  },
];

function normalizeWebhookUrl(raw?: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function resolveExpectedShopifyWebhookUrl(): {
  configured: boolean;
  url: string | null;
  source: string;
  error?: string;
} {
  const rawWebhookUrl = process.env.SHOPIFY_WEBHOOK_URL?.trim() || '';
  const rawShopifyAppUrl = process.env.SHOPIFY_APP_URL?.trim() || '';
  const rawAppUrl = process.env.APP_URL?.trim() || '';
  const hasExplicit = Boolean(
    rawWebhookUrl ||
      (rawShopifyAppUrl && rawShopifyAppUrl !== 'MY_APP_URL') ||
      (rawAppUrl && rawAppUrl !== 'MY_APP_URL')
  );

  if (!hasExplicit) {
    return {
      configured: false,
      url: null,
      source: 'none',
      error: 'No SHOPIFY_WEBHOOK_URL, SHOPIFY_APP_URL, or APP_URL is configured to validate webhook callback URLs.',
    };
  }

  const urlCheck = validateShopifyUrlConfig();
  if (!urlCheck.valid) {
    return {
      configured: false,
      url: null,
      source: rawWebhookUrl ? 'SHOPIFY_WEBHOOK_URL' : rawShopifyAppUrl ? 'SHOPIFY_APP_URL' : 'APP_URL',
      error: urlCheck.error,
    };
  }

  return {
    configured: true,
    url: urlCheck.webhookUrl,
    source: rawWebhookUrl ? 'SHOPIFY_WEBHOOK_URL' : rawShopifyAppUrl ? 'SHOPIFY_APP_URL' : 'APP_URL',
  };
}

export async function runShopifyExternalVerification(
  options: ShopifyExternalVerifyOptions = {}
): Promise<StageVerificationSummary> {
  const readiness = evaluateCommercialReadiness();
  const stageReadiness = readiness.integrations.stage_1_shopify;
  const targetEnv = options.targetEnvironment || process.env.SHOPIFY_DEV_STORE_DOMAIN?.trim() || 'unconfigured-shopify-dev-store';
  const nowIso = () => new Date().toISOString();

  if (stageReadiness.status !== 'READY') {
    const blockedChecks: VerificationCheckResult[] = ALL_SHOPIFY_CHECK_DEFS.map((def) => ({
      testId: def.testId,
      stage: 'stage_1_shopify',
      name: def.name,
      purpose: def.purpose,
      status: 'BLOCKED',
      executionMode: def.testId === 'S1-WEBHOOK-HMAC-SIMULATION' ? 'contract_fixture' : 'external_provider',
      targetEnvironment: targetEnv,
      executedAt: nowIso(),
      blockerOrFailure: `Missing prerequisites: ${stageReadiness.missingEnvVars.join(', ')}`,
    }));

    return summarizeStage(
      'stage_1_shopify',
      'Stage 1 — Shopify Development Store',
      blockedChecks,
      stageReadiness.missingEnvVars
    );
  }

  const rawDomain = process.env.SHOPIFY_DEV_STORE_DOMAIN!.trim();
  const shopDomain = normalizeShopDomain(rawDomain);
  const accessToken = process.env.SHOPIFY_DEV_ACCESS_TOKEN!.trim();
  const apiSecret = process.env.SHOPIFY_API_SECRET!.trim();
  const allowMutation =
    options.allowTestProductMutation ??
    (process.env.SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION || '').trim().toLowerCase() === 'true';
  const graphqlOpts = options.customFetch ? { customFetch: options.customFetch } : undefined;

  const checks: VerificationCheckResult[] = [];
  const tempRepo = new MemoryRepository(false);
  const owner = await tempRepo.createUser({
    id: `usr_s1_${Date.now()}`,
    email: `shopify-verify-${Date.now()}@example.com`,
    passwordHash: 'not_used',
    fullName: 'Shopify Verifier',
  });
  const { workspace: ws } = await tempRepo.createWorkspace(
    { id: `ws_s1_${Date.now()}`, name: 'Shopify Verify WS', slug: `ws-s1-${Date.now()}` },
    owner.id
  );

  // Check 1: OAuth initiation & HMAC verification
  {
    const t0 = Date.now();
    try {
      if (!isValidShopDomain(shopDomain)) {
        throw new Error(`Invalid SHOPIFY_DEV_STORE_DOMAIN: ${shopDomain}`);
      }
      const connect = await initiateShopifyConnect(tempRepo, ws.id, shopDomain);
      const parsed = new URL(connect.authUrl);
      const sampleQuery: Record<string, string> = {
        code: 'sample_auth_code',
        shop: shopDomain,
        state: connect.state,
        timestamp: String(Math.floor(Date.now() / 1000)),
      };
      const canonicalMsg = Object.keys(sampleQuery)
        .sort()
        .map((k) => `${k}=${sampleQuery[k]}`)
        .join('&');
      const validHmac = crypto.createHmac('sha256', apiSecret).update(canonicalMsg).digest('hex');
      const hmacOk = verifyShopifyCallbackHmac({ ...sampleQuery, hmac: validHmac }, apiSecret);
      const badHmacRejected = !verifyShopifyCallbackHmac({ ...sampleQuery, hmac: '0'.repeat(64) }, apiSecret);

      if (!hmacOk || !badHmacRejected || parsed.hostname !== shopDomain) {
        throw new Error('OAuth URL or callback HMAC verification check failed.');
      }

      checks.push({
        testId: 'S1-OAUTH-URL',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[0].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[0].purpose,
        status: 'PASS',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        evidence: {
          shopDomain,
          authorizeHost: parsed.hostname,
          redirectUri: parsed.searchParams.get('redirect_uri'),
          stateLength: connect.state.length,
          callbackHmacVerified: hmacOk,
          invalidHmacRejected: badHmacRejected,
        },
      });
    } catch (err: any) {
      checks.push({
        testId: 'S1-OAUTH-URL',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[0].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[0].purpose,
        status: 'FAIL',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        blockerOrFailure: redactSecrets(err),
      });
    }
  }

  // Check 2: Real Dev Store Admin GraphQL connection verification
  {
    const t0 = Date.now();
    try {
      const conn = await verifyShopifyConnection(shopDomain, accessToken, graphqlOpts);
      if (!conn.valid) {
        throw new Error(conn.error || 'Shopify Admin GraphQL verification failed');
      }
      checks.push({
        testId: 'S1-ADMIN-AUTH',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[1].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[1].purpose,
        status: 'PASS',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        evidence: {
          shopName: conn.shopName,
          myshopifyDomain: conn.myshopifyDomain,
          currencyCode: conn.currencyCode,
        },
      });
    } catch (err: any) {
      checks.push({
        testId: 'S1-ADMIN-AUTH',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[1].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[1].purpose,
        status: 'FAIL',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        blockerOrFailure: redactSecrets(err),
      });
    }
  }

  // Check 3: Real Cursor Pagination & Sync Service against Dev Store
  {
    const t0 = Date.now();
    try {
      const seenProductIds = new Set<string>();
      let duplicateCount = 0;
      let cursor: string | null = null;
      let hasNextPage = true;
      let pagesFetched = 0;
      const maxSafetyPages = 20;

      while (hasNextPage && pagesFetched < maxSafetyPages) {
        const page = await fetchProductsPage(shopDomain, accessToken, cursor, 5, graphqlOpts);
        pagesFetched++;
        for (const p of page.products) {
          if (seenProductIds.has(p.id)) duplicateCount++;
          seenProductIds.add(p.id);
        }
        if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
          throw new Error('Pagination cursor stalled while hasNextPage=true.');
        }
        hasNextPage = page.hasNextPage;
        cursor = page.endCursor;
      }

      if (duplicateCount > 0) {
        throw new Error(`Duplicate products detected across pages: ${duplicateCount}`);
      }

      // Also verify store connection + syncShopifyCatalog/resumeShopifySync pipeline when token saved
      const { encryptCredential } = await import('../security/encryption');
      const encryptedToken = encryptCredential(accessToken);
      await tempRepo.saveShopifyConnection({
        id: `shop_s1_${Date.now()}`,
        workspaceId: ws.id,
        shopDomain,
        accessTokenEncrypted: encryptedToken,
        grantedScopes: process.env.SHOPIFY_SCOPES || 'read_products',
        keyVersion: 'v1',
        status: 'connected',
        installedAt: nowIso(),
        lastVerifiedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      const syncRes = await syncShopifyCatalog(tempRepo, ws.id, {
        pageSize: 5,
        maxPages: 1,
        customFetch: options.customFetch,
      });
      let finalSyncStatus = syncRes.status;
      if (syncRes.status === 'partially_completed' && seenProductIds.size > 5) {
        const resumeRes = await resumeShopifySync(tempRepo, ws.id, {
          syncRunId: syncRes.syncRun.id,
          pageSize: 5,
          maxPages: 10,
          customFetch: options.customFetch,
        });
        finalSyncStatus = resumeRes.status;
      }

      checks.push({
        testId: 'S1-PRODUCT-PAGINATION',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[2].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[2].purpose,
        status: 'PASS',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        evidence: {
          pagesFetched,
          uniqueProductsObserved: seenProductIds.size,
          duplicateCount,
          terminatedCleanly: !hasNextPage,
          finalSyncStatus,
          catalogNote: seenProductIds.size === 0 ? 'Dev store catalog is empty (handled cleanly)' : undefined,
        },
      });
    } catch (err: any) {
      checks.push({
        testId: 'S1-PRODUCT-PAGINATION',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[2].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[2].purpose,
        status: 'FAIL',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        blockerOrFailure: redactSecrets(err),
      });
    }
  }

  // Check 4: Live Webhook Subscription Audit (required topics + callbackUrl verification)
  {
    const t0 = Date.now();
    try {
      const subResult = await getShopifyWebhookSubscriptionsWithStatus(shopDomain, accessToken, graphqlOpts);
      if (subResult.status === 'failed_api_error' || !subResult.isComplete) {
        throw new Error(subResult.error || subResult.reason || 'Failed to inspect Shopify webhook subscriptions completely.');
      }

      const expectedUrlInfo = resolveExpectedShopifyWebhookUrl();
      const expectedNormalized = expectedUrlInfo.url ? normalizeWebhookUrl(expectedUrlInfo.url) : '';

      const registeredTopics = subResult.subscriptions.map((s) => s.topic.toUpperCase().replace(/\//g, '_'));
      const matchedTopics: string[] = [];
      const missingTopics: string[] = [];
      const mismatchedSubscriptions: Array<{ id: string; topic: string; callbackUrl?: string; expectedUrl: string }> = [];

      for (const requiredTopic of DEFAULT_SHOPIFY_WEBHOOK_TOPICS) {
        const matching = subResult.subscriptions.filter(
          (s) => s.topic.toUpperCase().replace(/\//g, '_') === requiredTopic
        );
        if (matching.length === 0) {
          missingTopics.push(requiredTopic);
        } else if (expectedNormalized) {
          const hasMatchingUrl = matching.some((m) => normalizeWebhookUrl(m.callbackUrl) === expectedNormalized);
          if (hasMatchingUrl) {
            matchedTopics.push(requiredTopic);
          } else {
            for (const m of matching) {
              mismatchedSubscriptions.push({
                id: m.id,
                topic: m.topic,
                callbackUrl: m.callbackUrl,
                expectedUrl: expectedUrlInfo.url!,
              });
            }
          }
        } else {
          matchedTopics.push(requiredTopic);
        }
      }

      if (!expectedUrlInfo.configured) {
        checks.push({
          testId: 'S1-WEBHOOK-SUBSCRIPTIONS',
          stage: 'stage_1_shopify',
          name: ALL_SHOPIFY_CHECK_DEFS[3].name,
          purpose: ALL_SHOPIFY_CHECK_DEFS[3].purpose,
          status: 'BLOCKED',
          executionMode: 'external_provider',
          targetEnvironment: shopDomain,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
            registeredSubscriptionsCount: subResult.subscriptions.length,
            registeredTopics,
            missingTopics,
            expectedUrlSource: expectedUrlInfo.source,
          },
          blockerOrFailure: expectedUrlInfo.error || 'SHOPIFY_WEBHOOK_URL (or SHOPIFY_APP_URL / APP_URL) is required to verify callback URLs.',
        });
      } else if (missingTopics.length > 0 || mismatchedSubscriptions.length > 0) {
        const problems: string[] = [];
        if (missingTopics.length > 0) {
          problems.push(`Missing required webhook topics: ${missingTopics.join(', ')}`);
        }
        if (mismatchedSubscriptions.length > 0) {
          problems.push(
            `Callback URL mismatch for topics [${mismatchedSubscriptions.map((m) => m.topic).join(', ')}] (expected ${expectedUrlInfo.url})`
          );
        }
        checks.push({
          testId: 'S1-WEBHOOK-SUBSCRIPTIONS',
          stage: 'stage_1_shopify',
          name: ALL_SHOPIFY_CHECK_DEFS[3].name,
          purpose: ALL_SHOPIFY_CHECK_DEFS[3].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: shopDomain,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
            expectedCallbackUrl: expectedUrlInfo.url,
            expectedUrlSource: expectedUrlInfo.source,
            registeredSubscriptionsCount: subResult.subscriptions.length,
            registeredTopics,
            matchedTopics,
            missingTopics,
            mismatchedSubscriptions,
          },
          blockerOrFailure: problems.join('; '),
        });
      } else {
        checks.push({
          testId: 'S1-WEBHOOK-SUBSCRIPTIONS',
          stage: 'stage_1_shopify',
          name: ALL_SHOPIFY_CHECK_DEFS[3].name,
          purpose: ALL_SHOPIFY_CHECK_DEFS[3].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: shopDomain,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            requiredTopics: DEFAULT_SHOPIFY_WEBHOOK_TOPICS,
            expectedCallbackUrl: expectedUrlInfo.url,
            expectedUrlSource: expectedUrlInfo.source,
            registeredSubscriptionsCount: subResult.subscriptions.length,
            registeredTopics,
            matchedTopics,
            missingTopics: [],
            mismatchedSubscriptions: [],
          },
        });
      }
    } catch (err: any) {
      checks.push({
        testId: 'S1-WEBHOOK-SUBSCRIPTIONS',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[3].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[3].purpose,
        status: 'FAIL',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        blockerOrFailure: redactSecrets(err),
      });
    }
  }

  // Check 5: Local Webhook HMAC Simulation (explicitly separated from real delivery)
  {
    const t0 = Date.now();
    try {
      const sampleRawBody = JSON.stringify({ id: 123456, title: 'Webhook Verification Check' });
      const validHmac = crypto.createHmac('sha256', apiSecret).update(sampleRawBody, 'utf8').digest('base64');
      const validOk = verifyShopifyWebhookHmac(sampleRawBody, apiSecret, validHmac);
      const invalidRejected = !verifyShopifyWebhookHmac(sampleRawBody, apiSecret, 'aW52YWxpZA==');

      if (!validOk || !invalidRejected) {
        throw new Error('Local Shopify webhook HMAC verification check failed.');
      }

      checks.push({
        testId: 'S1-WEBHOOK-HMAC-SIMULATION',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[4].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[4].purpose,
        status: 'PASS — SIMULATED',
        executionMode: 'contract_fixture',
        targetEnvironment: 'local-hmac-verifier',
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        evidence: {
          webhookHmacValidVerified: validOk,
          webhookInvalidHmacRejected: invalidRejected,
          realExternalDeliveryProved: false,
          note: 'Local HMAC calculation only; does not prove Shopify delivered a real webhook.',
        },
      });
    } catch (err: any) {
      checks.push({
        testId: 'S1-WEBHOOK-HMAC-SIMULATION',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[4].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[4].purpose,
        status: 'FAIL',
        executionMode: 'contract_fixture',
        targetEnvironment: 'local-hmac-verifier',
        executedAt: nowIso(),
        durationMs: Date.now() - t0,
        blockerOrFailure: redactSecrets(err),
      });
    }
  }

  // Check 6: Real External Webhook Delivery (NOT RUN by CLI inspection alone)
  {
    checks.push({
      testId: 'S1-WEBHOOK-LIVE-DELIVERY',
      stage: 'stage_1_shopify',
      name: ALL_SHOPIFY_CHECK_DEFS[5].name,
      purpose: ALL_SHOPIFY_CHECK_DEFS[5].purpose,
      status: 'NOT RUN',
      executionMode: 'external_provider',
      targetEnvironment: shopDomain,
      executedAt: nowIso(),
      evidence: {
        realExternalDeliveryVerified: false,
      },
      blockerOrFailure:
        'Real Shopify webhook delivery is not verified by CLI Admin GraphQL inspection; trigger a live product/app event on the Dev Store targeting the deployed SHOPIFY_WEBHOOK_URL and confirm receipt.',
    });
  }

  // Check 7: Safe test product lifecycle (opt-in only, with verified deletion & read-back)
  {
    if (!allowMutation) {
      checks.push({
        testId: 'S1-TEST-PRODUCT-LIFECYCLE',
        stage: 'stage_1_shopify',
        name: ALL_SHOPIFY_CHECK_DEFS[6].name,
        purpose: ALL_SHOPIFY_CHECK_DEFS[6].purpose,
        status: 'NOT RUN',
        executionMode: 'external_provider',
        targetEnvironment: shopDomain,
        executedAt: nowIso(),
        blockerOrFailure:
          'Skipped write check (set SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION=true with write_products scope to enable create+delete check)',
      });
    } else {
      const t0 = Date.now();
      const prefix = process.env.SHOPIFY_TEST_PRODUCT_PREFIX?.trim() || 'AIXSHOP-VERIFY-';
      let createdProductId: string | null = null;
      let deletedProductId: string | null = null;
      let followUpReadConfirmedDeleted = false;
      let cleanedUp = false;
      let createError: string | null = null;
      let cleanupError: string | null = null;

      try {
        const createMutation = `
          mutation productCreate($product: ProductCreateInput!) {
            productCreate(product: $product) {
              product { id title status }
              userErrors { field message }
            }
          }
        `;
        const createRes = await executeShopifyGraphQL<{
          productCreate: { product: { id: string; title: string } | null; userErrors: Array<{ message: string }> };
        }>(
          shopDomain,
          accessToken,
          createMutation,
          {
            product: {
              title: `${prefix}${Date.now()}`,
              status: 'DRAFT',
            },
          },
          graphqlOpts
        );
        if (createRes.data?.productCreate?.userErrors?.length) {
          throw new Error(createRes.data.productCreate.userErrors.map((e) => e.message).join('; '));
        }
        createdProductId = createRes.data?.productCreate?.product?.id || null;
        if (!createdProductId) {
          throw new Error('productCreate did not return a product ID.');
        }
      } catch (err: any) {
        createError = redactSecrets(err);
      } finally {
        if (createdProductId) {
          try {
            const deleteMutation = `
              mutation productDelete($input: ProductDeleteInput!) {
                productDelete(input: $input) {
                  deletedProductId
                  userErrors { field message }
                }
              }
            `;
            const delRes = await executeShopifyGraphQL<{
              productDelete: { deletedProductId: string | null; userErrors: Array<{ message: string }> };
            }>(
              shopDomain,
              accessToken,
              deleteMutation,
              { input: { id: createdProductId } },
              graphqlOpts
            );

            const delErrors = delRes.data?.productDelete?.userErrors || [];
            if (delErrors.length > 0) {
              throw new Error(`productDelete userErrors: ${delErrors.map((e) => e.message).join('; ')}`);
            }
            deletedProductId = delRes.data?.productDelete?.deletedProductId || null;
            if (!deletedProductId) {
              throw new Error('productDelete did not return deletedProductId.');
            }

            // Follow-up read to confirm deletion in Shopify Admin API
            const readQuery = `
              query verifyProductDeleted($id: ID!) {
                product(id: $id) {
                  id
                }
              }
            `;
            const readRes = await executeShopifyGraphQL<{ product: { id: string } | null }>(
              shopDomain,
              accessToken,
              readQuery,
              { id: createdProductId },
              graphqlOpts
            );
            if (readRes.data?.product !== null && readRes.data?.product !== undefined) {
              throw new Error(`Follow-up read confirmed temporary product ${createdProductId} still exists after deletion.`);
            }
            followUpReadConfirmedDeleted = true;
            cleanedUp = true;
          } catch (delErr: any) {
            cleanupError = redactSecrets(delErr);
            cleanedUp = false;
          }
        }
      }

      if (!createError && cleanedUp && followUpReadConfirmedDeleted) {
        checks.push({
          testId: 'S1-TEST-PRODUCT-LIFECYCLE',
          stage: 'stage_1_shopify',
          name: ALL_SHOPIFY_CHECK_DEFS[6].name,
          purpose: ALL_SHOPIFY_CHECK_DEFS[6].purpose,
          status: 'PASS',
          executionMode: 'external_provider',
          targetEnvironment: shopDomain,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            createdProductId,
            deletedProductId,
            followUpReadConfirmedDeleted,
            cleanedUp: true,
          },
        });
      } else {
        const failureReasons = [createError, cleanupError ? `Cleanup failed: ${cleanupError}` : null].filter(Boolean);
        checks.push({
          testId: 'S1-TEST-PRODUCT-LIFECYCLE',
          stage: 'stage_1_shopify',
          name: ALL_SHOPIFY_CHECK_DEFS[6].name,
          purpose: ALL_SHOPIFY_CHECK_DEFS[6].purpose,
          status: 'FAIL',
          executionMode: 'external_provider',
          targetEnvironment: shopDomain,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            createdProductId,
            deletedProductId,
            followUpReadConfirmedDeleted,
            cleanedUp,
          },
          blockerOrFailure: failureReasons.join(' | ') || 'Temporary product lifecycle or cleanup verification failed.',
        });
      }
    }
  }

  return summarizeStage('stage_1_shopify', 'Stage 1 — Shopify Development Store', checks, []);
}
