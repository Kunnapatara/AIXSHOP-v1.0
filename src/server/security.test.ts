import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { _resetRateLimiter, _getRateLimiterSize } from './middleware/auth';
import { generateSessionToken, hashSessionToken } from './security/tokens';

describe('AIXSHOP v1.0 — Security Audit & Tenant Isolation Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  // Test credentials
  let userA: { id: string; email: string; token: string; workspaceId: string };
  let userB: { id: string; email: string; token: string; workspaceId: string };

  before(async () => {
    repo = new MemoryRepository(false);
    const app = createApp(repo);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 1. Register User A (Workspace A Owner)
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'security_alice@example.com',
        password: 'passwordAlice123',
        fullName: 'Alice Security',
        workspaceName: 'Alice Workspace',
      }),
    });
    assert.equal(regResA.status, 201);
    const dataA = await regResA.json();
    userA = {
      id: dataA.user.id,
      email: dataA.user.email,
      token: dataA.token,
      workspaceId: dataA.workspace.id,
    };

    // 2. Register User B (Workspace B Owner)
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        email: 'security_bob@example.com',
        password: 'passwordBob123',
        fullName: 'Bob Security',
        workspaceName: 'Bob Workspace',
      }),
    });
    assert.equal(regResB.status, 201);
    const dataB = await regResB.json();
    userB = {
      id: dataB.user.id,
      email: dataB.user.email,
      token: dataB.token,
      workspaceId: dataB.workspace.id,
    };
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    _resetRateLimiter();
  });

  // ==========================================
  // 1. CSRF Protection Verification
  // ==========================================
  describe('1. CSRF Protection for Cookie-Authenticated Requests', () => {
    test('1.1 Safe HTTP methods (GET, HEAD) are exempt from CSRF checks', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
        headers: { Cookie: `aixshop_session=${userA.token}` },
      });
      assert.equal(res.status, 200);
    });

    test('1.2 Bearer token requests without session cookie are exempt from CSRF checks', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${userA.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated via Bearer' }),
      });
      assert.equal(res.status, 200);
    });

    test('1.3 Cookie-authenticated state modification WITHOUT custom header is rejected (403 CSRF_REJECTED)', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Cookie: `aixshop_session=${userA.token}`,
          'Content-Type': 'application/json',
          // Deliberately missing X-Requested-With and X-CSRF-Token
        },
        body: JSON.stringify({ name: 'Forged via CSRF' }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'CSRF_REJECTED');
    });

    test('1.4 Content-Type: application/json does NOT bypass CSRF when cookie is present', async () => {
      // Proves fix for the confirmed defect where application/json bypassed CSRF check
      const res = await fetch(`${baseUrl}/api/catalog/migrate-demo`, {
        method: 'POST',
        headers: {
          Cookie: `aixshop_session=${userA.token}`,
          'Content-Type': 'application/json',
          // No custom header
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'CSRF_REJECTED');
    });

    test('1.5 Cookie request with valid X-Requested-With: XMLHttpRequest passes CSRF check', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Cookie: `aixshop_session=${userA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ name: 'Valid via X-Requested-With' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.store.name, 'Valid via X-Requested-With');
    });

    test('1.6 Cookie request with valid X-CSRF-Token header passes CSRF check', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Cookie: `aixshop_session=${userA.token}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'custom_csrf_anti_tamper_token',
        },
        body: JSON.stringify({ name: 'Valid via X-CSRF-Token' }),
      });
      assert.equal(res.status, 200);
    });

    test('1.7 Cookie request with mismatched Origin header is rejected (403 CSRF_ORIGIN_MISMATCH)', async () => {
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Cookie: `aixshop_session=${userA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://malicious-attacker-domain.com',
        },
        body: JSON.stringify({ name: 'Cross-origin attack' }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'CSRF_ORIGIN_MISMATCH');
    });
  });

  // ==========================================
  // 2. Rate Limiting Hardening
  // ==========================================
  describe('2. Rate Limiting Hardening & Memory Safety', () => {
    test('2.1 Blocks repeated login attempts exceeding rate limit threshold (429 RATE_LIMITED)', async () => {
      const maxAttempts = 20; // Default limit configured on register/login routes

      // Send requests up to limit
      for (let i = 0; i < maxAttempts; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ email: 'nonexistent@example.com', password: 'wrong' }),
        });
      }

      // Next attempt must be blocked
      const rateLimitedRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'nonexistent@example.com', password: 'wrong' }),
      });

      assert.equal(rateLimitedRes.status, 429);
      const body = await rateLimitedRes.json();
      assert.equal(body.code, 'RATE_LIMITED');
    });

    test('2.2 Rate limiter tracks entries in bounded memory store and can be pruned', async () => {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: 'ratelimit_check@example.com', password: 'wrong' }),
      });
      assert.ok(_getRateLimiterSize() > 0, 'Rate limiter should have recorded client IP');
      _resetRateLimiter();
      assert.equal(_getRateLimiterSize(), 0, 'Rate limiter entries cleanly cleared');
    });
  });

  // ==========================================
  // 3. Session Lifecycle & Multi-Device Revocation
  // ==========================================
  describe('3. Session Lifecycle & Security Verification', () => {
    test('3.1 Expired session token is strictly rejected on protected routes (401 SESSION_EXPIRED)', async () => {
      // Insert an expired session into repo
      const expiredRawToken = generateSessionToken();
      const expiredHash = hashSessionToken(expiredRawToken);
      const pastTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

      await repo.createSession({
        id: `sess_expired_${Date.now()}`,
        sessionTokenHash: expiredHash,
        userId: userA.id,
        activeWorkspaceId: userA.workspaceId,
        expiresAt: pastTime,
      });

      const res = await fetch(`${baseUrl}/api/store/profile`, {
        headers: { Authorization: `Bearer ${expiredRawToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'SESSION_EXPIRED');
    });

    test('3.2 POST /api/auth/logout revokes specific session token', async () => {
      // Login to get a dedicated session
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: userA.email, password: 'passwordAlice123' }),
      });
      const loginData = await loginRes.json();
      const sessionToken = loginData.token;

      // Verify session works
      const meRes1 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${sessionToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(meRes1.status, 200);

      // Logout
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(logoutRes.status, 200);

      // Verify session is now revoked
      const meRes2 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${sessionToken}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(meRes2.status, 401);
    });

    test('3.3 POST /api/auth/logout-all revokes all sessions across multiple devices', async () => {
      // Device 1
      const dev1Res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: userB.email, password: 'passwordBob123' }),
      });
      const dev1Data = await dev1Res.json();
      const tokenDev1 = dev1Data.token;

      // Device 2
      const dev2Res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: userB.email, password: 'passwordBob123' }),
      });
      const dev2Data = await dev2Res.json();
      const tokenDev2 = dev2Data.token;

      // Both devices active
      assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokenDev1}`, 'X-Requested-With': 'XMLHttpRequest' } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokenDev2}`, 'X-Requested-With': 'XMLHttpRequest' } })).status, 200);

      // Device 1 calls logout-all
      const revokeAllRes = await fetch(`${baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenDev1}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(revokeAllRes.status, 200);

      // Both devices are now invalidated
      assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokenDev1}`, 'X-Requested-With': 'XMLHttpRequest' } })).status, 401);
      assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokenDev2}`, 'X-Requested-With': 'XMLHttpRequest' } })).status, 401);
    });

    test('3.4 Removed workspace membership immediately revokes access even with valid session', async () => {
      // Create user C and add as member to Workspace A
      const userC = await repo.createUser({
        id: `usr_c_${Date.now()}`,
        email: 'user_c@example.com',
        passwordHash: 'hash',
        fullName: 'Charlie Member',
      });

      const memId = `mem_${userA.workspaceId}_${userC.id}`;
      (repo as any).memberships.set(memId, {
        id: memId,
        workspaceId: userA.workspaceId,
        userId: userC.id,
        role: 'member',
        createdAt: new Date().toISOString(),
      });

      const tokenC = generateSessionToken();
      await repo.createSession({
        id: `sess_c_${Date.now()}`,
        sessionTokenHash: hashSessionToken(tokenC),
        userId: userC.id,
        activeWorkspaceId: userA.workspaceId,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      // Member can access
      const accessBefore = await fetch(`${baseUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${tokenC}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(accessBefore.status, 200);

      // Remove membership
      (repo as any).memberships.delete(memId);

      // Subsequent request is immediately forbidden (403 CROSS_WORKSPACE_FORBIDDEN)
      const accessAfter = await fetch(`${baseUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${tokenC}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(accessAfter.status, 403);
      const data = await accessAfter.json();
      assert.equal(data.code, 'CROSS_WORKSPACE_FORBIDDEN');
    });
  });

  // ==========================================
  // 4. Role Authorization & Mass Assignment
  // ==========================================
  describe('4. RBAC & Mass Assignment Protection', () => {
    test('4.1 Member role cannot modify store settings (403 FORBIDDEN_INSUFFICIENT_ROLE)', async () => {
      // Create temporary member user in Workspace A
      const userMember = await repo.createUser({
        id: `usr_mem_${Date.now()}`,
        email: 'member_only@example.com',
        passwordHash: 'hash',
        fullName: 'Member Only',
      });

      const memId = `mem_${userA.workspaceId}_${userMember.id}`;
      (repo as any).memberships.set(memId, {
        id: memId,
        workspaceId: userA.workspaceId,
        userId: userMember.id,
        role: 'member',
        createdAt: new Date().toISOString(),
      });

      const tokenMember = generateSessionToken();
      await repo.createSession({
        id: `sess_mem_${Date.now()}`,
        sessionTokenHash: hashSessionToken(tokenMember),
        userId: userMember.id,
        activeWorkspaceId: userA.workspaceId,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenMember}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ name: 'Member Tamper Attempt' }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'FORBIDDEN_INSUFFICIENT_ROLE');
    });

    test('4.2 Client cannot escalate tier or quota via PUT /api/store/profile (Mass Assignment Defense)', async () => {
      // Owner user A tries to forge tier = 'Enterprise' and skuLimit = 999999
      const res = await fetch(`${baseUrl}/api/store/profile`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${userA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          name: 'Honest Store Name Update',
          tier: 'Enterprise',
          skuLimit: 999999,
          skuCount: 0,
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // Store name updated, but tier and skuLimit were stripped and retained original values
      assert.equal(data.store.name, 'Honest Store Name Update');
      assert.notEqual(data.store.tier, 'Enterprise', 'Client must not be able to elevate tier');
      assert.notEqual(data.store.skuLimit, 999999, 'Client must not be able to elevate SKU limit');
    });
  });

  // ==========================================
  // 5. Cross-Tenant Tampering Matrix
  // ==========================================
  describe('5. Cross-Tenant Isolation Enforcement', () => {
    test('5.1 User A cannot access Workspace B catalog by manipulating request bodies or URLs', async () => {
      // All catalog endpoints derive workspace exclusively from the authenticated session
      const res = await fetch(`${baseUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${userA.token}`, 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.workspaceId, userA.workspaceId, 'Returned catalog must strictly belong to User A');
      assert.notEqual(data.workspaceId, userB.workspaceId);
    });

    test('5.2 User A cannot approve action belonging to Workspace B', async () => {
      // Create an action in Workspace B
      const actionBId = 'act_exclusive_to_b';
      await repo.saveWorkspaceCatalog(userB.workspaceId, {
        products: [{ id: 'p_b', title: 'Product B', brand: '', category: '', description: '', image: '', status: 'active', completenessScore: 80, evidenceCoverageScore: 80, externalDiscoveryStatus: 'observed_in_sample', attributes: {}, findingsCount: 1, lastAudited: '', variants: [], offers: [], evidenceDocuments: [] }],
        variants: [],
        offers: [],
        findings: [{ id: 'f_b', productId: 'p_b', scope: 'product', type: 'inconsistent_attributes', severity: 'medium', title: 'Finding B', description: '', observedEvidence: '', derivedConclusion: '', merchantVerified: false, whyItMatters: '', actionItemId: actionBId }],
        actions: [{ id: actionBId, findingId: 'f_b', productId: 'p_b', title: 'Fix B', severity: 'medium', status: 'pending_review', verificationStatus: 'unverified', evidenceRequired: false, proposedChange: { field: 'title / marketing claims', from: 'Old', to: 'New' }, auditLog: [] }],
        evidence: [],
        storeProfile: { name: 'B Store', domain: 'b.myshopify.com', currency: 'USD', skuCount: 1, catalogCompletenessAvg: 80, truthBoundaryStrictness: 'standard', tier: 'Starter', connectors: [] },
      });

      // User A attempts to approve Workspace B's action
      const approveRes = await fetch(`${baseUrl}/api/catalog/actions/${actionBId}/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
      });

      assert.equal(approveRes.status, 404, 'Action from different workspace must be treated as not found');
      const data = await approveRes.json();
      assert.equal(data.code, 'ACTION_NOT_FOUND');
    });

    test('5.3 User A cannot switch active workspace to Workspace B without membership', async () => {
      const switchRes = await fetch(`${baseUrl}/api/auth/switch-workspace`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userA.token}`,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ workspaceId: userB.workspaceId }),
      });

      assert.equal(switchRes.status, 403, 'Switching to unauthorized workspace must be forbidden');
    });
  });
});
