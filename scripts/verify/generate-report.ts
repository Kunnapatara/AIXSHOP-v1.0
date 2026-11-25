import 'dotenv/config';
import path from 'node:path';
import {
  CommercialVerificationReport,
  computeOverallStatus,
  createRunId,
  evaluateCommercialReadiness,
  isExternalVerificationActivated,
  summarizeStage,
  writeVerificationArtifacts,
} from '../../src/server/verification/statusModel';
import { runShopifyExternalVerification } from '../../src/server/verification/shopifyVerifier';
import { runStripeExternalVerification } from '../../src/server/verification/stripeVerifier';
import { runSmtpExternalVerification } from '../../src/server/verification/smtpVerifier';
import { runStagingE2EVerification } from '../../src/server/verification/stagingE2EVerifier';
import { runSecretSafeConfigCheck } from '../../src/server/config/checkConfig';

async function main() {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const writeFiles = process.argv.includes('--write');

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

  const report: CommercialVerificationReport = {
    generatedAt: nowIso,
    runId: createRunId(),
    targetEnvironment: process.env.STAGING_BASE_URL?.trim() || cfgCheck.environment,
    externalVerificationActivated: isExternalVerificationActivated(),
    overallExternalStatus,
    readiness,
    stages: [configStage, ...externalStages],
    cleanupPerformed: isExternalVerificationActivated(),
    notes: [
      'Unit and contract tests using mocks/fixtures verify internal correctness only and never count as external provider verification.',
      'SMTP relay acceptance (250 OK) is distinct from confirmed recipient inbox delivery.',
      'When external credentials or COMMERCIAL_VERIFY_EXTERNAL=true are absent, stages report BLOCKED — never PASS.',
    ],
  };

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
        `- [${s.status}] ${s.title} (pass=${s.counts.pass}, fail=${s.counts.fail}, blocked=${s.counts.blocked}, not_run=${s.counts.notRun})`
      );
    }
  }

  if (overallExternalStatus === 'FAIL') {
    process.exitCode = 1;
  } else if (strict && overallExternalStatus === 'BLOCKED') {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[verify:commercial:report] Fatal error:', err?.message || err);
  process.exitCode = 1;
});
