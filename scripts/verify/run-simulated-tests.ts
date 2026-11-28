import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createRunId,
  DEFAULT_SIMULATED_ARTIFACT_PATH,
  MIN_SIMULATED_HMAC_KEY_LENGTH,
  signSimulatedTestArtifact,
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

function resolveTsxInvocation(
  suiteFile: string,
  repoRoot = process.cwd()
): { cmd: string; args: string[]; label: string } {
  const tsxCli = path.resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  if (fs.existsSync(tsxCli)) {
    return {
      cmd: 'node',
      args: [tsxCli, '--test', '--test-reporter=tap', suiteFile],
      label: `node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap ${suiteFile}`,
    };
  }
  const localTsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  if (fs.existsSync(localTsxCli)) {
    return {
      cmd: 'node',
      args: [localTsxCli, '--test', '--test-reporter=tap', suiteFile],
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

export interface SuiteExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface RunSimulatedTestsOptions {
  repoRoot?: string;
  outPath?: string;
  hmacKey?: string;
  quiet?: boolean;
  executeSuite?: (suite: (typeof SIMULATED_SUITE_DEFINITIONS)[number], absSuitePath: string) => SuiteExecutionResult;
}

export function runSimulatedTestsAndSign(options: RunSimulatedTestsOptions = {}): {
  artifact: SimulatedTestResultsArtifact;
  outPath: string;
  anyFailed: boolean;
} {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const outArg =
    options.outPath ||
    getCliArgValue('--out=') ||
    process.env.SIMULATED_TEST_ARTIFACT_PATH?.trim() ||
    DEFAULT_SIMULATED_ARTIFACT_PATH;
  const outPath = path.resolve(repoRoot, outArg);
  const quiet = options.quiet ?? process.argv.includes('--quiet');

  const hmacKey = (
    options.hmacKey !== undefined ? options.hmacKey : process.env.SIMULATED_ARTIFACT_HMAC_KEY || ''
  ).trim();
  if (!hmacKey || hmacKey.length < MIN_SIMULATED_HMAC_KEY_LENGTH) {
    throw new Error(
      'Missing or invalid SIMULATED_ARTIFACT_HMAC_KEY. Run via "npm run verify:simulated" (or provide an ephemeral >=32-char key from the orchestrator).'
    );
  }

  const runId = createRunId('sim');
  const suites: SimulatedSuiteArtifactEntry[] = [];
  let anyFailed = false;

  for (const def of SIMULATED_SUITE_DEFINITIONS) {
    const absSuite = path.resolve(repoRoot, def.suiteFile);
    if (!absSuite.startsWith(repoRoot + path.sep) || !fs.existsSync(absSuite)) {
      throw new Error(`Required simulated suite file missing on disk: ${def.suiteFile}`);
    }

    const sha256Before = crypto.createHash('sha256').update(fs.readFileSync(absSuite)).digest('hex');

    const invocation = resolveTsxInvocation(def.suiteFile, repoRoot);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let execRes: SuiteExecutionResult;
    if (options.executeSuite) {
      execRes = options.executeSuite(def, absSuite);
    } else {
      const res = spawnSync(invocation.cmd, invocation.args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      execRes = {
        exitCode: typeof res.status === 'number' ? res.status : 1,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: res.error,
      };
    }
    const wallDurationMs = Date.now() - t0;

    // Immediately re-hash the suite source file after execution to detect mid-run tampering
    const fileStillExists = fs.existsSync(absSuite);
    const sha256After = fileStillExists
      ? crypto.createHash('sha256').update(fs.readFileSync(absSuite)).digest('hex')
      : '';
    const sourceChangedDuringRun = !fileStillExists || sha256Before !== sha256After;

    const tapText = `${execRes.stdout || ''}\n${execRes.stderr || ''}`;
    const outputSha256 = crypto.createHash('sha256').update(Buffer.from(tapText, 'utf8')).digest('hex');
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
      !sourceChangedDuringRun &&
      !execRes.error &&
      execRes.exitCode === 0 &&
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
      exitCode: execRes.exitCode,
      passedCount,
      failedCount,
      skippedCount,
      totalCount,
      status: ok ? 'PASS' : 'FAIL',
      command: invocation.label,
      sha256: sha256After || sha256Before,
      outputSha256,
      ...(sourceChangedDuringRun ? { sourceChangedDuringRun: true } : {}),
    });

    if (!quiet) {
      console.log(
        `[test:simulated:artifact] ${ok ? 'PASS' : 'FAIL'} ${def.testId} (${def.suiteFile}): passed=${passedCount}, failed=${failedCount}, skipped=${skippedCount}, total=${totalCount}, exitCode=${execRes.exitCode}, durationMs=${durationMs}${sourceChangedDuringRun ? ' [SOURCE_CHANGED_DURING_RUN]' : ''}`
      );
      if (sourceChangedDuringRun) {
        console.error(
          `[test:simulated:artifact] Suite source "${def.suiteFile}" changed during the run (before=${sha256Before}, after=${sha256After || 'missing'}).`
        );
      }
      if (!ok && execRes.stderr) {
        console.error(execRes.stderr.trim());
      }
    }
  }

  const unsignedArtifact: SimulatedTestResultsArtifact = {
    schemaVersion: '1.0',
    runId,
    generatedAt: new Date().toISOString(),
    runner: 'tsx --test --test-reporter=tap',
    nodeVersion: process.version,
    suites,
  };

  const signedArtifact = signSimulatedTestArtifact(unsignedArtifact, hmacKey);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(signedArtifact, null, 2), 'utf8');

  if (!quiet) {
    console.log(`[test:simulated:artifact] Wrote ${outPath} (runId=${runId}, signed=true)`);
  }

  return { artifact: signedArtifact, outPath, anyFailed };
}

function main() {
  const { anyFailed } = runSimulatedTestsAndSign();
  if (anyFailed) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.includes('run-simulated-tests')) {
  main();
}
