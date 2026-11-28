import crypto from 'node:crypto';
import Stripe from 'stripe';
import {
  VerificationCheckResult,
  StageVerificationSummary,
  CleanupReport,
  evaluateCommercialReadiness,
  summarizeStage,
  redactSecrets,
  isStripeLiveKey,
  isStripeTestKey,
  validateStagingBaseUrlNonProduction,
} from './statusModel';

export interface StagingE2EOptions {
  targetEnvironment?: string;
  stripeClient?: Stripe;
}

const ALL_STAGING_CHECK_DEFS: Array<{ testId: string; name: string; purpose: string }> = [
  {
    testId: 'S4-STAGING-HEALTH-ISOLATION',
    name: 'Staging readiness probe & non-production safety guard',
    purpose: 'Verify STAGING_BASE_URL /api/health/ready returns 200 and live Stripe keys are rejected',
  },
  {
    testId: 'S4-ACCOUNT-WORKSPACE-FREE',
    name: 'Customer account registration, workspace creation, seeding & Free Audit initial state',
    purpose:
      'Register isolated verification merchants A & B, verify session cookies, distinct workspaces, seed A catalog/store state, and verify Free Audit paywall',
  },
  {
    testId: 'S4-TENANT-ISOLATION-STRICT',
    name: 'Strict cross-tenant isolation & header tampering prevention',
    purpose:
      'Prove User B with x-workspace-id=workspaceIdA cannot read seeded A catalog/profile/billing/Shopify/audit/action routes or switch into workspaceIdA (HTTP 403)',
  },
  {
    testId: 'S4-SHOPIFY-OAUTH-CONNECT-INIT',
    name: 'Shopify Dev Store connect initiation & audit/feed/profile lifecycle on staging',
    purpose:
      'Generate signed OAuth authorize URL for SHOPIFY_DEV_STORE_DOMAIN and exercise store profile / business profile / AI discovery / feed readiness routes',
  },
  {
    testId: 'S4-STRIPE-CHECKOUT-AND-NEGATIVES',
    name: 'Stripe Test Mode Checkout session & negative security guards on staging',
    purpose:
      'Create paid Checkout Session, reject invalid Stripe webhook & Shopify HMAC signatures, and enforce 401 unauthenticated rejection',
  },
  {
    testId: 'S4-SMTP-FORGOT-PASSWORD',
    name: 'Staging transactional SMTP flow trigger (password reset)',
    purpose: 'Trigger POST /api/auth/forgot-password on staging to exercise real SMTP delivery path without enumeration',
  },
  {
    testId: 'S4-STAGING-CLEANUP',
    name: 'Deterministic staging E2E test resource cleanup & post-delete verification',
    purpose:
      'Track all created users, workspaces, sessions, and checkout IDs and reliably remove them via DELETE /api/auth/account unless STAGING_CLEANUP_ENABLED=false',
  },
];

async function httpJson(
  url: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; headers: Headers; body: any; rawText: string }> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (init.cookie) {
    headers.set('Cookie', init.cookie);
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
  }
  const resp = await fetch(url, { ...init, headers, redirect: 'manual' });
  const rawText = await resp.text();
  let body: any = rawText;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    // leave raw string
  }
  return { status: resp.status, headers: resp.headers, body, rawText };
}

function extractSessionCookie(headers: Headers): string {
  const raw = headers.get('set-cookie') || '';
  const match = raw.match(/aixshop_session=[^;]+/);
  return match ? match[0] : '';
}

function isCleanupEnabled(): boolean {
  const raw = process.env.STAGING_CLEANUP_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return raw.trim().toLowerCase() !== 'false';
}

interface TrackedRunResources {
  userIds: string[];
  workspaceIds: string[];
  checkoutSessionIds: string[];
  testEmails: string[];
  accounts: Array<{
    label: string;
    userId: string;
    workspaceId: string;
    email: string;
    password?: string;
    cookie: string;
  }>;
}

async function expireStripeCheckoutSession(
  stripe: Stripe,
  sessionId: string
): Promise<{ expired: boolean; error?: string }> {
  try {
    const expired = await stripe.checkout.sessions.expire(sessionId);
    if (expired.status === 'expired') {
      return { expired: true };
    }
    return {
      expired: false,
      error: `Checkout Session ${sessionId} returned unexpected status ${expired.status} after expire()`,
    };
  } catch (err: any) {
    // If already expired or completed, inspect current status cleanly
    try {
      const existing = await stripe.checkout.sessions.retrieve(sessionId);
      if (existing.status === 'expired') {
        return { expired: true };
      }
      return {
        expired: false,
        error: `Checkout Session ${sessionId} could not be expired (status=${existing.status}): ${redactSecrets(err)}`,
      };
    } catch (retrieveErr: any) {
      return {
        expired: false,
        error: `Failed expiring Checkout Session ${sessionId}: ${redactSecrets(retrieveErr || err)}`,
      };
    }
  }
}

async function executeStagingCleanup(
  stagingBase: string,
  tracked: TrackedRunResources,
  options: StagingE2EOptions = {}
): Promise<CleanupReport> {
  const enabled = isCleanupEnabled();
  const report: CleanupReport = {
    enabled,
    status: 'NONE_CREATED',
    trackedResources: {
      userIds: [...tracked.userIds],
      workspaceIds: [...tracked.workspaceIds],
      checkoutSessionIds: [...tracked.checkoutSessionIds],
      testEmails: [...tracked.testEmails],
    },
    deletedUserIds: [],
    deletedWorkspaceIds: [],
    preservedSharedWorkspaceIds: [],
    expiredCheckoutSessionIds: [],
    failedCheckoutSessionIds: [],
    verifiedSessionInvalidations: [],
    warnings: [],
    errors: [],
  };

  if (
    tracked.accounts.length === 0 &&
    tracked.userIds.length === 0 &&
    tracked.checkoutSessionIds.length === 0
  ) {
    report.status = enabled ? 'NONE_CREATED' : 'SKIPPED_DISABLED';
    return report;
  }

  if (!enabled) {
    report.status = 'SKIPPED_DISABLED';
    report.warnings.push(
      `STAGING_CLEANUP_ENABLED=false; left ${tracked.accounts.length} test account(s) and ${tracked.checkoutSessionIds.length} checkout session(s) intact for manual inspection.`
    );
    return report;
  }

  // 1. Expire tracked real Stripe Checkout Sessions (cs_test_...); skip sandbox sbx_cs_... IDs cleanly
  const stripeTestSessionIds = tracked.checkoutSessionIds.filter((id) => id.startsWith('cs_test_'));
  if (stripeTestSessionIds.length > 0) {
    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || '';
    const stripe =
      options.stripeClient || (isStripeTestKey(stripeKey) ? new Stripe(stripeKey) : null);

    if (!stripe) {
      for (const sid of stripeTestSessionIds) {
        report.failedCheckoutSessionIds!.push(sid);
      }
      report.errors.push(
        `Unable to expire ${stripeTestSessionIds.length} Stripe Test Checkout Session(s): no sk_test_ Stripe client available.`
      );
    } else {
      for (const sid of stripeTestSessionIds) {
        const res = await expireStripeCheckoutSession(stripe, sid);
        if (res.expired) {
          report.expiredCheckoutSessionIds!.push(sid);
        } else {
          report.failedCheckoutSessionIds!.push(sid);
          report.errors.push(res.error || `Failed expiring Checkout Session ${sid}`);
        }
      }
    }
  }

  // 2. Delete created test accounts (never pre-existing users or shared workspaces) & verify invalidation
  for (const acct of tracked.accounts) {
    if (!acct.cookie) {
      report.errors.push(`Account ${acct.label} (${acct.userId}) had no session cookie for self-cleanup.`);
      continue;
    }
    try {
      const delRes = await httpJson(`${stagingBase}/api/auth/account`, {
        method: 'DELETE',
        cookie: acct.cookie,
      });

      if (delRes.status === 200 && delRes.body?.success) {
        if (delRes.body.deletedUserId) {
          report.deletedUserIds.push(delRes.body.deletedUserId);
        } else {
          report.deletedUserIds.push(acct.userId);
        }
        if (Array.isArray(delRes.body.deletedWorkspaceIds)) {
          report.deletedWorkspaceIds.push(...delRes.body.deletedWorkspaceIds);
        }
        if (Array.isArray(delRes.body.preservedSharedWorkspaceIds)) {
          report.preservedSharedWorkspaceIds.push(...delRes.body.preservedSharedWorkspaceIds);
        }

        // Strictly verify post-delete session invalidation
        const postCheck = await httpJson(`${stagingBase}/api/auth/me`, { cookie: acct.cookie });
        if (postCheck.status !== 401) {
          report.errors.push(
            `Account ${acct.label} (${acct.userId}) deleted, but GET /api/auth/me returned HTTP ${postCheck.status} instead of 401.`
          );
        } else {
          report.verifiedSessionInvalidations!.push(acct.userId);
        }

        // Verify deleted account can no longer authenticate via POST /api/auth/login
        if (acct.password) {
          const postLogin = await httpJson(`${stagingBase}/api/auth/login`, {
            method: 'POST',
            body: JSON.stringify({ email: acct.email, password: acct.password }),
          });
          if (postLogin.status !== 401) {
            report.errors.push(
              `Account ${acct.label} (${acct.userId}) deleted, but POST /api/auth/login returned HTTP ${postLogin.status} instead of 401.`
            );
          }
        }
      } else if (delRes.status === 401 || delRes.status === 404) {
        report.warnings.push(
          `Account ${acct.label} (${acct.userId}) DELETE /api/auth/account returned HTTP ${delRes.status} (already deleted or session invalidated).`
        );
      } else {
        report.errors.push(
          `Failed deleting account ${acct.label} (${acct.userId}): HTTP ${delRes.status} ${redactSecrets(delRes.body)}`
        );
      }
    } catch (err: any) {
      report.errors.push(`Error deleting account ${acct.label} (${acct.userId}): ${redactSecrets(err)}`);
    } finally {
      // Best-effort cookie logout cleanup even if DELETE failed or already completed
      await httpJson(`${stagingBase}/api/auth/logout`, { method: 'POST', cookie: acct.cookie }).catch(() => {});
    }
  }

  const allAccountsDeleted = report.deletedUserIds.length === tracked.accounts.length;
  const allStripeExpired =
    (report.failedCheckoutSessionIds?.length || 0) === 0 &&
    (report.expiredCheckoutSessionIds?.length || 0) === stripeTestSessionIds.length;
  const anyCleaned =
    report.deletedUserIds.length > 0 || (report.expiredCheckoutSessionIds?.length || 0) > 0;

  if (report.errors.length === 0 && allAccountsDeleted && allStripeExpired && report.warnings.length === 0) {
    report.status = 'CLEANED';
  } else if (anyCleaned) {
    report.status = 'PARTIAL_CLEANUP';
  } else {
    report.status = 'FAILED';
  }

  return report;
}

export async function runStagingE2EVerification(
  options: StagingE2EOptions = {}
): Promise<StageVerificationSummary> {
  const readiness = evaluateCommercialReadiness();
  const stageReadiness = readiness.integrations.stage_4_staging_e2e;
  const stagingBase = process.env.STAGING_BASE_URL?.trim().replace(/\/+$/, '') || 'unconfigured-staging';
  const targetEnv = options.targetEnvironment || stagingBase;
  const nowIso = () => new Date().toISOString();
  const cleanupEnabled = isCleanupEnabled();

  if (isStripeLiveKey(process.env.STRIPE_SECRET_KEY)) {
    const failedChecks: VerificationCheckResult[] = ALL_STAGING_CHECK_DEFS.map((def, idx) => ({
      testId: def.testId,
      stage: 'stage_4_staging_e2e',
      name: def.name,
      purpose: def.purpose,
      status: idx === 0 ? 'FAIL' : 'BLOCKED',
      executionMode: 'staging_e2e',
      targetEnvironment: targetEnv,
      executedAt: nowIso(),
      blockerOrFailure: 'LIVE_KEY_REJECTED: Staging E2E strictly refuses sk_live_ Stripe keys.',
    }));
    const summary = summarizeStage(
      'stage_4_staging_e2e',
      'Stage 4 — Staging End-to-End Customer Journey',
      failedChecks,
      ['STRIPE_SECRET_KEY (must be sk_test_...)']
    );
    summary.cleanupReport = {
      enabled: cleanupEnabled,
      status: 'NONE_CREATED',
      trackedResources: { userIds: [], workspaceIds: [], checkoutSessionIds: [], testEmails: [] },
      deletedUserIds: [],
      deletedWorkspaceIds: [],
      preservedSharedWorkspaceIds: [],
      warnings: [],
      errors: [],
    };
    return summary;
  }

  const rawStagingUrl = process.env.STAGING_BASE_URL?.trim();
  if (rawStagingUrl) {
    const baseUrlGuard = validateStagingBaseUrlNonProduction(rawStagingUrl);
    if (!baseUrlGuard.valid) {
      const prefix = baseUrlGuard.isProductionTarget
        ? 'PRODUCTION_TARGET_REJECTED'
        : 'STAGING_TARGET_REJECTED';
      const missingVarHint = baseUrlGuard.isProductionTarget
        ? 'STAGING_BASE_URL (must point to a non-production staging target)'
        : baseUrlGuard.reason || 'STAGING_BASE_URL / STAGING_ALLOWED_HOSTS';

      const failedChecks: VerificationCheckResult[] = ALL_STAGING_CHECK_DEFS.map((def, idx) => ({
        testId: def.testId,
        stage: 'stage_4_staging_e2e',
        name: def.name,
        purpose: def.purpose,
        status: idx === 0 ? 'FAIL' : 'BLOCKED',
        executionMode: 'staging_e2e',
        targetEnvironment: targetEnv,
        executedAt: nowIso(),
        blockerOrFailure:
          idx === 0
            ? `${prefix}: ${baseUrlGuard.reason}`
            : 'Blocked by STAGING_BASE_URL non-production & allowlist safety guard.',
      }));
      const summary = summarizeStage(
        'stage_4_staging_e2e',
        'Stage 4 — Staging End-to-End Customer Journey',
        failedChecks,
        [missingVarHint]
      );
      summary.cleanupReport = {
        enabled: cleanupEnabled,
        status: 'NONE_CREATED',
        trackedResources: { userIds: [], workspaceIds: [], checkoutSessionIds: [], testEmails: [] },
        deletedUserIds: [],
        deletedWorkspaceIds: [],
        preservedSharedWorkspaceIds: [],
        warnings: [],
        errors: [],
      };
      return summary;
    }
  }

  if (stageReadiness.status !== 'READY') {
    const blockedChecks: VerificationCheckResult[] = ALL_STAGING_CHECK_DEFS.map((def) => ({
      testId: def.testId,
      stage: 'stage_4_staging_e2e',
      name: def.name,
      purpose: def.purpose,
      status: 'BLOCKED',
      executionMode: 'staging_e2e',
      targetEnvironment: targetEnv,
      executedAt: nowIso(),
      blockerOrFailure: `Missing prerequisites: ${stageReadiness.missingEnvVars.join(', ')}`,
    }));

    const summary = summarizeStage(
      'stage_4_staging_e2e',
      'Stage 4 — Staging End-to-End Customer Journey',
      blockedChecks,
      stageReadiness.missingEnvVars
    );
    summary.cleanupReport = {
      enabled: cleanupEnabled,
      status: 'NONE_CREATED',
      trackedResources: { userIds: [], workspaceIds: [], checkoutSessionIds: [], testEmails: [] },
      deletedUserIds: [],
      deletedWorkspaceIds: [],
      preservedSharedWorkspaceIds: [],
      warnings: [],
      errors: [],
    };
    return summary;
  }

  const checks: VerificationCheckResult[] = [];
  const runSuffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const testEmailA =
    process.env.STAGING_TEST_USER_EMAIL?.trim() || `aixshop-e2e-a-${runSuffix}@example.com`;
  const testEmailB = `aixshop-e2e-b-${runSuffix}@example.com`;
  const testPassword =
    process.env.STAGING_TEST_USER_PASSWORD?.trim() || `StgV3rify!${crypto.randomBytes(6).toString('hex')}`;

  const tracked: TrackedRunResources = {
    userIds: [],
    workspaceIds: [],
    checkoutSessionIds: [],
    testEmails: [],
    accounts: [],
  };

  let sessionCookieA = '';
  let userIdA = '';
  let workspaceIdA = '';
  let sessionCookieB = '';
  let userIdB = '';
  let workspaceIdB = '';
  const seededMarkerName = `Tenant Isolation Seed A ${runSuffix}`;
  const seededMarkerSku = `SKU-ISO-A-${runSuffix}`;
  const seededMarkerTitle = `Tenant Isolation Marker Product ${runSuffix}`;

  let cleanupReport: CleanupReport = {
    enabled: cleanupEnabled,
    status: 'NONE_CREATED',
    trackedResources: { userIds: [], workspaceIds: [], checkoutSessionIds: [], testEmails: [] },
    deletedUserIds: [],
    deletedWorkspaceIds: [],
    preservedSharedWorkspaceIds: [],
    warnings: [],
    errors: [],
  };

  try {
    // Check 1: Staging /api/health/ready
    {
      const t0 = Date.now();
      try {
        const health = await httpJson(`${stagingBase}/api/health/ready`);
        if (health.status !== 200 || !health.body || typeof health.body !== 'object') {
          throw new Error(`Staging /api/health/ready returned HTTP ${health.status}`);
        }
        checks.push({
          testId: 'S4-STAGING-HEALTH-ISOLATION',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[0].name,
          purpose: ALL_STAGING_CHECK_DEFS[0].purpose,
          status: 'PASS',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: { healthStatus: health.status, body: health.body },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S4-STAGING-HEALTH-ISOLATION',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[0].name,
          purpose: ALL_STAGING_CHECK_DEFS[0].purpose,
          status: 'FAIL',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }

    // Check 2: Register User A & User B, seed recognizable state in Workspace A, verify Free Audit state
    {
      const t0 = Date.now();
      try {
        const regA = await httpJson(`${stagingBase}/api/auth/register`, {
          method: 'POST',
          body: JSON.stringify({
            email: testEmailA,
            password: testPassword,
            fullName: 'Staging E2E Merchant A',
            workspaceName: `Staging Verify A ${runSuffix}`,
          }),
        });
        if (regA.status !== 201 && regA.status !== 200) {
          throw new Error(`Staging register A failed: HTTP ${regA.status}`);
        }
        sessionCookieA = extractSessionCookie(regA.headers);
        userIdA = regA.body?.user?.id || '';
        workspaceIdA = regA.body?.workspace?.id || '';
        if (!sessionCookieA || !userIdA || !workspaceIdA) {
          throw new Error('Staging registration A did not return session cookie, user ID, and workspace ID.');
        }
        tracked.userIds.push(userIdA);
        tracked.workspaceIds.push(workspaceIdA);
        tracked.testEmails.push(testEmailA);
        tracked.accounts.push({
          label: 'UserA',
          userId: userIdA,
          workspaceId: workspaceIdA,
          email: testEmailA,
          password: testPassword,
          cookie: sessionCookieA,
        });

        const regB = await httpJson(`${stagingBase}/api/auth/register`, {
          method: 'POST',
          body: JSON.stringify({
            email: testEmailB,
            password: testPassword,
            fullName: 'Staging E2E Merchant B',
            workspaceName: `Staging Verify B ${runSuffix}`,
          }),
        });
        if (regB.status !== 201 && regB.status !== 200) {
          throw new Error(`Staging register B failed: HTTP ${regB.status}`);
        }
        sessionCookieB = extractSessionCookie(regB.headers);
        userIdB = regB.body?.user?.id || '';
        workspaceIdB = regB.body?.workspace?.id || '';
        if (!sessionCookieB || !userIdB || !workspaceIdB) {
          throw new Error('Staging registration B did not return session cookie, user ID, and workspace ID.');
        }
        if (userIdA === userIdB || workspaceIdA === workspaceIdB) {
          throw new Error('Distinct registrations collided on userId or workspaceId.');
        }
        tracked.userIds.push(userIdB);
        tracked.workspaceIds.push(workspaceIdB);
        tracked.testEmails.push(testEmailB);
        tracked.accounts.push({
          label: 'UserB',
          userId: userIdB,
          workspaceId: workspaceIdB,
          email: testEmailB,
          password: testPassword,
          cookie: sessionCookieB,
        });

        // Seed recognizable profile & catalog state in Workspace A
        const seedProfile = await httpJson(`${stagingBase}/api/store/profile`, {
          method: 'PUT',
          cookie: sessionCookieA,
          body: JSON.stringify({
            name: seededMarkerName,
            domain: `tenant-a-${runSuffix}.example.com`,
            websiteUrl: `https://tenant-a-${runSuffix}.example.com`,
          }),
        });
        if (seedProfile.status !== 200) {
          throw new Error(`Workspace A store profile seed returned HTTP ${seedProfile.status}`);
        }

        const seedImport = await httpJson(`${stagingBase}/api/catalog/import`, {
          method: 'POST',
          cookie: sessionCookieA,
          body: JSON.stringify({
            candidates: [
              {
                id: `prod_iso_a_${runSuffix}`,
                title: seededMarkerTitle,
                brand: 'TenantA Brand',
                category: 'Test Category',
                description: 'Seeded product for strict cross-tenant isolation testing.',
                image: 'https://example.com/marker.jpg',
                status: 'active',
                completenessScore: 80,
                evidenceCoverageScore: 0,
                externalDiscoveryStatus: 'unindexed',
                attributes: { material: 'Cotton' },
                variants: [
                  {
                    id: `var_iso_a_${runSuffix}`,
                    sku: seededMarkerSku,
                    title: 'Default',
                    barcode: '012345678905',
                    price: 29.99,
                    attributes: {},
                  },
                ],
                offers: [],
                evidenceDocuments: [],
                findingsCount: 0,
                lastAudited: nowIso(),
              },
            ],
          }),
        });
        if (seedImport.status !== 200 && seedImport.status !== 201) {
          throw new Error(`Workspace A catalog import seed returned HTTP ${seedImport.status}`);
        }

        const subA = await httpJson(`${stagingBase}/api/billing/subscription`, { cookie: sessionCookieA });
        if (subA.status !== 200 || subA.body?.subscription?.tier !== 'Free Audit') {
          throw new Error(`Expected initial Free Audit tier, got ${JSON.stringify(subA.body?.subscription)}`);
        }

        checks.push({
          testId: 'S4-ACCOUNT-WORKSPACE-FREE',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[1].name,
          purpose: ALL_STAGING_CHECK_DEFS[1].purpose,
          status: 'PASS',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            userIdA,
            userIdB,
            workspaceIdA,
            workspaceIdB,
            seededMarkerSku,
            initialTier: subA.body?.subscription?.tier,
            hasFullReportAccess: subA.body?.reportEntitlement?.hasFullReportAccess,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S4-ACCOUNT-WORKSPACE-FREE',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[1].name,
          purpose: ALL_STAGING_CHECK_DEFS[1].purpose,
          status: 'FAIL',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }

    // Check 3: Strict Cross-Tenant Isolation Verification (Task B)
    {
      const t0 = Date.now();
      if (!sessionCookieA || !sessionCookieB || !workspaceIdA || !workspaceIdB) {
        checks.push({
          testId: 'S4-TENANT-ISOLATION-STRICT',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[2].name,
          purpose: ALL_STAGING_CHECK_DEFS[2].purpose,
          status: 'BLOCKED',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          blockerOrFailure: 'Blocked by failed dual-tenant registration.',
        });
      } else {
        try {
          // Confirm User A reads its own seeded data
          const catA = await httpJson(`${stagingBase}/api/catalog`, { cookie: sessionCookieA });
          if (catA.status !== 200 || !catA.body || catA.body.workspaceId !== workspaceIdA) {
            throw new Error(`User A /api/catalog returned unexpected response (HTTP ${catA.status})`);
          }
          const aProducts = catA.body?.catalog?.products ?? catA.body?.products;
          const aHasSeed = Array.isArray(aProducts) && aProducts.some((p: any) => p.title === seededMarkerTitle);
          if (!aHasSeed) {
            throw new Error('Seeded marker product was not readable by owning User A.');
          }

          // Cross-tenant attempts as User B tampering x-workspace-id=workspaceIdA
          const tamperHeaders = { 'x-workspace-id': workspaceIdA };

          const bCat = await httpJson(`${stagingBase}/api/catalog`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bCat.status !== 200 || !bCat.body || typeof bCat.body !== 'object') {
            throw new Error(`User B /api/catalog failed unexpectedly: HTTP ${bCat.status}`);
          }
          if (bCat.body.workspaceId !== workspaceIdB) {
            throw new Error(`Cross-tenant catalog scope leak: expected workspace ${workspaceIdB}, got ${bCat.body.workspaceId}`);
          }
          const bProducts = bCat.body?.catalog?.products ?? bCat.body?.products ?? [];
          if (
            bProducts.some((p: any) => p.title === seededMarkerTitle) ||
            bCat.rawText.includes(seededMarkerTitle) ||
            bCat.rawText.includes(seededMarkerSku)
          ) {
            throw new Error('Cross-tenant catalog payload leaked User A seeded marker product.');
          }

          const bProfile = await httpJson(`${stagingBase}/api/store/profile`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bProfile.status !== 200 || !bProfile.body || typeof bProfile.body !== 'object') {
            throw new Error(`User B /api/store/profile failed unexpectedly: HTTP ${bProfile.status}`);
          }
          if (bProfile.rawText.includes(seededMarkerName)) {
            throw new Error('Cross-tenant store profile leaked User A seeded store name.');
          }

          const bSub = await httpJson(`${stagingBase}/api/billing/subscription`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bSub.status !== 200 || !bSub.body || bSub.body.workspaceId !== workspaceIdB) {
            throw new Error(`Cross-tenant billing subscription scope leak: expected ${workspaceIdB}, got ${bSub.body?.workspaceId}`);
          }

          const bShopify = await httpJson(`${stagingBase}/api/shopify/status`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bShopify.status !== 200 || !bShopify.body || bShopify.body.shopDomain !== null) {
            throw new Error(`Unexpected Shopify status for clean Tenant B: HTTP ${bShopify.status}`);
          }

          const bSwitch = await httpJson(`${stagingBase}/api/auth/switch-workspace`, {
            method: 'POST',
            cookie: sessionCookieB,
            body: JSON.stringify({ workspaceId: workspaceIdA }),
          });
          if (bSwitch.status !== 403 || bSwitch.body?.code === 'CSRF_REJECTED') {
            throw new Error(
              `Expected authorization 403 on cross-tenant switch-workspace, got HTTP ${bSwitch.status} (${bSwitch.body?.code || bSwitch.body?.error})`
            );
          }

          const bEmailDeliveries = await httpJson(`${stagingBase}/api/billing/email-deliveries`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bEmailDeliveries.status !== 200 || bEmailDeliveries.body?.workspaceId !== workspaceIdB) {
            throw new Error(
              `Cross-tenant billing email deliveries scope leak: expected ${workspaceIdB}, got ${bEmailDeliveries.body?.workspaceId}`
            );
          }

          const bWriteBackHistory = await httpJson(`${stagingBase}/api/shopify/write-back/history`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bWriteBackHistory.status !== 200 || bWriteBackHistory.body?.workspaceId !== workspaceIdB) {
            throw new Error(
              `Cross-tenant Shopify write-back history scope leak: expected ${workspaceIdB}, got ${bWriteBackHistory.body?.workspaceId}`
            );
          }

          const bAuditRead = await httpJson(`${stagingBase}/api/audit/audit_fake_${runSuffix}`, {
            cookie: sessionCookieB,
            headers: tamperHeaders,
          });
          if (bAuditRead.status !== 403 && bAuditRead.status !== 404) {
            throw new Error(`Expected 403/404 on cross-tenant audit run lookup, got HTTP ${bAuditRead.status}`);
          }

          const bActionApprove = await httpJson(`${stagingBase}/api/catalog/actions/act_fake_${runSuffix}/approve`, {
            method: 'POST',
            cookie: sessionCookieB,
            headers: tamperHeaders,
            body: JSON.stringify({ customApprovedValue: 'tamper' }),
          });
          if (bActionApprove.status !== 403 && bActionApprove.status !== 404) {
            throw new Error(`Expected 403/404 on cross-tenant action approve, got HTTP ${bActionApprove.status}`);
          }

          checks.push({
            testId: 'S4-TENANT-ISOLATION-STRICT',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[2].name,
            purpose: ALL_STAGING_CHECK_DEFS[2].purpose,
            status: 'PASS',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            evidence: {
              catalogScopeVerified: true,
              profileIsolationVerified: true,
              billingIsolationVerified: true,
              emailDeliveriesIsolationVerified: true,
              writeBackHistoryIsolationVerified: true,
              shopifyStatusIsolationVerified: true,
              switchWorkspaceRejectedStatus: bSwitch.status,
              crossTenantAuditRejectedStatus: bAuditRead.status,
              crossTenantActionRejectedStatus: bActionApprove.status,
            },
          });
        } catch (err: any) {
          checks.push({
            testId: 'S4-TENANT-ISOLATION-STRICT',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[2].name,
            purpose: ALL_STAGING_CHECK_DEFS[2].purpose,
            status: 'FAIL',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            blockerOrFailure: redactSecrets(err),
          });
        }
      }
    }

    // Check 4: Shopify Connect URL initiation on staging
    {
      const t0 = Date.now();
      if (!sessionCookieA) {
        checks.push({
          testId: 'S4-SHOPIFY-OAUTH-CONNECT-INIT',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[3].name,
          purpose: ALL_STAGING_CHECK_DEFS[3].purpose,
          status: 'BLOCKED',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          blockerOrFailure: 'Blocked by failed staging registration.',
        });
      } else {
        try {
          const shopDomain = process.env.SHOPIFY_DEV_STORE_DOMAIN!.trim();
          const conn = await httpJson(
            `${stagingBase}/api/shopify/connect?shop=${encodeURIComponent(shopDomain)}`,
            { cookie: sessionCookieA }
          );
          if (conn.status !== 200 || !conn.body?.authUrl) {
            throw new Error(`Shopify connect returned HTTP ${conn.status}`);
          }
          const connWrite = await httpJson(
            `${stagingBase}/api/shopify/connect?shop=${encodeURIComponent(shopDomain)}&writeAccess=true`,
            { cookie: sessionCookieA }
          );
          const rawWriteScopes = connWrite.body?.scopes;
          const writeScopesList = Array.isArray(rawWriteScopes)
            ? rawWriteScopes
            : typeof rawWriteScopes === 'string'
            ? rawWriteScopes.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
          if (connWrite.status !== 200 || !writeScopesList.includes('write_products')) {
            throw new Error(`Shopify connect writeAccess=true failed or omitted write_products scope`);
          }

          const bp = await httpJson(`${stagingBase}/api/business-profile`, { cookie: sessionCookieA });
          if (bp.status !== 200 || !bp.body?.profile) {
            throw new Error(`Staging GET /api/business-profile returned HTTP ${bp.status}`);
          }

          const vis = await httpJson(`${stagingBase}/api/visibility/summary`, { cookie: sessionCookieA });
          if (vis.status !== 200) {
            throw new Error(`Staging GET /api/visibility/summary returned HTTP ${vis.status}`);
          }

          const discLocked = await httpJson(`${stagingBase}/api/discovery/audit`, { cookie: sessionCookieA });
          if (discLocked.status !== 403 || discLocked.body?.code !== 'REPORT_PAYMENT_REQUIRED') {
            throw new Error(`Expected 403 REPORT_PAYMENT_REQUIRED on /api/discovery/audit, got ${discLocked.status}`);
          }

          const feedLocked = await httpJson(`${stagingBase}/api/feed/validate`, {
            method: 'POST',
            cookie: sessionCookieA,
            body: JSON.stringify({ platform: 'google_merchant_center' }),
          });
          if (feedLocked.status !== 403 || feedLocked.body?.code !== 'REPORT_PAYMENT_REQUIRED') {
            throw new Error(`Expected 403 REPORT_PAYMENT_REQUIRED on /api/feed/validate, got ${feedLocked.status}`);
          }

          checks.push({
            testId: 'S4-SHOPIFY-OAUTH-CONNECT-INIT',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[3].name,
            purpose: ALL_STAGING_CHECK_DEFS[3].purpose,
            status: 'PASS',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            evidence: {
              shopDomain: conn.body.shopDomain,
              authHost: new URL(conn.body.authUrl).hostname,
              writeBackScopeInitVerified: true,
              businessProfileStatus: bp.status,
              visibilitySummaryStatus: vis.status,
              paywallEnforcedRoutes: ['/api/discovery/audit', '/api/feed/validate'],
              interactiveOAuthConsentNote:
                'Interactive merchant approval on Shopify Admin requires browser completion or pre-seeded OAuth session.',
            },
          });
        } catch (err: any) {
          checks.push({
            testId: 'S4-SHOPIFY-OAUTH-CONNECT-INIT',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[3].name,
            purpose: ALL_STAGING_CHECK_DEFS[3].purpose,
            status: 'FAIL',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            blockerOrFailure: redactSecrets(err),
          });
        }
      }
    }

    // Check 5: Checkout Session + Negative Webhook / HMAC / Auth checks
    {
      const t0 = Date.now();
      if (!sessionCookieA) {
        checks.push({
          testId: 'S4-STRIPE-CHECKOUT-AND-NEGATIVES',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[4].name,
          purpose: ALL_STAGING_CHECK_DEFS[4].purpose,
          status: 'BLOCKED',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          blockerOrFailure: 'Blocked by failed staging registration.',
        });
      } else {
        try {
          const checkout = await httpJson(`${stagingBase}/api/billing/checkout-session`, {
            method: 'POST',
            cookie: sessionCookieA,
            body: JSON.stringify({ tier: 'Starter' }),
          });
          if (checkout.status !== 200 || !checkout.body?.checkoutUrl) {
            throw new Error(`Staging checkout-session returned HTTP ${checkout.status}`);
          }
          try {
            new URL(String(checkout.body.checkoutUrl));
          } catch {
            throw new Error(`Staging checkout-session returned invalid checkoutUrl: ${checkout.body.checkoutUrl}`);
          }
          if (checkout.body?.sessionId) {
            tracked.checkoutSessionIds.push(String(checkout.body.sessionId));
          }

          // Negative: invalid/tampered tier must be rejected
          const badTier = await httpJson(`${stagingBase}/api/billing/checkout-session`, {
            method: 'POST',
            cookie: sessionCookieA,
            body: JSON.stringify({ tier: 'InvalidTier' }),
          });
          if (badTier.status !== 400) {
            throw new Error(`Expected 400 for invalid checkout tier, got ${badTier.status}`);
          }

          // Negative: invalid Stripe webhook signature
          const badStripeWh = await httpJson(`${stagingBase}/api/billing/webhook`, {
            method: 'POST',
            headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
            body: JSON.stringify({ id: 'evt_bad_sig', type: 'checkout.session.completed' }),
          });
          if (badStripeWh.status < 400 || badStripeWh.status >= 500) {
            throw new Error(`Expected 4xx for invalid Stripe signature, got ${badStripeWh.status}`);
          }

          // Negative: invalid Shopify webhook HMAC
          const badShopifyWh = await httpJson(`${stagingBase}/api/shopify/webhooks`, {
            method: 'POST',
            headers: {
              'x-shopify-hmac-sha256': 'aW52YWxpZA==',
              'x-shopify-topic': 'products/update',
              'x-shopify-shop-domain': process.env.SHOPIFY_DEV_STORE_DOMAIN!.trim(),
            },
            body: JSON.stringify({ id: 999 }),
          });
          if (badShopifyWh.status !== 401 && badShopifyWh.status !== 400) {
            throw new Error(`Expected 401/400 for invalid Shopify webhook HMAC, got ${badShopifyWh.status}`);
          }

          // Check scoped billing email delivery log & write-back audit history endpoints
          const emailLogRes = await httpJson(`${stagingBase}/api/billing/email-deliveries`, {
            cookie: sessionCookieA,
          });
          if (emailLogRes.status !== 200 || emailLogRes.body?.workspaceId !== workspaceIdA) {
            throw new Error(`Expected 200 scoped billing email deliveries, got ${emailLogRes.status}`);
          }

          const wbHistRes = await httpJson(`${stagingBase}/api/shopify/write-back/history`, {
            cookie: sessionCookieA,
          });
          if (wbHistRes.status !== 200 || wbHistRes.body?.workspaceId !== workspaceIdA) {
            throw new Error(`Expected 200 scoped Shopify write-back history, got ${wbHistRes.status}`);
          }

          // Negative: unauthenticated access rejected
          const unauthSub = await httpJson(`${stagingBase}/api/billing/subscription`);
          if (unauthSub.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated subscription read, got ${unauthSub.status}`);
          }

          const unauthDelete = await httpJson(`${stagingBase}/api/auth/account`, { method: 'DELETE' });
          if (unauthDelete.status !== 401) {
            throw new Error(`Expected 401 for unauthenticated account delete, got ${unauthDelete.status}`);
          }

          checks.push({
            testId: 'S4-STRIPE-CHECKOUT-AND-NEGATIVES',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[4].name,
            purpose: ALL_STAGING_CHECK_DEFS[4].purpose,
            status: 'PASS',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            evidence: {
              checkoutProvider: checkout.body.provider,
              checkoutSessionId: checkout.body.sessionId,
              invalidTierRejectedStatus: badTier.status,
              billingEmailDeliveriesStatus: emailLogRes.status,
              shopifyWriteBackHistoryStatus: wbHistRes.status,
              invalidStripeWebhookStatus: badStripeWh.status,
              invalidShopifyWebhookStatus: badShopifyWh.status,
              unauthRejectedStatus: unauthSub.status,
              unauthAccountDeleteRejectedStatus: unauthDelete.status,
            },
          });
        } catch (err: any) {
          checks.push({
            testId: 'S4-STRIPE-CHECKOUT-AND-NEGATIVES',
            stage: 'stage_4_staging_e2e',
            name: ALL_STAGING_CHECK_DEFS[4].name,
            purpose: ALL_STAGING_CHECK_DEFS[4].purpose,
            status: 'FAIL',
            executionMode: 'staging_e2e',
            targetEnvironment: stagingBase,
            executedAt: nowIso(),
            durationMs: Date.now() - t0,
            blockerOrFailure: redactSecrets(err),
          });
        }
      }
    }

    // Check 6: Staging transactional SMTP trigger via POST /api/auth/forgot-password
    {
      const t0 = Date.now();
      try {
        const forgot = await httpJson(`${stagingBase}/api/auth/forgot-password`, {
          method: 'POST',
          body: JSON.stringify({ email: testEmailA }),
        });
        if (forgot.status !== 200) {
          throw new Error(`Staging /api/auth/forgot-password returned HTTP ${forgot.status}`);
        }
        const forgotUnknown = await httpJson(`${stagingBase}/api/auth/forgot-password`, {
          method: 'POST',
          body: JSON.stringify({ email: `nonexistent-${runSuffix}@example.com` }),
        });
        if (forgotUnknown.status !== 200) {
          throw new Error(
            `Staging /api/auth/forgot-password failed non-enumeration check for nonexistent email: HTTP ${forgotUnknown.status}`
          );
        }
        checks.push({
          testId: 'S4-SMTP-FORGOT-PASSWORD',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[5].name,
          purpose: ALL_STAGING_CHECK_DEFS[5].purpose,
          status: 'PASS',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          evidence: {
            forgotPasswordStatus: forgot.status,
            nonexistentEmailStatus: forgotUnknown.status,
            nonEnumerationPreserved: true,
          },
        });
      } catch (err: any) {
        checks.push({
          testId: 'S4-SMTP-FORGOT-PASSWORD',
          stage: 'stage_4_staging_e2e',
          name: ALL_STAGING_CHECK_DEFS[5].name,
          purpose: ALL_STAGING_CHECK_DEFS[5].purpose,
          status: 'FAIL',
          executionMode: 'staging_e2e',
          targetEnvironment: stagingBase,
          executedAt: nowIso(),
          durationMs: Date.now() - t0,
          blockerOrFailure: redactSecrets(err),
        });
      }
    }
  } finally {
    cleanupReport = await executeStagingCleanup(stagingBase, tracked, options);
  }

  // Check 7: Deterministic Cleanup Check
  {
    const def = ALL_STAGING_CHECK_DEFS[6];
    const cleanupStatus =
      cleanupReport.status === 'CLEANED' || cleanupReport.status === 'NONE_CREATED'
        ? 'PASS'
        : cleanupReport.status === 'SKIPPED_DISABLED'
        ? 'NOT RUN'
        : 'FAIL';

    checks.push({
      testId: def.testId,
      stage: 'stage_4_staging_e2e',
      name: def.name,
      purpose: def.purpose,
      status: cleanupStatus,
      executionMode: 'staging_e2e',
      targetEnvironment: stagingBase,
      executedAt: nowIso(),
      ...(cleanupStatus === 'FAIL'
        ? {
            blockerOrFailure: `Cleanup ${cleanupReport.status}: ${cleanupReport.errors.join('; ') || cleanupReport.warnings.join('; ')}`,
          }
        : cleanupStatus === 'NOT RUN'
        ? {
            blockerOrFailure: 'STAGING_CLEANUP_ENABLED=false; cleanup skipped intentionally for manual inspection.',
          }
        : {
            evidence: {
              cleanupStatus: cleanupReport.status,
              deletedUserIds: cleanupReport.deletedUserIds,
              deletedWorkspaceIds: cleanupReport.deletedWorkspaceIds,
              expiredCheckoutSessionIds: cleanupReport.expiredCheckoutSessionIds || [],
              failedCheckoutSessionIds: cleanupReport.failedCheckoutSessionIds || [],
              verifiedSessionInvalidations: cleanupReport.verifiedSessionInvalidations || [],
              checkoutSessionIdsTracked: cleanupReport.trackedResources.checkoutSessionIds.length,
            },
          }),
    });
  }

  const summary = summarizeStage('stage_4_staging_e2e', 'Stage 4 — Staging End-to-End Customer Journey', checks, []);
  summary.cleanupReport = cleanupReport;
  return summary;
}
