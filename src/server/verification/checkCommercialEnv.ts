import 'dotenv/config';
import {
  CommercialEnvReadinessReport,
  evaluateCommercialReadiness,
} from './statusModel';

export function formatCommercialReadinessText(report: CommercialEnvReadinessReport): string {
  const lines: string[] = [];
  lines.push('=== AIXSHOP v1.0 Commercial Integration Configuration Check ===');
  lines.push(`Checked At: ${report.checkedAt}`);
  lines.push(`Environment: ${report.environment}`);
  lines.push(`External Verification Opt-In (COMMERCIAL_VERIFY_EXTERNAL): ${report.externalVerificationActivated ? 'ENABLED' : 'DISABLED'}`);
  lines.push(`Local Dev Config Valid: ${report.localDevReady ? 'YES' : 'NO'}`);
  lines.push(`PostgreSQL Configured: ${report.ciPostgresReady ? 'YES' : 'NO'}`);
  lines.push('');

  for (const item of Object.values(report.integrations)) {
    const statusLabel =
      item.status === 'READY'
        ? 'READY'
        : `BLOCKED — missing/invalid: ${item.missingEnvVars.join(', ')}`;
    lines.push(`[${item.status}] ${item.label}`);
    lines.push(`  Status: ${statusLabel}`);
    for (const note of item.notes) {
      lines.push(`  Note: ${note}`);
    }
  }

  lines.push('');
  lines.push(`Overall Readiness Summary: ${report.summaryStatus}`);
  return lines.join('\n');
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('checkCommercialEnv');

if (isDirectExecution) {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const report = evaluateCommercialReadiness();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCommercialReadinessText(report));
  }

  if (strict && report.summaryStatus !== 'READY_FOR_ALL_STAGES') {
    process.exitCode = 1;
  }
}
