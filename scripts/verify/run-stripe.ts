import 'dotenv/config';
import { runStripeExternalVerification } from '../../src/server/verification/stripeVerifier';
import { StageVerificationSummary } from '../../src/server/verification/statusModel';

function printSummary(summary: StageVerificationSummary): void {
  console.log(`\n=== ${summary.title} ===`);
  console.log(`Status: ${summary.status}`);
  console.log(
    `Counts: PASS=${summary.counts.pass} FAIL=${summary.counts.fail} BLOCKED=${summary.counts.blocked} NOT_RUN=${summary.counts.notRun}`
  );
  if (summary.missingEnvVars.length > 0) {
    console.log(`Missing Prerequisites: ${summary.missingEnvVars.join(', ')}`);
  }
  for (const c of summary.checks) {
    console.log(`- [${c.status}] ${c.testId}: ${c.name}`);
    if (c.blockerOrFailure) {
      console.log(`  Detail: ${c.blockerOrFailure}`);
    }
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const summary = await runStripeExternalVerification();

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  if (summary.status === 'FAIL') {
    process.exitCode = 1;
  } else if (strict && summary.status === 'BLOCKED') {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[verify:stripe] Fatal error:', err?.message || err);
  process.exitCode = 1;
});
