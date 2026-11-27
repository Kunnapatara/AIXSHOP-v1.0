import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
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
        const addr = server.address() as { port: number };
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
