import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateProductionConfig, validateShopifyUrlConfig } from '../config/productionConfig';
import { validateStripePriceConfiguration } from '../billing/providerAdapter';
import { validateSmtpConfig } from '../services/emailService';

export type VerificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT RUN';

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
    fail: number;
    blocked: number;
    notRun: number;
    total: number;
  };
  missingEnvVars: string[];
  checks: VerificationCheckResult[];
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

export interface CommercialVerificationReport {
  generatedAt: string;
  runId: string;
  targetEnvironment: string;
  externalVerificationActivated: boolean;
  overallExternalStatus: VerificationStatus;
  readiness: CommercialEnvReadinessReport;
  stages: StageVerificationSummary[];
  cleanupPerformed: boolean;
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
  const stagingUrl = process.env.STAGING_BASE_URL?.trim() || '';
  if (!stagingUrl) {
    stagingMissing.push('STAGING_BASE_URL');
  } else {
    try {
      const parsed = new URL(stagingUrl);
      if (parsed.protocol !== 'https:' && process.env.STAGING_ALLOW_LOCAL !== 'true') {
        stagingMissing.push('STAGING_BASE_URL (must be https:// unless STAGING_ALLOW_LOCAL=true)');
      }
    } catch {
      stagingMissing.push('STAGING_BASE_URL (invalid URL)');
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

export function summarizeStage(
  stage: CommercialStageId,
  title: string,
  checks: VerificationCheckResult[],
  missingEnvVars: string[] = []
): StageVerificationSummary {
  const pass = checks.filter((c) => c.status === 'PASS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const blocked = checks.filter((c) => c.status === 'BLOCKED').length;
  const notRun = checks.filter((c) => c.status === 'NOT RUN').length;

  let status: VerificationStatus = 'NOT RUN';
  if (fail > 0) {
    status = 'FAIL';
  } else if (blocked > 0 && pass === 0) {
    status = 'BLOCKED';
  } else if (blocked > 0) {
    status = 'BLOCKED';
  } else if (pass > 0 && notRun === 0) {
    status = 'PASS';
  }

  return {
    stage,
    title,
    status,
    counts: { pass, fail, blocked, notRun, total: checks.length },
    missingEnvVars,
    checks,
  };
}

export function computeOverallStatus(stages: StageVerificationSummary[]): VerificationStatus {
  if (stages.some((s) => s.status === 'FAIL')) return 'FAIL';
  if (stages.some((s) => s.status === 'BLOCKED')) return 'BLOCKED';
  if (stages.every((s) => s.status === 'PASS') && stages.length > 0) return 'PASS';
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
  lines.push(`- **Cleanup Performed:** ${report.cleanupPerformed ? 'Yes' : 'No (no external test artifacts created or skipped)'}`);
  lines.push('');
  lines.push('## Status Model');
  lines.push('- `PASS`: Executed against the intended target with verifiable evidence.');
  lines.push('- `FAIL`: Executed and failed.');
  lines.push('- `BLOCKED`: Cannot execute because required credentials, targets, or opt-in activation are missing.');
  lines.push('- `NOT RUN`: Not yet executed.');
  lines.push('');
  lines.push('## Stage Readiness Summary');
  lines.push('');
  lines.push('| Stage | Status | Pass | Fail | Blocked | Not Run | Missing / Blocking Prerequisites |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const s of report.stages) {
    const missing = s.missingEnvVars.length > 0 ? s.missingEnvVars.map((v) => `\`${v}\``).join(', ') : 'None';
    lines.push(
      `| ${s.title} | **${s.status}** | ${s.counts.pass} | ${s.counts.fail} | ${s.counts.blocked} | ${s.counts.notRun} | ${missing} |`
    );
  }
  lines.push('');
  lines.push('## Detailed Check Matrix');
  lines.push('');
  for (const s of report.stages) {
    lines.push(`### ${s.title} (${s.status})`);
    lines.push('');
    lines.push('| Test ID | Check | Execution Mode | Status | Blocker / Evidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of s.checks) {
      const detail = c.blockerOrFailure
        ? redactSecrets(c.blockerOrFailure)
        : c.evidence
        ? redactSecrets(JSON.stringify(sanitizeEvidenceObject(c.evidence)))
        : '—';
      lines.push(`| \`${c.testId}\` | ${c.name} | \`${c.executionMode}\` | **${c.status}** | ${detail.replace(/\|/g, '\\|')} |`);
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
