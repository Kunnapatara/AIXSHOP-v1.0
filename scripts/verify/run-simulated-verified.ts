import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CommercialVerificationReport } from '../../src/server/verification/statusModel';

function getCliArgValue(prefix: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : undefined;
}

function resolveTsxCliArgs(scriptRelPath: string, extraArgs: string[] = []): { cmd: string; args: string[] } {
  const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  if (fs.existsSync(tsxCli)) {
    return { cmd: 'node', args: [tsxCli, scriptRelPath, ...extraArgs] };
  }
  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  return { cmd: tsxBin, args: [scriptRelPath, ...extraArgs] };
}

function main() {
  const jsonOutArg = getCliArgValue('--json-out=');
  const skipMarkdown = process.argv.includes('--skip-markdown');
  const strict = process.argv.includes('--strict');
  const outArtifact = getCliArgValue('--out=');

  // Generate a fresh 256-bit ephemeral per-run signing key strictly in memory
  let ephemeralKey = crypto.randomBytes(32).toString('hex');

  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SIMULATED_ARTIFACT_HMAC_KEY: ephemeralKey,
    };

    // 1. Run simulated test suites & emit HMAC-signed artifact
    const runnerArgs = outArtifact ? [`--out=${outArtifact}`] : [];
    const runnerCmd = resolveTsxCliArgs('scripts/verify/run-simulated-tests.ts', runnerArgs);
    const runRes = spawnSync(runnerCmd.cmd, runnerCmd.args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
    });
    if (runRes.error) {
      throw runRes.error;
    }
    if ((runRes.status ?? 1) !== 0) {
      process.exitCode = runRes.status ?? 1;
      return;
    }

    // 2. Evaluate signed artifact using the SAME ephemeral key & generate report
    const reportArgs: string[] = ['--json'];
    if (!skipMarkdown) {
      reportArgs.push('--write');
    }
    if (strict) {
      reportArgs.push('--strict');
    }
    if (outArtifact) {
      reportArgs.push(`--simulated-artifact=${outArtifact}`);
    }

    const reportCmd = resolveTsxCliArgs('scripts/verify/generate-report.ts', reportArgs);
    const reportRes = spawnSync(reportCmd.cmd, reportCmd.args, {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (reportRes.error) {
      throw reportRes.error;
    }
    if (reportRes.stderr) {
      process.stderr.write(reportRes.stderr);
    }

    const rawStdout = reportRes.stdout || '';
    const jsonStart = rawStdout.indexOf('{');
    if (jsonStart === -1) {
      throw new Error('generate-report.ts did not emit JSON output.');
    }
    const jsonText = rawStdout.slice(jsonStart);
    const report = JSON.parse(jsonText) as CommercialVerificationReport;

    // 3. Assert simulated integrity checks passed with verified HMAC & SHA-256
    if (!report.simulatedArtifactRunId) {
      throw new Error('Commercial report is missing simulatedArtifactRunId.');
    }
    if (!Array.isArray(report.simulatedChecks) || report.simulatedChecks.length !== 4) {
      throw new Error('Commercial report must contain exactly 4 simulated checks.');
    }
    for (const chk of report.simulatedChecks) {
      if (chk.status !== 'PASS — SIMULATED') {
        throw new Error(
          `Simulated check ${chk.testId} reported ${chk.status}: ${chk.blockerOrFailure || 'unknown error'}`
        );
      }
      if (chk.evidence?.hmacVerified !== true) {
        throw new Error(`Simulated check ${chk.testId} failed HMAC verification flag.`);
      }
      if (chk.evidence?.sha256Verified !== true || !/^[0-9a-f]{64}$/.test(String(chk.evidence?.sha256 || ''))) {
        throw new Error(`Simulated check ${chk.testId} missing verified source SHA-256.`);
      }
      if (!/^[0-9a-f]{64}$/.test(String(chk.evidence?.outputSha256 || ''))) {
        throw new Error(`Simulated check ${chk.testId} missing captured output SHA-256 digest.`);
      }
    }

    if (jsonOutArg) {
      const resolvedJsonOut = path.resolve(process.cwd(), jsonOutArg);
      fs.mkdirSync(path.dirname(resolvedJsonOut), { recursive: true });
      fs.writeFileSync(resolvedJsonOut, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[verify:simulated] Wrote JSON commercial report to ${resolvedJsonOut}`);
    }

    console.log(
      `[verify:simulated] Verified 4/4 simulated suites (PASS — SIMULATED, hmacVerified=true, sha256Verified=true, artifactRunId=${report.simulatedArtifactRunId}). External status=${report.overallExternalStatus}.`
    );

    if ((reportRes.status ?? 0) !== 0) {
      process.exitCode = reportRes.status ?? 1;
    }
  } finally {
    // Discard ephemeral key material cleanly
    ephemeralKey = '';
    delete process.env.SIMULATED_ARTIFACT_HMAC_KEY;
  }
}

main();
