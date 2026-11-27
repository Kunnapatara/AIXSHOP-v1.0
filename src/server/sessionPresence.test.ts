import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { chromium, Browser } from 'playwright';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import {
  _resetRateLimiter,
  createSessionPresenceHtmlMiddleware,
  SESSION_COOKIE_NAME,
  SESSION_PRESENCE_COOKIE_NAME,
} from './middleware/auth';
import { generateSessionToken, hashSessionToken } from './security/tokens';
import { readSessionPresenceMarker } from '../context/AuthContext';

const require = createRequire(import.meta.url);

function getSetCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function parseSetCookieMap(res: Response): Record<string, { value: string; raw: string }> {
  const map: Record<string, { value: string; raw: string }> = {};
  for (const raw of getSetCookies(res)) {
    const firstSemi = raw.indexOf(';');
    const nv = (firstSemi >= 0 ? raw.slice(0, firstSemi) : raw).trim();
    const eq = nv.indexOf('=');
    if (eq > 0) {
      const name = nv.slice(0, eq).trim();
      const value = nv.slice(eq + 1).trim();
      map[name] = { value, raw };
    }
  }
  return map;
}

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

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return;
    }
  }
  try {
    proc.kill(signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
  }
}

async function waitForServerReady(baseUrl: string, proc: ChildProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Server exited early (exitCode=${proc.exitCode}, signal=${proc.signalCode})`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health/live`);
      if (res.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

describe('Session Presence Marker (aixshop_has_session) Unit & HTTP Integration Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  before(async () => {
    repo = new MemoryRepository(false);
    const app = createApp(repo);
    app.use(createSessionPresenceHtmlMiddleware(repo));
    app.get('*', (_req, res) => {
      res.status(200).type('text/html; charset=utf-8').send('<!doctype html><html><body>AIXSHOP</body></html>');
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    _resetRateLimiter();
  });

  test('Client helper readSessionPresenceMarker parses marker states safely', () => {
    assert.equal(readSessionPresenceMarker(''), 'missing');
    assert.equal(readSessionPresenceMarker('other=123'), 'missing');
    assert.equal(readSessionPresenceMarker('aixshop_has_session=0'), '0');
    assert.equal(readSessionPresenceMarker('foo=bar; aixshop_has_session=1; baz=qux'), '1');
    assert.equal(readSessionPresenceMarker('aixshop_has_session=tampered_value'), 'missing');
    assert.equal(readSessionPresenceMarker('aixshop_has_session=true'), 'missing');
  });

  test('1. First visit without session initializes aixshop_has_session=0 on HTML document and preserves 401 on /api/auth/me', async () => {
    const htmlRes = await fetch(`${baseUrl}/`, {
      headers: { Accept: 'text/html' },
    });
    assert.equal(htmlRes.status, 200);
    const cookies = parseSetCookieMap(htmlRes);
    assert.equal(cookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(cookies[SESSION_COOKIE_NAME], undefined);
    assert.ok(!/HttpOnly/i.test(cookies[SESSION_PRESENCE_COOKIE_NAME].raw));
    assert.ok(/Path=\//i.test(cookies[SESSION_PRESENCE_COOKIE_NAME].raw));
    assert.ok(/SameSite=Lax/i.test(cookies[SESSION_PRESENCE_COOKIE_NAME].raw));

    // Direct /api/auth/me contract remains strict HTTP 401
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_PRESENCE_COOKIE_NAME}=0` },
    });
    assert.equal(meRes.status, 401);
  });

  test('2. Pre-existing valid HttpOnly aixshop_session without marker syncs aixshop_has_session=1 on HTML load and /api/auth/me', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: `legacy-${crypto.randomBytes(4).toString('hex')}@example.com`,
        password: 'StrongPassword!123',
        fullName: 'Legacy Session User',
        workspaceName: 'Legacy Workspace',
      }),
    });
    assert.equal(regRes.status, 201);
    const regCookies = parseSetCookieMap(regRes);
    const sessionToken = regCookies[SESSION_COOKIE_NAME]?.value;
    assert.ok(sessionToken);

    // Simulate pre-deployment user visiting HTML with ONLY aixshop_session (no aixshop_has_session)
    const htmlRes = await fetch(`${baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      },
    });
    assert.equal(htmlRes.status, 200);
    const htmlCookies = parseSetCookieMap(htmlRes);
    assert.equal(htmlCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '1');

    // Simulate direct /api/auth/me call with ONLY aixshop_session (no aixshop_has_session)
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      },
    });
    assert.equal(meRes.status, 200);
    const meCookies = parseSetCookieMap(meRes);
    assert.equal(meCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '1');
  });

  test('3 & 4 & 5. Registration, Login, and Logout keep aixshop_has_session synchronized with HttpOnly cookie', async () => {
    const email = `flow-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const password = 'StrongPassword!123';

    // 4. Register sets both cookies
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password,
        fullName: 'Flow User',
        workspaceName: 'Flow Store',
      }),
    });
    assert.equal(regRes.status, 201);
    const regCookies = parseSetCookieMap(regRes);
    const regToken = regCookies[SESSION_COOKIE_NAME]?.value;
    assert.ok(regToken);
    assert.equal(regCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '1');

    // 5. Logout clears aixshop_session and sets aixshop_has_session=0
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `${SESSION_COOKIE_NAME}=${regToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(logoutRes.status, 200);
    const logoutCookies = parseSetCookieMap(logoutRes);
    assert.equal(logoutCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(logoutCookies[SESSION_COOKIE_NAME]?.value, '');

    // Verify revoked session returns 401
    const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${regToken}` },
    });
    assert.equal(meAfterLogout.status, 401);

    // 3. Login sets new session cookie and aixshop_has_session=1
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(loginRes.status, 200);
    const loginCookies = parseSetCookieMap(loginRes);
    const loginToken = loginCookies[SESSION_COOKIE_NAME]?.value;
    assert.ok(loginToken);
    assert.notEqual(loginToken, regToken);
    assert.equal(loginCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '1');
  });

  test('6. Logout All revokes all sessions across devices and clears marker to 0', async () => {
    const email = `logout-all-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const password = 'StrongPassword!123';

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password,
        fullName: 'Multi Device User',
        workspaceName: 'Multi Device Store',
      }),
    });
    assert.equal(regRes.status, 201);
    const tokenDeviceA = parseSetCookieMap(regRes)[SESSION_COOKIE_NAME]?.value;
    assert.ok(tokenDeviceA);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(loginRes.status, 200);
    const tokenDeviceB = parseSetCookieMap(loginRes)[SESSION_COOKIE_NAME]?.value;
    assert.ok(tokenDeviceB);

    // Device B calls logout-all
    const logoutAllRes = await fetch(`${baseUrl}/api/auth/logout-all`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `${SESSION_COOKIE_NAME}=${tokenDeviceB}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(logoutAllRes.status, 200);
    const logoutAllCookies = parseSetCookieMap(logoutAllRes);
    assert.equal(logoutAllCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(logoutAllCookies[SESSION_COOKIE_NAME]?.value, '');

    // Device A visiting HTML with stale cookie sees marker reset to 0 and cookie cleared
    const htmlDeviceA = await fetch(`${baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: `${SESSION_COOKIE_NAME}=${tokenDeviceA}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(htmlDeviceA.status, 200);
    const deviceACookies = parseSetCookieMap(htmlDeviceA);
    assert.equal(deviceACookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(deviceACookies[SESSION_COOKIE_NAME]?.value, '');
  });

  test('7. Password reset revokes all sessions and sets aixshop_has_session=0', async () => {
    const email = `reset-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'OldPassword!123',
        fullName: 'Reset User',
        workspaceName: 'Reset Store',
      }),
    });
    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();
    const sessionToken = parseSetCookieMap(regRes)[SESSION_COOKIE_NAME]?.value;
    assert.ok(sessionToken);

    const rawResetToken = generateSessionToken();
    await repo.createPasswordResetToken({
      id: `pwr_test_${crypto.randomBytes(4).toString('hex')}`,
      userId: regBody.user.id,
      tokenHash: hashSessionToken(rawResetToken),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
      body: JSON.stringify({
        token: rawResetToken,
        newPassword: 'NewStrongPassword!456',
      }),
    });
    assert.equal(resetRes.status, 200);
    const resetCookies = parseSetCookieMap(resetRes);
    assert.equal(resetCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(resetCookies[SESSION_COOKIE_NAME]?.value, '');

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(meRes.status, 401);
  });

  test('8. Expired session returns 401 SESSION_EXPIRED and clears aixshop_has_session to 0', async () => {
    const email = `expired-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'StrongPassword!123',
        fullName: 'Expired User',
        workspaceName: 'Expired Store',
      }),
    });
    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();

    const expiredRawToken = generateSessionToken();
    await repo.createSession({
      id: `sess_expired_${crypto.randomBytes(4).toString('hex')}`,
      sessionTokenHash: hashSessionToken(expiredRawToken),
      userId: regBody.user.id,
      activeWorkspaceId: regBody.workspace.id,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // API /me check returns 401 and resets marker to 0
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${expiredRawToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(meRes.status, 401);
    const meBody = await meRes.json();
    assert.equal(meBody.code, 'SESSION_EXPIRED');
    const meCookies = parseSetCookieMap(meRes);
    assert.equal(meCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(meCookies[SESSION_COOKIE_NAME]?.value, '');

    // HTML load with expired cookie also resets marker to 0
    const htmlRes = await fetch(`${baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: `${SESSION_COOKIE_NAME}=${expiredRawToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(htmlRes.status, 200);
    const htmlCookies = parseSetCookieMap(htmlRes);
    assert.equal(htmlCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(htmlCookies[SESSION_COOKIE_NAME]?.value, '');
  });

  test('9. Server-side session revocation resets marker to 0 on next HTML or /api/auth/me check', async () => {
    const email = `revoked-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'StrongPassword!123',
        fullName: 'Revoked User',
        workspaceName: 'Revoked Store',
      }),
    });
    assert.equal(regRes.status, 201);
    const token = parseSetCookieMap(regRes)[SESSION_COOKIE_NAME]?.value;
    assert.ok(token);

    // Server revokes session directly
    await repo.deleteSession(hashSessionToken(token));

    const htmlRes = await fetch(`${baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: `${SESSION_COOKIE_NAME}=${token}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
    });
    assert.equal(htmlRes.status, 200);
    const htmlCookies = parseSetCookieMap(htmlRes);
    assert.equal(htmlCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
    assert.equal(htmlCookies[SESSION_COOKIE_NAME]?.value, '');

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}; ${SESSION_PRESENCE_COOKIE_NAME}=1` },
    });
    assert.equal(meRes.status, 401);
    assert.equal(parseSetCookieMap(meRes)[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
  });

  test('10. Workspace switching rotates session token and preserves aixshop_has_session=1', async () => {
    const email = `switch-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email,
        password: 'StrongPassword!123',
        fullName: 'Switcher User',
        workspaceName: 'Primary Workspace',
      }),
    });
    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();
    const oldToken = parseSetCookieMap(regRes)[SESSION_COOKIE_NAME]?.value;
    assert.ok(oldToken);

    const secondWsId = `ws_second_${crypto.randomBytes(4).toString('hex')}`;
    await repo.createWorkspace(
      {
        id: secondWsId,
        name: 'Secondary Workspace',
        slug: `secondary-${crypto.randomBytes(3).toString('hex')}`,
      },
      regBody.user.id
    );

    const switchRes = await fetch(`${baseUrl}/api/auth/switch-workspace`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `${SESSION_COOKIE_NAME}=${oldToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1`,
      },
      body: JSON.stringify({ workspaceId: secondWsId }),
    });
    assert.equal(switchRes.status, 200);
    const switchCookies = parseSetCookieMap(switchRes);
    const newToken = switchCookies[SESSION_COOKIE_NAME]?.value;
    assert.ok(newToken);
    assert.notEqual(newToken, oldToken);
    assert.equal(switchCookies[SESSION_PRESENCE_COOKIE_NAME]?.value, '1');

    // Old token rejected with 401
    const oldMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${oldToken}` },
    });
    assert.equal(oldMe.status, 401);

    // New token returns switched workspace
    const newMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${newToken}; ${SESSION_PRESENCE_COOKIE_NAME}=1` },
    });
    assert.equal(newMe.status, 200);
    const newMeData = await newMe.json();
    assert.equal(newMeData.workspace.id, secondWsId);
  });

  test('12 & 13. Tampered aixshop_has_session=1 cannot authorize /api/auth/me or /api/catalog and is reset to 0', async () => {
    // /api/auth/me rejects forged marker=1 with 401 and resets marker to 0
    const meTampered = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `${SESSION_PRESENCE_COOKIE_NAME}=1` },
    });
    assert.equal(meTampered.status, 401);
    assert.equal(parseSetCookieMap(meTampered)[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');

    // Protected route /api/catalog strictly rejects tampered marker=1 with 401
    const catalogTampered = await fetch(`${baseUrl}/api/catalog`, {
      headers: { Cookie: `${SESSION_PRESENCE_COOKIE_NAME}=1` },
    });
    assert.equal(catalogTampered.status, 401);
    assert.equal(parseSetCookieMap(catalogTampered)[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');

    // HTML visit with tampered marker=1 without HttpOnly cookie resets marker to 0
    const htmlTampered = await fetch(`${baseUrl}/`, {
      headers: { Accept: 'text/html', Cookie: `${SESSION_PRESENCE_COOKIE_NAME}=1` },
    });
    assert.equal(htmlTampered.status, 200);
    assert.equal(parseSetCookieMap(htmlTampered)[SESSION_PRESENCE_COOKIE_NAME]?.value, '0');
  });
});

describe('Session Presence Real Browser & Multi-Tab Sync (Playwright)', () => {
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  let baseUrl = '';

  before(async () => {
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
    await waitForServerReady(baseUrl, proc, 45_000);
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) {
      const b = browser;
      browser = null;
      await b.close().catch(() => {});
    }
    if (serverProc) {
      const proc = serverProc;
      serverProc = null;
      if (proc.exitCode === null && proc.signalCode === null) {
        signalProcessTree(proc, 'SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            signalProcessTree(proc, 'SIGKILL');
            resolve();
          }, 4000);
          proc.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    }
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
      assert.equal(authMeRequestsTab2.length, tab2MeCountBeforeLogout, 'Tab 2 must not trigger 401 /api/auth/me after Tab 1 logout');

      assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join(' | ')}`);
      assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
});
