import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import {
  isLoopbackOrLocalHostname,
  validateProductionConfig,
  validateShopifyUrlConfig,
} from '../config/productionConfig';
import { validateStripePriceConfiguration } from '../billing/providerAdapter';
import { validateSmtpConfig } from '../services/emailService';

export type VerificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT RUN' | 'PASS — SIMULATED';

export type StagingCleanupStatus =
  | 'CLEANED'
  | 'PARTIAL_CLEANUP'
  | 'FAILED'
  | 'SKIPPED_DISABLED'
  | 'NONE_CREATED';

export interface CleanupReport {
  enabled: boolean;
  status: StagingCleanupStatus;
  trackedResources: {
    userIds: string[];
    workspaceIds: string[];
    checkoutSessionIds: string[];
    testEmails: string[];
  };
  deletedUserIds: string[];
  deletedWorkspaceIds: string[];
  preservedSharedWorkspaceIds: string[];
  expiredCheckoutSessionIds?: string[];
  failedCheckoutSessionIds?: string[];
  verifiedSessionInvalidations?: string[];
  warnings: string[];
  errors: string[];
}

export type ExecutionMode =
  | 'unit_mock'
  | 'contract_fixture'
  | 'local_postgres'
  | 'external_provider'
  | 'staging_e2e';

export type CommercialStageId =
  | 'config_readiness'
  | 'stage_1_shopify'
  | 'stage_2_stripe'
  | 'stage_3_smtp'
  | 'stage_4_staging_e2e';

export interface VerificationCheckResult {
  testId: string;
  stage: CommercialStageId;
  name: string;
  purpose: string;
  status: VerificationStatus;
  executionMode: ExecutionMode;
  targetEnvironment: string;
  executedAt: string;
  durationMs?: number;
  evidence?: Record<string, unknown>;
  blockerOrFailure?: string;
}

export interface StageVerificationSummary {
  stage: CommercialStageId;
  title: string;
  status: VerificationStatus;
  counts: {
    pass: number;
    simulated?: number;
    fail: number;
    blocked: number;
    notRun: number;
    total: number;
  };
  missingEnvVars: string[];
  checks: VerificationCheckResult[];
  cleanupReport?: CleanupReport;
}

export interface CommercialReadinessItem {
  id: CommercialStageId;
  label: string;
  status: 'READY' | 'BLOCKED';
  configured: boolean;
  missingEnvVars: string[];
  notes: string[];
}

export interface CommercialEnvReadinessReport {
  checkedAt: string;
  environment: string;
  externalVerificationActivated: boolean;
  localDevReady: boolean;
  ciPostgresReady: boolean;
  integrations: Record<CommercialStageId, CommercialReadinessItem>;
  summaryStatus: 'READY_FOR_ALL_STAGES' | 'PARTIAL_BLOCKED' | 'ALL_EXTERNAL_BLOCKED';
}

export interface SimulatedSuiteArtifactEntry {
  suiteFile: string;
  suiteId?: string;
  executedAt: string;
  durationMs: number;
  exitCode: number;
  passedCount: number;
  failedCount: number;
  skippedCount?: number;
  totalCount: number;
  status: 'PASS' | 'FAIL';
  command?: string;
  sha256?: string;
}

export interface SimulatedTestResultsArtifact {
  schemaVersion: '1.0';
  runId: string;
  generatedAt: string;
  runner: string;
  nodeVersion?: string;
  suites: SimulatedSuiteArtifactEntry[];
}

export interface CommercialVerificationReport {
  generatedAt: string;
  runId: string;
  targetEnvironment: string;
  externalVerificationActivated: boolean;
  overallExternalStatus: VerificationStatus;
  readiness: CommercialEnvReadinessReport;
  stages: StageVerificationSummary[];
  simulatedChecks?: VerificationCheckResult[];
  simulatedArtifactPath?: string;
  simulatedArtifactRunId?: string;
  cleanupPerformed: boolean;
  cleanupReport?: CleanupReport;
  notes: string[];
}

const STRIPE_LIVE_PREFIX = 'sk_' + 'live_';

export function isStripeLiveKey(key: string | undefined): boolean {
  return Boolean(key && key.trim().startsWith(STRIPE_LIVE_PREFIX));
}

export function isStripeTestKey(key: string | undefined): boolean {
  return Boolean(key && key.trim().startsWith('sk_test_'));
}

/**
 * Redacts credentials, tokens, passwords, and connection URI passwords from text.
 */
export function redactSecrets(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
      ? input
      : JSON.stringify(input ?? '');

  let text = raw;
  const sensitiveEnvNames = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SHOPIFY_API_SECRET',
    'SHOPIFY_DEV_ACCESS_TOKEN',
    'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    'SMTP_PASS',
    'AIXSHOP_PLATFORM_REVIEWER_SECRET',
    'BILLING_WEBHOOK_SECRET',
    'STAGING_TEST_USER_PASSWORD',
    'SQL_PASSWORD',
    'PGPASSWORD',
  ];

  for (const name of sensitiveEnvNames) {
    const val = process.env[name];
    if (val && val.trim().length >= 4) {
      text = text.split(val).join(`[REDACTED_${name}]`);
    }
  }

  const smtpPass = process.env.SMTP_PASS || '';
  const smtpUser = process.env.SMTP_USER?.trim() || '';
  if (smtpPass) {
    const loginB64 = Buffer.from(smtpPass, 'utf8').toString('base64');
    if (loginB64) {
      text = text.split(loginB64).join('[REDACTED_SMTP_AUTH]');
    }
    if (smtpUser) {
      const plainB64 = Buffer.from(`\0${smtpUser}\0${smtpPass}`, 'utf8').toString('base64');
      if (plainB64) {
        text = text.split(plainB64).join('[REDACTED_SMTP_AUTH]');
      }
    }
  }

  // Redact DB URI credentials (postgresql://user:pass@host)
  text = text.replace(
    /(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    '$1[REDACTED_DB_PASS]$3'
  );

  // Redact common secret prefixes
  text = text
    .replace(/\b(sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_STRIPE_KEY]')
    .replace(/\bwhsec_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_WEBHOOK_SECRET]')
    .replace(/\bshpat_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_SHOPIFY_TOKEN]')
    .replace(/\bshpca_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_SHOPIFY_CODE]')
    .replace(/\b(AUTH\s+(?:PLAIN|LOGIN)\s+)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED_TOKEN]');

  return text;
}

export function sanitizeEvidenceObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (/(secret|password|pass|token|apiKey|encryptionKey)/i.test(key) && typeof val === 'string') {
      result[key] = '[REDACTED]';
    } else if (typeof val === 'string') {
      result[key] = redactSecrets(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) => (typeof item === 'string' ? redactSecrets(item) : item));
    } else if (val && typeof val === 'object') {
      result[key] = sanitizeEvidenceObject(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function isExternalVerificationActivated(): boolean {
  return (process.env.COMMERCIAL_VERIFY_EXTERNAL || '').trim().toLowerCase() === 'true';
}

export function evaluateCommercialReadiness(): CommercialEnvReadinessReport {
  const checkedAt = new Date().toISOString();
  const prod = validateProductionConfig();
  const externalActivated = isExternalVerificationActivated();

  // Stage 1: Shopify Development Store
  const shopifyMissing: string[] = [];
  if (!externalActivated) shopifyMissing.push('COMMERCIAL_VERIFY_EXTERNAL=true');
  if (!process.env.SHOPIFY_API_KEY?.trim()) shopifyMissing.push('SHOPIFY_API_KEY');
  if (!process.env.SHOPIFY_API_SECRET?.trim()) shopifyMissing.push('SHOPIFY_API_SECRET');
  if (!prod.checks.encryptionKeyValid) shopifyMissing.push('SHOPIFY_TOKEN_ENCRYPTION_KEY');
  if (!process.env.SHOPIFY_DEV_STORE_DOMAIN?.trim()) shopifyMissing.push('SHOPIFY_DEV_STORE_DOMAIN');
  if (!process.env.SHOPIFY_DEV_ACCESS_TOKEN?.trim()) shopifyMissing.push('SHOPIFY_DEV_ACCESS_TOKEN');
  const shopifyUrlValidation = validateShopifyUrlConfig();
  const shopifyNotes: string[] = [];
  if (!shopifyUrlValidation.valid) {
    shopifyNotes.push(`Shopify callback URL notice: ${shopifyUrlValidation.error}`);
  }
  const shopifyReady = shopifyMissing.length === 0;

  // Stage 2: Stripe Test Mode
  const stripeMissing: string[] = [];
  const stripeNotes: string[] = [];
  if (!externalActivated) stripeMissing.push('COMMERCIAL_VERIFY_EXTERNAL=true');
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || '';
  if (!stripeKey) {
    stripeMissing.push('STRIPE_SECRET_KEY');
  } else if (isStripeLiveKey(stripeKey)) {
    stripeMissing.push('STRIPE_SECRET_KEY (must use sk_test_... for Test Mode verification; live key rejected)');
    stripeNotes.push('Live Stripe key detected — Stage 2 refuses execution against live mode.');
  } else if (!isStripeTestKey(stripeKey)) {
    stripeMissing.push('STRIPE_SECRET_KEY (must start with sk_test_)');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()) stripeMissing.push('STRIPE_WEBHOOK_SECRET');
  const stripePrices = validateStripePriceConfiguration();
  if (!stripePrices.valid) {
    for (const item of stripePrices.missingOrInvalid) {
      stripeMissing.push(item);
    }
  }
  const stripeReady = stripeMissing.length === 0;

  // Stage 3: Real SMTP Provider
  const smtpMissing: string[] = [];
  const smtpNotes: string[] = [];
  if (!externalActivated) smtpMissing.push('COMMERCIAL_VERIFY_EXTERNAL=true');
  const smtpCfg = validateSmtpConfig({ isProd: false });
  if (!smtpCfg.configured) {
    smtpMissing.push('SMTP_HOST');
  } else if (!smtpCfg.valid) {
    smtpMissing.push(...smtpCfg.missingOrInvalid);
  }
  if (!process.env.SMTP_USER?.trim()) smtpMissing.push('SMTP_USER');
  if (!process.env.SMTP_PASS?.trim()) smtpMissing.push('SMTP_PASS');
  if (!process.env.SMTP_FROM?.trim() || process.env.SMTP_FROM.trim().endsWith('.local')) {
    smtpMissing.push('SMTP_FROM (non-.local verified sender address required for real provider)');
  }
  if (!process.env.SMTP_TEST_RECIPIENT?.trim()) {
    smtpMissing.push('SMTP_TEST_RECIPIENT');
  }
  smtpNotes.push('SMTP relay acceptance (250 OK) is distinct from confirmed recipient inbox delivery.');
  const smtpReady = smtpMissing.length === 0;

  // Stage 4: Staging End-to-End Customer Journey
  const stagingMissing: string[] = [];
  const stagingNotes: string[] = [];
  if (!externalActivated) stagingMissing.push('COMMERCIAL_VERIFY_EXTERNAL=true');
  const prodDenylist = resolveProductionDenylist();
  if (!prodDenylist.valid && prodDenylist.reason) {
    stagingMissing.push(prodDenylist.reason);
  }
  const stagingUrl = process.env.STAGING_BASE_URL?.trim() || '';
  const stagingUrlCheck = validateStagingBaseUrlNonProduction(stagingUrl);
  if (!stagingUrlCheck.valid) {
    if (!stagingMissing.includes(stagingUrlCheck.reason || 'STAGING_BASE_URL')) {
      stagingMissing.push(stagingUrlCheck.reason || 'STAGING_BASE_URL');
    }
  }
  const allowLocalMode = (process.env.STAGING_ALLOW_LOCAL || '').trim().toLowerCase() === 'true';
  if (!allowLocalMode) {
    const allowlist = parseStagingAllowedHosts();
    if (!allowlist.valid) {
      const msg = allowlist.reason || 'STAGING_ALLOWED_HOSTS';
      if (
        !stagingMissing.includes(msg) &&
        !stagingMissing.some((m) => m.includes('STAGING_ALLOWED_HOSTS'))
      ) {
        stagingMissing.push(msg);
      }
    }
  }
  if ((process.env.STAGING_CONFIRM_NON_PRODUCTION || '').trim().toLowerCase() !== 'true') {
    stagingMissing.push('STAGING_CONFIRM_NON_PRODUCTION=true');
  }
  for (const dep of [...shopifyMissing, ...stripeMissing, ...smtpMissing]) {
    if (!stagingMissing.includes(dep)) {
      stagingMissing.push(dep);
    }
  }
  if (!prod.checks.postgresConfigured) {
    stagingNotes.push('Target staging deployment is expected to run with PostgreSQL configured.');
  }
  const stagingReady = stagingMissing.length === 0;

  const configMissing: string[] = [];
  if (!prod.checks.postgresConfigured) configMissing.push('DATABASE_URL (or SQL_HOST / PGHOST)');
  if (!prod.checks.encryptionKeyValid) configMissing.push('SHOPIFY_TOKEN_ENCRYPTION_KEY');

  const integrations: Record<CommercialStageId, CommercialReadinessItem> = {
    config_readiness: {
      id: 'config_readiness',
      label: 'Local & CI Infrastructure (PostgreSQL + Token Encryption)',
      status: configMissing.length === 0 ? 'READY' : 'BLOCKED',
      configured: configMissing.length === 0,
      missingEnvVars: configMissing,
      notes: [
        prod.checks.postgresConfigured
          ? 'PostgreSQL connection variables configured.'
          : 'Local dev/unit tests run against MemoryRepository; live PG tests require PostgreSQL.',
      ],
    },
    stage_1_shopify: {
      id: 'stage_1_shopify',
      label: 'Stage 1 — Shopify Development Store',
      status: shopifyReady ? 'READY' : 'BLOCKED',
      configured: shopifyReady,
      missingEnvVars: shopifyMissing,
      notes: shopifyNotes,
    },
    stage_2_stripe: {
      id: 'stage_2_stripe',
      label: 'Stage 2 — Stripe Test Mode',
      status: stripeReady ? 'READY' : 'BLOCKED',
      configured: stripeReady,
      missingEnvVars: stripeMissing,
      notes: stripeNotes,
    },
    stage_3_smtp: {
      id: 'stage_3_smtp',
      label: 'Stage 3 — Real SMTP Provider',
      status: smtpReady ? 'READY' : 'BLOCKED',
      configured: smtpReady,
      missingEnvVars: smtpMissing,
      notes: smtpNotes,
    },
    stage_4_staging_e2e: {
      id: 'stage_4_staging_e2e',
      label: 'Stage 4 — Staging End-to-End Customer Journey',
      status: stagingReady ? 'READY' : 'BLOCKED',
      configured: stagingReady,
      missingEnvVars: stagingMissing,
      notes: stagingNotes,
    },
  };

  const externalReadyCount = [shopifyReady, stripeReady, smtpReady, stagingReady].filter(Boolean).length;
  const summaryStatus =
    externalReadyCount === 4
      ? 'READY_FOR_ALL_STAGES'
      : externalReadyCount === 0
      ? 'ALL_EXTERNAL_BLOCKED'
      : 'PARTIAL_BLOCKED';

  return {
    checkedAt,
    environment: prod.environment,
    externalVerificationActivated: externalActivated,
    localDevReady: prod.valid,
    ciPostgresReady: prod.checks.postgresConfigured,
    integrations,
    summaryStatus,
  };
}

const STRICT_REMOTE_HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHostname(rawHostname: string): string {
  return rawHostname.trim().toLowerCase().replace(/\.+$/, '');
}

export interface ProductionHostDenylistOptions {
  productionHosts?: string;
  productionAppUrl?: string;
  nodeEnv?: string;
  appUrl?: string;
}

export function parseProductionHosts(rawProductionHosts?: string): {
  valid: boolean;
  hosts: Set<string>;
  reason?: string;
} {
  const raw = rawProductionHosts !== undefined ? rawProductionHosts : process.env.PRODUCTION_HOSTS;
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { valid: true, hosts: new Set<string>() };
  }

  const hosts = new Set<string>();
  const parts = trimmed.split(',');
  for (const part of parts) {
    const candidate = normalizeHostname(part);
    if (!candidate) {
      return {
        valid: false,
        hosts: new Set(),
        reason: 'PRODUCTION_HOSTS contains an empty entry',
      };
    }
    if (
      candidate.includes('*') ||
      candidate.includes('://') ||
      candidate.includes('/') ||
      candidate.includes('?') ||
      candidate.includes('#') ||
      candidate.includes('@') ||
      candidate.includes(':') ||
      /\s/.test(candidate)
    ) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `PRODUCTION_HOSTS contains invalid host format "${part.trim()}" (expected plain DNS hostname without scheme, port, path, userinfo, or wildcard)`,
      };
    }
    if (!STRICT_REMOTE_HOSTNAME_RE.test(candidate)) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `PRODUCTION_HOSTS contains malformed hostname "${part.trim()}"`,
      };
    }
    hosts.add(candidate);
  }

  return { valid: true, hosts };
}

export function parseProductionAppUrlHost(rawProductionAppUrl?: string): {
  valid: boolean;
  host?: string;
  reason?: string;
} {
  const raw =
    rawProductionAppUrl !== undefined ? rawProductionAppUrl : process.env.PRODUCTION_APP_URL;
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === 'MY_APP_URL') {
    return { valid: true };
  }

  if (/[\s\r\n\0\\]/.test(trimmed)) {
    return {
      valid: false,
      reason: 'PRODUCTION_APP_URL contains invalid whitespace, control character, or backslash',
    };
  }

  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const authority = withoutScheme.split(/[/?#]/)[0] || '';
  if (authority.includes('@')) {
    return {
      valid: false,
      reason: 'PRODUCTION_APP_URL must not contain embedded credentials or userinfo',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'PRODUCTION_APP_URL is not a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: `PRODUCTION_APP_URL must use https:// (got "${parsed.protocol}")`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: 'PRODUCTION_APP_URL must not contain embedded credentials',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      valid: false,
      reason: 'PRODUCTION_APP_URL must not contain query parameters or fragments',
    };
  }

  const host = normalizeHostname(parsed.hostname);
  if (!host || !STRICT_REMOTE_HOSTNAME_RE.test(host)) {
    return {
      valid: false,
      reason: `PRODUCTION_APP_URL contains invalid hostname "${parsed.hostname}"`,
    };
  }

  if (isLoopbackOrLocalHostname(host) || isPrivateOrLinkLocalIpHostname(host)) {
    return {
      valid: false,
      reason: `PRODUCTION_APP_URL cannot target loopback or private address "${host}"`,
    };
  }

  return { valid: true, host };
}

export function resolveProductionDenylist(options: ProductionHostDenylistOptions = {}): {
  valid: boolean;
  hosts: Map<string, string>;
  reason?: string;
} {
  const hosts = new Map<string, string>();

  const explicitHosts = parseProductionHosts(options.productionHosts);
  if (!explicitHosts.valid) {
    return { valid: false, hosts: new Map(), reason: explicitHosts.reason };
  }
  for (const h of explicitHosts.hosts) {
    hosts.set(h, 'PRODUCTION_HOSTS');
  }

  const prodAppUrl = parseProductionAppUrlHost(options.productionAppUrl);
  if (!prodAppUrl.valid) {
    return { valid: false, hosts: new Map(), reason: prodAppUrl.reason };
  }
  if (prodAppUrl.host && !hosts.has(prodAppUrl.host)) {
    hosts.set(prodAppUrl.host, 'PRODUCTION_APP_URL');
  }

  const effectiveEnv = options.nodeEnv !== undefined ? options.nodeEnv : process.env.NODE_ENV;
  const rawAppUrl = (options.appUrl !== undefined ? options.appUrl : process.env.APP_URL)?.trim();
  if (effectiveEnv === 'production' && rawAppUrl && rawAppUrl !== 'MY_APP_URL') {
    try {
      const parsedProd = new URL(rawAppUrl);
      const prodHost = normalizeHostname(parsedProd.hostname);
      if (prodHost && !hosts.has(prodHost)) {
        hosts.set(prodHost, 'APP_URL (NODE_ENV=production)');
      }
    } catch {
      // ignore malformed APP_URL in non-strict path
    }
  }

  return { valid: true, hosts };
}

function isBuiltInProductionHostname(normalizedHost: string): boolean {
  return (
    /^(?:www\.|app\.|api\.)?aixshop\.(?:io|com|app)$/.test(normalizedHost) ||
    /^prod(?:uction)?\./.test(normalizedHost)
  );
}

export function checkProductionDomainHostname(
  host: string,
  options: ProductionHostDenylistOptions = {}
): {
  valid: boolean;
  isProductionTarget: boolean;
  matchedSource?: string;
  reason?: string;
} {
  const normalized = normalizeHostname(host);
  if (!normalized) {
    return { valid: false, isProductionTarget: false, reason: 'Missing hostname' };
  }

  const denylist = resolveProductionDenylist(options);
  if (!denylist.valid) {
    return {
      valid: false,
      isProductionTarget: false,
      reason: denylist.reason,
    };
  }

  const explicitSource = denylist.hosts.get(normalized);
  if (explicitSource) {
    return {
      valid: false,
      isProductionTarget: true,
      matchedSource: explicitSource,
      reason: `STAGING_BASE_URL (${normalized}) matches production denylist (${explicitSource}) and is refused for destructive staging tests`,
    };
  }

  if (isBuiltInProductionHostname(normalized)) {
    return {
      valid: false,
      isProductionTarget: true,
      matchedSource: 'built-in production domain pattern',
      reason: `STAGING_BASE_URL (${normalized}) appears to be a production domain and is refused for destructive staging tests`,
    };
  }

  return { valid: true, isProductionTarget: false };
}

function isPrivateOrLinkLocalIpHostname(rawHostname: string): boolean {
  const unbracketed = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ver = isIP(unbracketed);
  if (ver === 4) {
    const octets = unbracketed.split('.').map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true; // CGNAT
  }
  if (ver === 6) {
    const firstWord = parseInt(unbracketed.split(':')[0] || '0', 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  }
  return false;
}

export function parseStagingAllowedHosts(
  rawAllowedHosts?: string,
  options: ProductionHostDenylistOptions = {}
): {
  valid: boolean;
  hosts: Set<string>;
  reason?: string;
} {
  const denylist = resolveProductionDenylist(options);
  if (!denylist.valid) {
    return {
      valid: false,
      hosts: new Set(),
      reason: denylist.reason,
    };
  }

  const raw = rawAllowedHosts !== undefined ? rawAllowedHosts : process.env.STAGING_ALLOWED_HOSTS;
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      hosts: new Set(),
      reason: 'STAGING_ALLOWED_HOSTS is empty or unset (explicit comma-separated staging hostname allowlist required)',
    };
  }

  const hosts = new Set<string>();
  const parts = trimmed.split(',');
  for (const part of parts) {
    const candidate = normalizeHostname(part);
    if (!candidate) {
      return {
        valid: false,
        hosts: new Set(),
        reason: 'STAGING_ALLOWED_HOSTS contains an empty entry',
      };
    }
    if (
      candidate.includes('*') ||
      candidate.includes('://') ||
      candidate.includes('/') ||
      candidate.includes('?') ||
      candidate.includes('#') ||
      candidate.includes('@') ||
      candidate.includes(':') ||
      /\s/.test(candidate)
    ) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `STAGING_ALLOWED_HOSTS contains invalid host format "${part.trim()}" (expected plain DNS hostname without scheme, port, path, userinfo, or wildcard)`,
      };
    }
    if (!STRICT_REMOTE_HOSTNAME_RE.test(candidate)) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `STAGING_ALLOWED_HOSTS contains malformed hostname "${part.trim()}"`,
      };
    }
    if (isLoopbackOrLocalHostname(candidate) || isPrivateOrLinkLocalIpHostname(candidate)) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `STAGING_ALLOWED_HOSTS cannot include loopback or private address "${candidate}"`,
      };
    }
    const prodOverlap = checkProductionDomainHostname(candidate, options);
    if (!prodOverlap.valid) {
      return {
        valid: false,
        hosts: new Set(),
        reason: `STAGING_ALLOWED_HOSTS cannot include production domain "${candidate}" (${prodOverlap.matchedSource || 'production denylist'})`,
      };
    }
    hosts.add(candidate);
  }

  if (hosts.size === 0) {
    return {
      valid: false,
      hosts: new Set(),
      reason: 'STAGING_ALLOWED_HOSTS has no valid hostnames',
    };
  }

  return { valid: true, hosts };
}

export function validateStagingBaseUrlNonProduction(
  rawUrl: string | undefined,
  options: {
    allowedHosts?: string;
    allowLocalMode?: boolean;
    productionHosts?: string;
    productionAppUrl?: string;
    nodeEnv?: string;
    appUrl?: string;
  } = {}
): {
  valid: boolean;
  isProductionTarget: boolean;
  isAllowlistRejected?: boolean;
  isLocalTarget?: boolean;
  normalizedUrl?: string;
  reason?: string;
} {
  // Always fail closed if explicit production denylist configuration is malformed
  const denylist = resolveProductionDenylist(options);
  if (!denylist.valid) {
    return {
      valid: false,
      isProductionTarget: false,
      reason: denylist.reason,
    };
  }

  const trimmed = rawUrl?.trim() || '';
  if (!trimmed) {
    return { valid: false, isProductionTarget: false, reason: 'STAGING_BASE_URL' };
  }

  if (/[\s\r\n\0\\]/.test(trimmed)) {
    return {
      valid: false,
      isProductionTarget: false,
      reason: 'STAGING_BASE_URL (contains invalid whitespace, control character, or backslash)',
    };
  }

  // Explicitly detect '@' in the authority section before path/query/hash
  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const authority = withoutScheme.split(/[/?#]/)[0] || '';
  if (authority.includes('@')) {
    return {
      valid: false,
      isProductionTarget: false,
      reason: 'STAGING_BASE_URL (must not contain embedded credentials or userinfo)',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, isProductionTarget: false, reason: 'STAGING_BASE_URL (invalid URL)' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      isProductionTarget: false,
      reason: `STAGING_BASE_URL (unsupported protocol "${parsed.protocol}")`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      isProductionTarget: false,
      reason: 'STAGING_BASE_URL (must not contain embedded credentials)',
    };
  }

  const host = normalizeHostname(parsed.hostname);
  if (!host) {
    return { valid: false, isProductionTarget: false, reason: 'STAGING_BASE_URL (missing hostname)' };
  }

  // 1. Strict production denylist (PRODUCTION_HOSTS, PRODUCTION_APP_URL, built-in patterns, APP_URL in prod)
  // Runs regardless of NODE_ENV and BEFORE STAGING_ALLOWED_HOSTS / allowLocalMode
  const prodCheck = checkProductionDomainHostname(host, options);
  if (!prodCheck.valid) {
    return {
      valid: false,
      isProductionTarget: prodCheck.isProductionTarget,
      reason: prodCheck.reason,
    };
  }

  const allowLocalMode =
    options.allowLocalMode ??
    ((process.env.STAGING_ALLOW_LOCAL || '').trim().toLowerCase() === 'true');
  const isLocalHost = isLoopbackOrLocalHostname(host);

  // 2. Localhost/loopback is ONLY allowed in explicit local ephemeral test mode
  if (isLocalHost) {
    if (!allowLocalMode) {
      return {
        valid: false,
        isProductionTarget: false,
        isAllowlistRejected: true,
        reason: `STAGING_BASE_URL (${host}) uses localhost/loopback which is rejected for remote staging (set STAGING_ALLOW_LOCAL=true only for isolated local test servers)`,
      };
    }
    return {
      valid: true,
      isProductionTarget: false,
      isLocalTarget: true,
      normalizedUrl: trimmed.replace(/\/+$/, ''),
    };
  }

  // 3. Remote staging targets MUST use HTTPS (STAGING_ALLOW_LOCAL never weakens remote targets)
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      isProductionTarget: false,
      isAllowlistRejected: true,
      reason: `STAGING_BASE_URL (${host}) must use https:// for remote staging targets`,
    };
  }

  if (isPrivateOrLinkLocalIpHostname(host)) {
    return {
      valid: false,
      isProductionTarget: false,
      isAllowlistRejected: true,
      reason: `STAGING_BASE_URL (${host}) targets a private or link-local IP address and is refused`,
    };
  }

  // 4. Remote host MUST match explicit STAGING_ALLOWED_HOSTS allowlist (and allowlist must not contradict denylist)
  const allowlist = parseStagingAllowedHosts(options.allowedHosts, options);
  if (!allowlist.valid) {
    return {
      valid: false,
      isProductionTarget: false,
      isAllowlistRejected: true,
      reason: `${allowlist.reason}; refusing staging target "${host}"`,
    };
  }

  if (!allowlist.hosts.has(host)) {
    return {
      valid: false,
      isProductionTarget: false,
      isAllowlistRejected: true,
      reason: `STAGING_HOST_NOT_ALLOWED: Host "${host}" is not present in STAGING_ALLOWED_HOSTS`,
    };
  }

  return {
    valid: true,
    isProductionTarget: false,
    isLocalTarget: false,
    normalizedUrl: trimmed.replace(/\/+$/, ''),
  };
}

export const DEFAULT_SIMULATED_ARTIFACT_PATH = 'reports/simulated-test-results.json';

export const SIMULATED_SUITE_DEFINITIONS: ReadonlyArray<{
  testId: string;
  stage: CommercialStageId;
  name: string;
  purpose: string;
  targetEnvironment: string;
  executionMode: ExecutionMode;
  suiteFile: string;
}> = [
  {
    testId: 'SIM-CUSTOMER-JOURNEY-30',
    stage: 'stage_4_staging_e2e',
    name: '30-Step Full Customer Journey (Local HTTP + Sandbox Billing + Mocked Shopify + Loopback SMTP)',
    purpose: 'Verify end-to-end customer journey with mocked Shopify, Sandbox Stripe, and local TCP SMTP',
    targetEnvironment: 'local-ephemeral-memory-repo',
    executionMode: 'unit_mock',
    suiteFile: 'src/server/customerJourney30Step.e2e.test.ts',
  },
  {
    testId: 'SIM-SHOPIFY-WRITEBACK',
    stage: 'stage_1_shopify',
    name: 'Shopify Write-Back Scope Gate, Mutation & Post-Mutation Read-Back Verification',
    purpose: 'Verify write_products gating, allowlisted fields, GraphQL mutation, read-back match, and audit trail',
    targetEnvironment: 'local-mock-shopify-graphql',
    executionMode: 'contract_fixture',
    suiteFile: 'src/server/shopifyWriteBack.test.ts',
  },
  {
    testId: 'SIM-BILLING-EMAILS',
    stage: 'stage_3_smtp',
    name: 'Billing Lifecycle Emails (5 Events), Webhook/Checkout Deduplication & Retry Recovery',
    purpose: 'Verify initial, renewal, plan_changed, payment_failed, and subscription_canceled email delivery',
    targetEnvironment: 'local-mock-smtp-transport',
    executionMode: 'unit_mock',
    suiteFile: 'src/server/billingEmail.test.ts',
  },
  {
    testId: 'SIM-COMMERCIAL-HARNESS',
    stage: 'stage_2_stripe',
    name: 'Commercial Integration Contract Harness (Shopify OAuth/Sync/Webhook + Stripe Lifecycle + SMTP)',
    purpose: 'Verify signed contract fixtures, rate-limit retries, lease recovery, and cross-tenant guards',
    targetEnvironment: 'local-contract-harness',
    executionMode: 'contract_fixture',
    suiteFile: 'src/server/commercialVerificationHarness.test.ts',
  },
];

function isValidIsoTimestamp(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const ts = Date.parse(raw);
  return Number.isFinite(ts);
}

function normalizeSuitePath(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    : '';
}

export interface EvaluateSimulatedArtifactOptions {
  artifactPath?: string;
  parseError?: string;
  fallbackTimestamp?: string;
  repoRoot?: string;
}

export function evaluateSimulatedChecksFromArtifact(
  artifactInput: unknown,
  options: EvaluateSimulatedArtifactOptions = {}
): {
  checks: VerificationCheckResult[];
  artifactRunId?: string;
} {
  const fallbackTs = options.fallbackTimestamp || new Date().toISOString();
  const artifactLabel = options.artifactPath || DEFAULT_SIMULATED_ARTIFACT_PATH;
  const repoRoot = path.resolve(options.repoRoot || process.cwd());

  if (options.parseError) {
    return {
      checks: SIMULATED_SUITE_DEFINITIONS.map((def) => ({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Malformed simulated test artifact (${artifactLabel}): ${redactSecrets(options.parseError)}`,
      })),
    };
  }

  if (artifactInput === null || artifactInput === undefined) {
    return {
      checks: SIMULATED_SUITE_DEFINITIONS.map((def) => ({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'NOT RUN',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `No verifiable test execution artifact found at "${artifactLabel}". Run simulated suites to generate evidence.`,
      })),
    };
  }

  if (typeof artifactInput !== 'object' || Array.isArray(artifactInput)) {
    return {
      checks: SIMULATED_SUITE_DEFINITIONS.map((def) => ({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Invalid simulated test artifact root structure at "${artifactLabel}" (expected JSON object).`,
      })),
    };
  }

  const art = artifactInput as Record<string, unknown>;
  const topErrors: string[] = [];
  if (art.schemaVersion !== '1.0') {
    topErrors.push(`unsupported or missing schemaVersion "${String(art.schemaVersion ?? '')}"`);
  }
  if (typeof art.runId !== 'string' || !art.runId.trim()) {
    topErrors.push('missing runId');
  }
  if (!isValidIsoTimestamp(art.generatedAt)) {
    topErrors.push('missing or invalid generatedAt timestamp');
  }
  if (typeof art.runner !== 'string' || !art.runner.trim()) {
    topErrors.push('missing runner');
  }
  if (!Array.isArray(art.suites)) {
    topErrors.push('missing suites array');
  }

  if (topErrors.length > 0) {
    return {
      checks: SIMULATED_SUITE_DEFINITIONS.map((def) => ({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Corrupted or incomplete simulated test artifact (${artifactLabel}): ${topErrors.join('; ')}`,
      })),
    };
  }

  const artifact = art as unknown as SimulatedTestResultsArtifact;
  const expectedFileById = new Map(SIMULATED_SUITE_DEFINITIONS.map((d) => [d.testId, d.suiteFile]));
  const expectedIdByFile = new Map(SIMULATED_SUITE_DEFINITIONS.map((d) => [d.suiteFile, d.testId]));

  // Verify every entry in artifact.suites maps strictly to an expected (suiteId <-> suiteFile) pair
  const structuralErrors: string[] = [];
  for (let i = 0; i < artifact.suites.length; i++) {
    const rawEntry: any = artifact.suites[i];
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      structuralErrors.push(`suites[${i}] is not an object`);
      continue;
    }
    const sId =
      typeof rawEntry.suiteId === 'string' && rawEntry.suiteId.trim()
        ? rawEntry.suiteId.trim()
        : typeof rawEntry.testId === 'string' && rawEntry.testId.trim()
        ? rawEntry.testId.trim()
        : '';
    const sFile = normalizeSuitePath(rawEntry.suiteFile);
    if (!sId) {
      structuralErrors.push(`suites[${i}] is missing required suiteId (suiteFile="${sFile || 'unknown'}")`);
      continue;
    }
    const expectedFile = expectedFileById.get(sId);
    if (!expectedFile) {
      structuralErrors.push(`unknown suiteId "${sId}" in artifact`);
      continue;
    }
    if (!sFile) {
      structuralErrors.push(`suiteId "${sId}" is missing suiteFile`);
      continue;
    }
    if (sFile !== expectedFile || expectedIdByFile.get(sFile) !== sId) {
      structuralErrors.push(
        `suiteId "${sId}" mapped to incorrect file "${sFile}" (expected "${expectedFile}")`
      );
    }
  }

  if (structuralErrors.length > 0) {
    return {
      checks: SIMULATED_SUITE_DEFINITIONS.map((def) => ({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Artifact integrity check failed (${artifactLabel}): ${structuralErrors.join('; ')}`,
      })),
    };
  }

  const checks: VerificationCheckResult[] = [];

  for (const def of SIMULATED_SUITE_DEFINITIONS) {
    const matches = artifact.suites.filter(
      (s) =>
        s &&
        typeof s === 'object' &&
        normalizeSuitePath((s as any).suiteFile) === def.suiteFile &&
        ((s as any).suiteId || (s as any).testId) === def.testId
    );

    if (matches.length === 0) {
      checks.push({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'NOT RUN',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Suite "${def.suiteFile}" has no execution result in artifact run "${artifact.runId}".`,
      });
      continue;
    }

    if (matches.length > 1) {
      checks.push({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: fallbackTs,
        blockerOrFailure: `Duplicate suite entries for "${def.suiteFile}" in artifact run "${artifact.runId}".`,
      });
      continue;
    }

    const entry = matches[0];
    const entryErrors: string[] = [];
    const declaredId = (entry.suiteId || (entry as any).testId || '').trim();
    if (!declaredId) {
      entryErrors.push(`missing required suiteId (expected ${def.testId})`);
    } else if (declaredId !== def.testId) {
      entryErrors.push(`suiteId mismatch (expected ${def.testId}, got ${String(declaredId)})`);
    }
    if (!isValidIsoTimestamp(entry.executedAt)) {
      entryErrors.push('missing or invalid executedAt');
    }
    if (typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
      entryErrors.push('missing or invalid durationMs');
    }
    if (typeof entry.exitCode !== 'number' || !Number.isInteger(entry.exitCode)) {
      entryErrors.push('missing or invalid exitCode');
    }
    if (typeof entry.passedCount !== 'number' || !Number.isInteger(entry.passedCount) || entry.passedCount < 0) {
      entryErrors.push('missing or invalid passedCount');
    }
    if (typeof entry.failedCount !== 'number' || !Number.isInteger(entry.failedCount) || entry.failedCount < 0) {
      entryErrors.push('missing or invalid failedCount');
    }
    const skippedCount = entry.skippedCount ?? 0;
    if (
      entry.skippedCount !== undefined &&
      (typeof entry.skippedCount !== 'number' || !Number.isInteger(entry.skippedCount) || entry.skippedCount < 0)
    ) {
      entryErrors.push('invalid skippedCount');
    }
    if (typeof entry.totalCount !== 'number' || !Number.isInteger(entry.totalCount) || entry.totalCount <= 0) {
      entryErrors.push('missing or invalid totalCount (> 0 required)');
    }
    if (entry.status !== 'PASS' && entry.status !== 'FAIL') {
      entryErrors.push(`invalid status "${String((entry as any).status)}"`);
    }
    if (
      entryErrors.length === 0 &&
      entry.passedCount + entry.failedCount + skippedCount !== entry.totalCount
    ) {
      entryErrors.push(
        `test count mismatch (${entry.passedCount} passed + ${entry.failedCount} failed + ${skippedCount} skipped != ${entry.totalCount} total)`
      );
    }
    if (
      entryErrors.length === 0 &&
      entry.status === 'PASS' &&
      (entry.exitCode !== 0 || entry.failedCount > 0 || entry.passedCount <= 0)
    ) {
      entryErrors.push(
        `inconsistent suite status "PASS" with exitCode=${entry.exitCode}, failedCount=${entry.failedCount}, passedCount=${entry.passedCount}`
      );
    }

    // Recalculate and verify SHA-256 against the actual current test suite file on disk
    let actualSha256: string | undefined;
    const rawDigest = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : '';
    if (!rawDigest) {
      entryErrors.push(`missing sha256 digest for "${def.suiteFile}"`);
    } else if (!/^[0-9a-f]{64}$/.test(rawDigest)) {
      entryErrors.push(`malformed sha256 digest for "${def.suiteFile}"`);
    } else {
      const absSuitePath = path.resolve(repoRoot, def.suiteFile);
      if (
        !absSuitePath.startsWith(repoRoot + path.sep) ||
        !fsSync.existsSync(absSuitePath)
      ) {
        entryErrors.push(`suite file "${def.suiteFile}" missing on disk for SHA-256 verification`);
      } else {
        try {
          const content = fsSync.readFileSync(absSuitePath);
          actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
          const recordedBuf = Buffer.from(rawDigest, 'hex');
          const actualBuf = Buffer.from(actualSha256, 'hex');
          if (recordedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(recordedBuf, actualBuf)) {
            entryErrors.push(
              `SHA-256 digest mismatch for "${def.suiteFile}" (artifact=${rawDigest}, current=${actualSha256})`
            );
          }
        } catch (hashErr: any) {
          entryErrors.push(`failed hashing "${def.suiteFile}": ${redactSecrets(hashErr)}`);
        }
      }
    }

    if (entryErrors.length > 0) {
      checks.push({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: isValidIsoTimestamp(entry.executedAt) ? entry.executedAt : fallbackTs,
        blockerOrFailure: `Incomplete or tampered suite result for "${def.suiteFile}": ${entryErrors.join('; ')}`,
      });
      continue;
    }

    const evidence: Record<string, unknown> = {
      suiteFile: def.suiteFile,
      artifactRunId: artifact.runId,
      artifactGeneratedAt: artifact.generatedAt,
      runner: artifact.runner,
      passedCount: entry.passedCount,
      failedCount: entry.failedCount,
      skippedCount,
      totalCount: entry.totalCount,
      exitCode: entry.exitCode,
      sha256: actualSha256,
      sha256Verified: true,
      liveProviderVerified: false,
    };

    const genuinelyPassed =
      entry.status === 'PASS' &&
      entry.exitCode === 0 &&
      entry.failedCount === 0 &&
      entry.passedCount > 0 &&
      entry.passedCount + skippedCount === entry.totalCount &&
      Boolean(actualSha256);

    if (genuinelyPassed) {
      checks.push({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'PASS — SIMULATED',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: entry.executedAt,
        durationMs: entry.durationMs,
        evidence,
      });
    } else {
      checks.push({
        testId: def.testId,
        stage: def.stage,
        name: def.name,
        purpose: def.purpose,
        status: 'FAIL',
        executionMode: def.executionMode,
        targetEnvironment: def.targetEnvironment,
        executedAt: entry.executedAt,
        durationMs: entry.durationMs,
        evidence,
        blockerOrFailure: `Simulated suite "${def.suiteFile}" failed (status=${entry.status}, exitCode=${entry.exitCode}, failed=${entry.failedCount}, passed=${entry.passedCount}/${entry.totalCount}).`,
      });
    }
  }

  return { checks, artifactRunId: artifact.runId };
}

export function loadAndEvaluateSimulatedArtifact(
  artifactPath = path.resolve(process.cwd(), DEFAULT_SIMULATED_ARTIFACT_PATH),
  fallbackTimestamp?: string,
  options: { repoRoot?: string } = {}
): {
  checks: VerificationCheckResult[];
  artifactPath: string;
  artifactRunId?: string;
} {
  const resolvedPath = path.resolve(artifactPath);
  if (!fsSync.existsSync(resolvedPath)) {
    const res = evaluateSimulatedChecksFromArtifact(null, {
      artifactPath: resolvedPath,
      fallbackTimestamp,
      repoRoot: options.repoRoot,
    });
    return { ...res, artifactPath: resolvedPath };
  }

  try {
    const raw = fsSync.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    const res = evaluateSimulatedChecksFromArtifact(parsed, {
      artifactPath: resolvedPath,
      fallbackTimestamp,
      repoRoot: options.repoRoot,
    });
    return { ...res, artifactPath: resolvedPath };
  } catch (err: any) {
    const res = evaluateSimulatedChecksFromArtifact(null, {
      artifactPath: resolvedPath,
      parseError: err?.message || String(err),
      fallbackTimestamp,
      repoRoot: options.repoRoot,
    });
    return { ...res, artifactPath: resolvedPath };
  }
}

export function summarizeStage(
  stage: CommercialStageId,
  title: string,
  checks: VerificationCheckResult[],
  missingEnvVars: string[] = []
): StageVerificationSummary {
  const pass = checks.filter((c) => c.status === 'PASS').length;
  const simulated = checks.filter((c) => c.status === 'PASS — SIMULATED').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const blocked = checks.filter((c) => c.status === 'BLOCKED').length;
  const notRun = checks.filter((c) => c.status === 'NOT RUN').length;

  let status: VerificationStatus = 'NOT RUN';
  if (fail > 0) {
    status = 'FAIL';
  } else if (blocked > 0) {
    status = 'BLOCKED';
  } else if (pass > 0 && notRun === 0) {
    status = 'PASS';
  } else if (pass === 0 && simulated > 0 && notRun === 0) {
    status = 'PASS — SIMULATED';
  }

  return {
    stage,
    title,
    status,
    counts: { pass, simulated, fail, blocked, notRun, total: checks.length },
    missingEnvVars,
    checks,
  };
}

export function computeOverallStatus(stages: StageVerificationSummary[]): VerificationStatus {
  if (stages.some((s) => s.status === 'FAIL')) return 'FAIL';
  if (stages.some((s) => s.status === 'BLOCKED')) return 'BLOCKED';
  if (stages.some((s) => s.status === 'NOT RUN')) return 'NOT RUN';
  if (stages.every((s) => s.status === 'PASS') && stages.length > 0) return 'PASS';
  if (stages.every((s) => s.status === 'PASS' || s.status === 'PASS — SIMULATED') && stages.length > 0) {
    return 'PASS — SIMULATED';
  }
  return 'NOT RUN';
}

export function createRunId(prefix = 'cv'): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function renderVerificationMarkdown(report: CommercialVerificationReport): string {
  const lines: string[] = [];
  lines.push('# AIXSHOP v1.0 — Commercial Integration Verification Report');
  lines.push('');
  lines.push(`- **Generated At:** ${report.generatedAt}`);
  lines.push(`- **Run ID:** \`${report.runId}\``);
  lines.push(`- **Target Environment:** \`${report.targetEnvironment}\``);
  lines.push(`- **External Verification Opt-In (\`COMMERCIAL_VERIFY_EXTERNAL\`):** ${report.externalVerificationActivated ? 'ENABLED' : 'DISABLED (BLOCKED)'}`);
  lines.push(`- **Overall External Verification Status:** **${report.overallExternalStatus}**`);
  if (report.simulatedArtifactPath) {
    lines.push(
      `- **Simulated Evidence Artifact:** \`${report.simulatedArtifactPath}\`${report.simulatedArtifactRunId ? ` (runId: \`${report.simulatedArtifactRunId}\`)` : ' (not present or unverified)'}`
    );
  }
  lines.push(`- **Cleanup Performed:** ${report.cleanupPerformed ? 'Yes' : 'No (no external test artifacts created or skipped)'}`);
  lines.push('');
  lines.push('## Status Model');
  lines.push('- `PASS`: Executed against the intended real target with verifiable evidence.');
  lines.push('- `PASS — SIMULATED`: Executed end-to-end using local mocks, fixtures, or test doubles only (never live external providers), backed by a verified test execution artifact.');
  lines.push('- `FAIL`: Executed and failed.');
  lines.push('- `BLOCKED`: Cannot execute because required credentials, targets, or opt-in activation are missing.');
  lines.push('- `NOT RUN`: Not yet executed or no verifiable execution artifact present.');
  lines.push('');
  lines.push('## Stage Readiness Summary');
  lines.push('');
  lines.push('| Stage | Status | Pass | Simulated | Fail | Blocked | Not Run | Missing / Blocking Prerequisites |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const s of report.stages) {
    const missing = s.missingEnvVars.length > 0 ? s.missingEnvVars.map((v) => `\`${v}\``).join(', ') : 'None';
    lines.push(
      `| ${s.title} | **${s.status}** | ${s.counts.pass} | ${s.counts.simulated ?? 0} | ${s.counts.fail} | ${s.counts.blocked} | ${s.counts.notRun} | ${missing} |`
    );
  }
  lines.push('');
  lines.push('## Detailed Check Matrix');
  lines.push('');
  for (const s of report.stages) {
    lines.push(`### ${s.title} (${s.status})`);
    lines.push('');
    lines.push('| Test ID | Check | Target Environment | Execution Mode | Timestamp (UTC) | Duration (ms) | Result | Evidence | Blocker / Failure |');
    lines.push('| --- | --- | --- | --- | --- | ---: | --- | --- | --- |');
    for (const c of s.checks) {
      const evidenceText = c.evidence
        ? redactSecrets(JSON.stringify(sanitizeEvidenceObject(c.evidence))).replace(/\|/g, '\\|')
        : '—';
      const blockerText = c.blockerOrFailure
        ? redactSecrets(c.blockerOrFailure).replace(/\|/g, '\\|')
        : '—';
      const durText = typeof c.durationMs === 'number' ? String(c.durationMs) : '—';
      lines.push(
        `| \`${c.testId}\` | ${c.name} | \`${c.targetEnvironment}\` | \`${c.executionMode}\` | \`${c.executedAt}\` | ${durText} | **${c.status}** | ${evidenceText} | ${blockerText} |`
      );
    }
    lines.push('');
  }

  if (report.simulatedChecks && report.simulatedChecks.length > 0) {
    lines.push('## Simulated Integration & Customer Journey Checks');
    lines.push('');
    lines.push('| Test ID | Check | Target Environment | Execution Mode | Timestamp (UTC) | Duration (ms) | Result | Evidence | Blocker / Failure |');
    lines.push('| --- | --- | --- | --- | --- | ---: | --- | --- | --- |');
    for (const c of report.simulatedChecks) {
      const evidenceText = c.evidence
        ? redactSecrets(JSON.stringify(sanitizeEvidenceObject(c.evidence))).replace(/\|/g, '\\|')
        : '—';
      const blockerText = c.blockerOrFailure
        ? redactSecrets(c.blockerOrFailure).replace(/\|/g, '\\|')
        : '—';
      const durText = typeof c.durationMs === 'number' ? String(c.durationMs) : '—';
      lines.push(
        `| \`${c.testId}\` | ${c.name} | \`${c.targetEnvironment}\` | \`${c.executionMode}\` | \`${c.executedAt}\` | ${durText} | **${c.status}** | ${evidenceText} | ${blockerText} |`
      );
    }
    lines.push('');
  }

  const cleanup = report.cleanupReport || report.stages.find((s) => s.cleanupReport)?.cleanupReport;
  if (cleanup) {
    lines.push('## Staging E2E Cleanup Summary');
    lines.push('');
    lines.push(`- **Cleanup Enabled (\`STAGING_CLEANUP_ENABLED\`):** ${cleanup.enabled ? 'true' : 'false'}`);
    lines.push(`- **Cleanup Status:** **${cleanup.status}**`);
    lines.push(`- **Tracked Users:** ${cleanup.trackedResources.userIds.length} (\`${cleanup.trackedResources.userIds.join(', ') || 'none'}\`)`);
    lines.push(`- **Tracked Workspaces:** ${cleanup.trackedResources.workspaceIds.length} (\`${cleanup.trackedResources.workspaceIds.join(', ') || 'none'}\`)`);
    lines.push(`- **Tracked Checkout Sessions:** ${cleanup.trackedResources.checkoutSessionIds.length}`);
    if (cleanup.expiredCheckoutSessionIds) {
      lines.push(`- **Expired Stripe Checkout Sessions:** ${cleanup.expiredCheckoutSessionIds.length} (\`${cleanup.expiredCheckoutSessionIds.join(', ') || 'none'}\`)`);
    }
    if (cleanup.failedCheckoutSessionIds && cleanup.failedCheckoutSessionIds.length > 0) {
      lines.push(`- **Failed Checkout Session Expirations:** ${cleanup.failedCheckoutSessionIds.length} (\`${cleanup.failedCheckoutSessionIds.join(', ')}\`)`);
    }
    lines.push(`- **Deleted Users:** ${cleanup.deletedUserIds.length} (\`${cleanup.deletedUserIds.join(', ') || 'none'}\`)`);
    lines.push(`- **Deleted Workspaces:** ${cleanup.deletedWorkspaceIds.length} (\`${cleanup.deletedWorkspaceIds.join(', ') || 'none'}\`)`);
    if (cleanup.verifiedSessionInvalidations) {
      lines.push(`- **Verified Session Invalidations:** ${cleanup.verifiedSessionInvalidations.length}`);
    }
    if (cleanup.warnings.length > 0) {
      lines.push(`- **Warnings:** ${cleanup.warnings.map((w) => redactSecrets(w)).join('; ')}`);
    }
    if (cleanup.errors.length > 0) {
      lines.push(`- **Errors:** ${cleanup.errors.map((e) => redactSecrets(e)).join('; ')}`);
    }
    lines.push('');
  }

  if (report.notes.length > 0) {
    lines.push('## Notes & Guardrails');
    for (const n of report.notes) {
      lines.push(`- ${redactSecrets(n)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeVerificationArtifacts(
  report: CommercialVerificationReport,
  markdownPath = path.resolve(process.cwd(), 'docs/COMMERCIAL_VERIFICATION_REPORT.md'),
  jsonPath?: string
): Promise<void> {
  const md = renderVerificationMarkdown(report);
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(markdownPath, md, 'utf8');
  if (jsonPath) {
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  }
}
