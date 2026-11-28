import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CommercialVerificationReport,
  computeOverallStatus,
  createRunId,
  DEFAULT_SIMULATED_ARTIFACT_PATH,
  evaluateCommercialReadiness,
  isExternalVerificationActivated,
  loadAndEvaluateSimulatedArtifact,
  summarizeStage,
  writeVerificationArtifacts,
} from '../../src/server/verification/statusModel';
import { runShopifyExternalVerification } from '../../src/server/verification/shopifyVerifier';
import { runStripeExternalVerification } from '../../src/server/verification/stripeVerifier';
import { runSmtpExternalVerification } from '../../src/server/verification/smtpVerifier';
import { runStagingE2EVerification } from '../../src/server/verification/stagingE2EVerifier';
import { runSecretSafeConfigCheck } from '../../src/server/config/checkConfig';

export interface BuildCommercialReportOptions {
  simulatedArtifactPath?: string;
  repoRoot?: string;
  hmacKey?: string;
}

function getCliArgValue(prefix: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : undefined;
}

export async function buildCommercialVerificationReport(
  options: BuildCommercialReportOptions = {}
): Promise<CommercialVerificationReport> {
  const readiness = evaluateCommercialReadiness();
  const cfgCheck = runSecretSafeConfigCheck({ strict: false });
  const nowIso = new Date().toISOString();

  const configStage = summarizeStage(
    'config_readiness',
    'Stage 0 — Secret-Safe Environment & Infrastructure Readiness',
    [
      {
        testId: 'S0-LOCAL-CONFIG',
        stage: 'config_readiness',
        name: 'Local application config check (npm run config:check)',
        purpose: 'Validate base runtime URL, trust proxy, billing safety, and secret-safe reporting',
        status: cfgCheck.valid ? 'PASS' : 'FAIL',
        executionMode: 'unit_mock',
        targetEnvironment: cfgCheck.environment,
        executedAt: nowIso,
        evidence: { checks: cfgCheck.checks },
      },
      {
        testId: 'S0-POSTGRES-TARGET',
        stage: 'config_readiness',
        name: 'PostgreSQL target availability (DATABASE_URL / SQL_HOST)',
        purpose: 'Check whether live PostgreSQL integration targets are configured',
        status: readiness.ciPostgresReady ? 'PASS' : 'BLOCKED',
        executionMode: 'local_postgres',
        targetEnvironment: readiness.ciPostgresReady ? 'configured-postgres' : 'no-postgres-configured',
        executedAt: nowIso,
        ...(readiness.ciPostgresReady
          ? { evidence: { postgresConfigured: true } }
          : { blockerOrFailure: 'Missing prerequisites: DATABASE_URL (or SQL_HOST / PGHOST)' }),
      },
    ],
    readiness.integrations.config_readiness.missingEnvVars
  );

  const [stage1, stage2, stage3, stage4] = await Promise.all([
    runShopifyExternalVerification(),
    runStripeExternalVerification(),
    runSmtpExternalVerification(),
    runStagingE2EVerification(),
  ]);

  const externalStages = [stage1, stage2, stage3, stage4];
  const overallExternalStatus = computeOverallStatus(externalStages);

  const artifactPath =
    options.simulatedArtifactPath ||
    getCliArgValue('--simulated-artifact=') ||
    process.env.SIMULATED_TEST_ARTIFACT_PATH?.trim() ||
    path.resolve(process.cwd(), DEFAULT_SIMULATED_ARTIFACT_PATH);

  const simulatedEval = loadAndEvaluateSimulatedArtifact(artifactPath, nowIso, {
    repoRoot: options.repoRoot,
    hmacKey: options.hmacKey,
  });
  const relArtifactPath = path.relative(process.cwd(), simulatedEval.artifactPath);
  const displayArtifactPath =
    relArtifactPath && !relArtifactPath.startsWith('..') ? relArtifactPath : simulatedEval.artifactPath;

  const notes = [
    'Simulated checks are derived strictly from the verifiable test runner artifact (never hardcoded or inferred from file existence) and never count as live external provider verification.',
    'Local Shopify/Stripe HMAC & MemoryRepository checks are separated from live external webhook delivery checks (NOT RUN until verified against a deployed callback URL).',
    'SMTP relay acceptance (250 OK) is distinct from confirmed recipient inbox delivery (S3-INBOX-DELIVERY).',
    'When external credentials or COMMERCIAL_VERIFY_EXTERNAL=true are absent, live provider stages strictly report BLOCKED — never PASS.',
    'Manual browser & live external provider steps are documented in docs/MANUAL_EXTERNAL_VERIFICATION_CHECKLIST.md.',
  ];

  const simFailCount = simulatedEval.checks.filter((c) => c.status === 'FAIL').length;
  const simNotRunCount = simulatedEval.checks.filter((c) => c.status === 'NOT RUN').length;
  if (simNotRunCount > 0) {
    notes.push(
      `${simNotRunCount} simulated suite(s) reported NOT RUN because verifiable test results were missing at "${displayArtifactPath}". Run "npm run verify:simulated" first.`
    );
  }
  if (simFailCount > 0) {
    notes.push(
      `${simFailCount} simulated suite(s) reported FAIL in "${displayArtifactPath}". Inspect the failure details above before relying on simulated coverage.`
    );
  }

  return {
    generatedAt: nowIso,
    runId: createRunId(),
    targetEnvironment: process.env.STAGING_BASE_URL?.trim() || cfgCheck.environment,
    externalVerificationActivated: isExternalVerificationActivated(),
    overallExternalStatus,
    readiness,
    stages: [configStage, ...externalStages],
    simulatedChecks: simulatedEval.checks,
    simulatedArtifactPath: displayArtifactPath,
    simulatedArtifactRunId: simulatedEval.artifactRunId,
    cleanupPerformed:
      stage4.cleanupReport?.status === 'CLEANED' ||
      stage1.checks.some((c) => c.testId === 'S1-TEST-PRODUCT-LIFECYCLE' && c.status === 'PASS') ||
      stage2.checks.some((c) => c.testId === 'S2-STRIPE-CLEANUP' && c.status === 'PASS'),
    cleanupReport: stage4.cleanupReport,
    notes,
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const writeFiles = process.argv.includes('--write');

  const report = await buildCommercialVerificationReport();

  if (writeFiles) {
    const mdOut = path.resolve(process.cwd(), 'docs/COMMERCIAL_VERIFICATION_REPORT.md');
    await writeVerificationArtifacts(report, mdOut);
    console.log(`[verify:commercial:report] Wrote Markdown report to ${mdOut}`);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!writeFiles) {
    console.log(`Run ID: ${report.runId}`);
    console.log(`Overall External Status: ${report.overallExternalStatus}`);
    for (const s of report.stages) {
      console.log(
        `- [${s.status}] ${s.title} (pass=${s.counts.pass}, simulated=${s.counts.simulated ?? 0}, fail=${s.counts.fail}, blocked=${s.counts.blocked}, not_run=${s.counts.notRun})`
      );
    }
    if (report.simulatedChecks) {
      console.log(`Simulated Checks (artifact=${report.simulatedArtifactPath || 'none'}):`);
      for (const c of report.simulatedChecks) {
        console.log(`  - [${c.status}] ${c.testId}`);
      }
    }
  }

  const anySimFail = Boolean(report.simulatedChecks?.some((c) => c.status === 'FAIL'));
  const anySimNotRun = Boolean(report.simulatedChecks?.some((c) => c.status === 'NOT RUN'));
  if (report.overallExternalStatus === 'FAIL' || anySimFail) {
    process.exitCode = 1;
  } else if (strict && (report.overallExternalStatus === 'BLOCKED' || anySimNotRun)) {
    process.exitCode = 2;
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[verify:commercial:report] Fatal error:', err?.message || err);
    process.exitCode = 1;
  });
}
