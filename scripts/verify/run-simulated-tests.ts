import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createRunId,
  DEFAULT_SIMULATED_ARTIFACT_PATH,
  SIMULATED_SUITE_DEFINITIONS,
  SimulatedSuiteArtifactEntry,
  SimulatedTestResultsArtifact,
} from '../../src/server/verification/statusModel';

interface TapTotals {
  tests?: number;
  pass?: number;
  fail?: number;
  cancelled?: number;
  skipped?: number;
  todo?: number;
  durationMs?: number;
}

export function parseTapTotals(tapOutput: string): TapTotals {
  const totals: TapTotals = {};
  const lines = tapOutput.split(/\r?\n/);
  for (const line of lines) {
    // Only match top-level TAP summary comments (unindented)
    const m = /^#\s+(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9.]+)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = Number(m[2]);
    if (!Number.isFinite(val)) continue;
    if (key === 'tests') totals.tests = Math.trunc(val);
    else if (key === 'pass') totals.pass = Math.trunc(val);
    else if (key === 'fail') totals.fail = Math.trunc(val);
    else if (key === 'cancelled') totals.cancelled = Math.trunc(val);
    else if (key === 'skipped') totals.skipped = Math.trunc(val);
    else if (key === 'todo') totals.todo = Math.trunc(val);
    else if (key === 'duration_ms') totals.durationMs = val;
  }
  return totals;
}

function getCliArgValue(prefix: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : undefined;
}

function resolveTsxInvocation(suiteFile: string): { cmd: string; args: string[]; label: string } {
  const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  if (fs.existsSync(tsxCli)) {
    return {
      cmd: 'node',
      args: [tsxCli, '--test', '--test-reporter=tap', suiteFile],
      label: `node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap ${suiteFile}`,
    };
  }
  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  return {
    cmd: tsxBin,
    args: ['--test', '--test-reporter=tap', suiteFile],
    label: `tsx --test --test-reporter=tap ${suiteFile}`,
  };
}

function main() {
  const outArg =
    getCliArgValue('--out=') ||
    process.env.SIMULATED_TEST_ARTIFACT_PATH?.trim() ||
    DEFAULT_SIMULATED_ARTIFACT_PATH;
  const outPath = path.resolve(process.cwd(), outArg);
  const quiet = process.argv.includes('--quiet');

  const runId = createRunId('sim');
  const suites: SimulatedSuiteArtifactEntry[] = [];
  let anyFailed = false;

  for (const def of SIMULATED_SUITE_DEFINITIONS) {
    const absSuite = path.resolve(process.cwd(), def.suiteFile);
    const sha256 = fs.existsSync(absSuite)
      ? crypto.createHash('sha256').update(fs.readFileSync(absSuite)).digest('hex')
      : undefined;

    const invocation = resolveTsxInvocation(def.suiteFile);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const res = spawnSync(invocation.cmd, invocation.args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const wallDurationMs = Date.now() - t0;

    const exitCode = typeof res.status === 'number' ? res.status : 1;
    const tapText = `${res.stdout || ''}\n${res.stderr || ''}`;
    const totals = parseTapTotals(tapText);

    const passedCount = totals.pass ?? 0;
    const failedCount = (totals.fail ?? 0) + (totals.cancelled ?? 0);
    const skippedCount = (totals.skipped ?? 0) + (totals.todo ?? 0);
    const totalCount = totals.tests ?? passedCount + failedCount + skippedCount;
    const durationMs =
      typeof totals.durationMs === 'number' && Number.isFinite(totals.durationMs)
        ? Math.round(totals.durationMs)
        : wallDurationMs;

    const ok =
      !res.error &&
      exitCode === 0 &&
      failedCount === 0 &&
      totalCount > 0 &&
      passedCount > 0 &&
      passedCount + skippedCount === totalCount;

    if (!ok) {
      anyFailed = true;
    }

    suites.push({
      suiteFile: def.suiteFile,
      suiteId: def.testId,
      executedAt: startedAt,
      durationMs,
      exitCode,
      passedCount,
      failedCount,
      skippedCount,
      totalCount,
      status: ok ? 'PASS' : 'FAIL',
      command: invocation.label,
      ...(sha256 ? { sha256 } : {}),
    });

    if (!quiet) {
      console.log(
        `[test:simulated:artifact] ${ok ? 'PASS' : 'FAIL'} ${def.testId} (${def.suiteFile}): passed=${passedCount}, failed=${failedCount}, skipped=${skippedCount}, total=${totalCount}, exitCode=${exitCode}, durationMs=${durationMs}`
      );
      if (!ok && res.stderr) {
        console.error(res.stderr.trim());
      }
    }
  }

  const artifact: SimulatedTestResultsArtifact = {
    schemaVersion: '1.0',
    runId,
    generatedAt: new Date().toISOString(),
    runner: 'tsx --test --test-reporter=tap',
    nodeVersion: process.version,
    suites,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

  if (!quiet) {
    console.log(`[test:simulated:artifact] Wrote ${outPath} (runId=${runId})`);
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.includes('run-simulated-tests')) {
  main();
}
