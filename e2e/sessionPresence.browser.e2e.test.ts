import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { chromium, Browser } from 'playwright';
import {
  SESSION_COOKIE_NAME,
  SESSION_PRESENCE_COOKIE_NAME,
} from '../src/server/middleware/auth';

const require = createRequire(import.meta.url);

function resolveNodeExecutable(): string {
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase === 'node' || execBase === 'node.exe') {
    return process.execPath;
  }
  return 'node';
}

function resolveTsxLoaderUrl(): string {
  return pathToFileURL(require.resolve('tsx')).href;
}

function formatServerLogsTail(serverLogs: string[], maxLines: number = 40): string {
  const joined = serverLogs.join('').trim();
  if (!joined) return '(no server logs captured)';
  const lines = joined.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') return;
    }
  }
  try {
    proc.kill(signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ESRCH') throw err;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServerReady(
  baseUrl: string,
  proc: ChildProcess,
  serverLogs: string[],
  timeoutMs: number = 45_000
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    throw new Error(
      `AIXSHOP server exited before becoming ready (exitCode=${proc.exitCode}, signal=${proc.signalCode}).\nServer logs:\n${formatServerLogsTail(serverLogs)}`
    );
  }

  let settled = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      proc.off('error', onError);
      proc.off('exit', onEarlyExit);
    };

    const fail = (err: Error) => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    const onError = (err: Error) => {
      fail(
        new Error(
          `AIXSHOP server process failed to start: ${err.message}\nServer logs:\n${formatServerLogsTail(serverLogs)}`
        )
      );
    };

    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `AIXSHOP server exited before health check succeeded (exitCode=${code}, signal=${signal}).\nServer logs:\n${formatServerLogsTail(serverLogs)}`
        )
      );
    };

    proc.once('error', onError);
    proc.once('exit', onEarlyExit);

    timeoutTimer = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for AIXSHOP server at ${baseUrl} after ${timeoutMs}ms.\nServer logs:\n${formatServerLogsTail(serverLogs)}`
        )
      );
    }, timeoutMs);

    const poll = async () => {
      if (settled) return;
      try {
        const res = await fetch(`${baseUrl}/api/health/live`);
        if (res.ok) {
          if (!settled) {
            cleanup();
            resolve();
          }
          return;
        }
      } catch {
        // Server still booting
      }
      if (!settled) {
        pollTimer = setTimeout(() => {
          void poll();
        }, 250);
      }
    };

    void poll();
  });
}

describe('Session Presence Real Browser & Multi-Tab Sync (Playwright)', () => {
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  let baseUrl = '';
  const serverLogs: string[] = [];
  let onStdoutData: ((chunk: Buffer | string) => void) | null = null;
  let onStderrData: ((chunk: Buffer | string) => void) | null = null;

  async function stopServerProcess(
    gracefulTimeoutMs: number = 5_000,
    killTimeoutMs: number = 3_000
  ): Promise<void> {
    const proc = serverProc;
    serverProc = null;
    if (!proc) return;

    const detachStreams = (destroyIfOpen: boolean) => {
      if (onStdoutData && proc.stdout) {
        proc.stdout.off('data', onStdoutData);
      }
      if (onStderrData && proc.stderr) {
        proc.stderr.off('data', onStderrData);
      }
      onStdoutData = null;
      onStderrData = null;

      if (destroyIfOpen) {
        if (proc.stdout && !proc.stdout.destroyed) {
          proc.stdout.destroy();
        }
        if (proc.stderr && !proc.stderr.destroyed) {
          proc.stderr.destroy();
        }
      }
    };

    const waitForCloseOrTimeout = (timeoutMs: number): Promise<boolean> => {
      const streamsClosed =
        (!proc.stdout || proc.stdout.closed || proc.stdout.destroyed) &&
        (!proc.stderr || proc.stderr.closed || proc.stderr.destroyed);
      const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
      if (alreadyExited && streamsClosed) {
        return Promise.resolve(true);
      }

      return new Promise<boolean>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (closed: boolean) => {
          if (done) return;
          done = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          proc.off('close', onClose);
          proc.off('error', onError);
          resolve(closed);
        };

        const onClose = () => finish(true);
        const onError = () => finish(true);

        proc.once('close', onClose);
        proc.once('error', onError);

        timer = setTimeout(() => finish(false), timeoutMs);
      });
    };

    const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
    if (!alreadyExited) {
      signalProcessTree(proc, 'SIGTERM');
    }

    let closedCleanly = await waitForCloseOrTimeout(alreadyExited ? 1_000 : gracefulTimeoutMs);
    if (!closedCleanly) {
      signalProcessTree(proc, 'SIGKILL');
      closedCleanly = await waitForCloseOrTimeout(killTimeoutMs);
    }

    detachStreams(!closedCleanly);
  }

  async function cleanupResources(): Promise<void> {
    if (browser) {
      const activeBrowser = browser;
      browser = null;
      await activeBrowser.close().catch(() => {});
    }
    await stopServerProcess();
  }

  before(async () => {
    serverLogs.length = 0;
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const proc = spawn(resolveNodeExecutable(), ['--import', resolveTsxLoaderUrl(), 'server.ts'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'development',
        DISABLE_HMR: 'true',
        AIXSHOP_SILENCE_REQUEST_LOGS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;

    onStdoutData = (chunk: Buffer | string) => serverLogs.push(chunk.toString());
    onStderrData = (chunk: Buffer | string) => serverLogs.push(chunk.toString());
    proc.stdout?.on('data', onStdoutData);
    proc.stderr?.on('data', onStderrData);

    try {
      await waitForServerReady(baseUrl, proc, serverLogs, 45_000);
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      await cleanupResources();
      throw err;
    }
  });

  after(async () => {
    await cleanupResources();
  });

  test('1, 2, 11. Unauthenticated browser skips /api/auth/me cleanly, legacy cookie syncs, and multiple tabs stay in sync on login/logout', async () => {
    assert.ok(browser);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    const authMeRequestsTab1: number[] = [];
    const authMeRequestsTab2: number[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    for (const p of [tab1, tab2]) {
      p.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
      p.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
    }
    tab1.on('response', (res) => {
      if (res.url().includes('/api/auth/me')) authMeRequestsTab1.push(res.status());
    });
    tab2.on('response', (res) => {
      if (res.url().includes('/api/auth/me')) authMeRequestsTab2.push(res.status());
    });

    try {
      // Scenario 1: First visit without session -> sets aixshop_has_session=0, zero /api/auth/me calls, zero console errors
      await tab1.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await tab2.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

      const initialCookies = await context.cookies(baseUrl);
      assert.equal(initialCookies.find((c) => c.name === SESSION_PRESENCE_COOKIE_NAME)?.value, '0');
      assert.deepEqual(authMeRequestsTab1, []);
      assert.deepEqual(authMeRequestsTab2, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);

      // Scenario 11a: Register/Login in Tab 1 -> Tab 2 picks up session on focus without page reload
      const email = `multitab-${crypto.randomBytes(4).toString('hex')}@example.com`;
      await tab1.getByRole('button', { name: /Sign In/i }).click();
      await tab1.getByRole('button', { name: /Sign Up/i }).click();
      await tab1.getByPlaceholder('Jane Merchant').fill('TabUser Merchant');
      await tab1.getByPlaceholder('Solstice Mercantile').fill('TabStore Mercantile');
      await tab1.getByPlaceholder('merchant@example.com').fill(email);
      await tab1.getByPlaceholder('••••••••').fill('StrongPass!2026');
      await tab1.getByRole('button', { name: /Create Workspace Account/i }).click();
      await tab1.getByText(/Cloud DB Active/i).waitFor({ state: 'visible' });

      // Focus Tab 2 -> hydrates authenticated state via 200 /api/auth/me
      await tab2.evaluate(() => window.dispatchEvent(new Event('focus')));
      await tab2.getByText(/Cloud DB Active/i).waitFor({ state: 'visible' });
      assert.ok(authMeRequestsTab2.some((status) => status === 200));

      // Scenario 2: Delete ONLY aixshop_has_session (simulating pre-deployment user with HttpOnly cookie only)
      const cookiesWithSession = await context.cookies(baseUrl);
      const sessionCookie = cookiesWithSession.find((c) => c.name === SESSION_COOKIE_NAME);
      assert.ok(sessionCookie);
      await context.clearCookies();
      await context.addCookies([
        {
          name: sessionCookie.name,
          value: sessionCookie.value,
          domain: sessionCookie.domain,
          path: sessionCookie.path,
          httpOnly: sessionCookie.httpOnly,
          secure: sessionCookie.secure,
          sameSite: sessionCookie.sameSite,
        },
      ]);

      await tab2.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await tab2.getByText(/Cloud DB Active/i).waitFor({ state: 'visible' });
      const resyncedCookies = await context.cookies(baseUrl);
      assert.equal(resyncedCookies.find((c) => c.name === SESSION_PRESENCE_COOKIE_NAME)?.value, '1');

      // Scenario 11b: Logout in Tab 1 -> Tab 2 clears session on focus WITHOUT issuing a 401 /api/auth/me call
      const tab2MeCountBeforeLogout = authMeRequestsTab2.length;
      await tab1.getByRole('button', { name: /TabUser/i }).first().click();
      await tab1.getByRole('button', { name: /Sign Out/i }).click();
      await tab1.getByText(/Demo Mode · Enable Cloud/i).waitFor({ state: 'visible' });

      await tab2.evaluate(() => window.dispatchEvent(new Event('focus')));
      await tab2.getByText(/Demo Mode · Enable Cloud/i).waitFor({ state: 'visible' });
      assert.equal(
        authMeRequestsTab2.length,
        tab2MeCountBeforeLogout,
        'Tab 2 must not trigger 401 /api/auth/me after Tab 1 logout'
      );

      assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join(' | ')}`);
      assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });

  test('12 & 13 (Real Browser): Tampered aixshop_has_session=1 cannot authenticate and is reset to 0 by server', async () => {
    assert.ok(browser);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    const authMeStatuses: number[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    page.on('response', (res) => {
      if (res.url().includes('/api/auth/me')) {
        authMeStatuses.push(res.status());
      }
    });

    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.getByText(/Demo Mode · Enable Cloud/i).waitFor({ state: 'visible' });

      // Tamper marker in browser cookie jar without an HttpOnly aixshop_session cookie
      await context.addCookies([
        {
          name: SESSION_PRESENCE_COOKIE_NAME,
          value: '1',
          url: baseUrl,
          httpOnly: false,
          sameSite: 'Lax',
        },
      ]);

      // Server API endpoints strictly reject tampered marker=1 with HTTP 401 and reset marker to 0
      const meRes = await page.request.get(`${baseUrl}/api/auth/me`);
      assert.equal(meRes.status(), 401);
      const catalogRes = await page.request.get(`${baseUrl}/api/catalog`);
      assert.equal(catalogRes.status(), 401);

      const resetCookies = await context.cookies(baseUrl);
      assert.equal(resetCookies.find((c) => c.name === SESSION_PRESENCE_COOKIE_NAME)?.value, '0');

      // Re-tamper marker client-side via document.cookie and trigger tab focus sync
      await page.evaluate((cookieName) => {
        document.cookie = `${cookieName}=1; path=/`;
        window.dispatchEvent(new Event('focus'));
      }, SESSION_PRESENCE_COOKIE_NAME);

      await page.waitForFunction(
        (cookieName) => document.cookie.includes(`${cookieName}=0`),
        SESSION_PRESENCE_COOKIE_NAME
      );
      assert.ok(authMeStatuses.includes(401), 'Server must reject tampered client marker with 401');
      await page.getByText(/Demo Mode · Enable Cloud/i).waitFor({ state: 'visible' });
      assert.equal(await page.getByText(/Cloud DB Active/i).count(), 0);

      // Once healed to '0', subsequent navigation makes zero /api/auth/me requests and zero console errors
      const consoleErrorsAfterHeal: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrorsAfterHeal.push(msg.text());
      });
      const meCountBeforeReload = authMeStatuses.length;
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(authMeStatuses.length, meCountBeforeReload);
      assert.deepEqual(consoleErrorsAfterHeal, []);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
});
