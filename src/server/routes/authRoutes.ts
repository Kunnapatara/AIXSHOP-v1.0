import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { hashPassword, verifyPassword } from '../security/passwords';
import { generateSessionToken, hashSessionToken } from '../security/tokens';
import { createAuthMiddleware, authRateLimiter } from '../middleware/auth';
import { AuthRequest } from '../types';

export function createAuthRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  const COOKIE_NAME = 'aixshop_session';
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const setSessionCookie = (res: Response, token: string) => {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: THIRTY_DAYS_MS,
      path: '/',
    });
  };

  const clearSessionCookie = (res: Response) => {
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  };

  // POST /api/auth/register
  router.post('/register', authRateLimiter(20), async (req, res) => {
    try {
      const { email, password, fullName, workspaceName } = req.body || {};

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email address is required' });
      }
      if (!password || typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
      }
      if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
        return res.status(400).json({ error: 'Full name is required' });
      }
      if (!workspaceName || typeof workspaceName !== 'string' || !workspaceName.trim()) {
        return res.status(400).json({ error: 'Workspace name is required' });
      }

      // Check existing user
      const existingUser = await repo.getUserByEmail(email.trim().toLowerCase());
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Hash password
      const passwordHash = await hashPassword(password);
      const userId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const user = await repo.createUser({
        id: userId,
        email: email.trim().toLowerCase(),
        passwordHash,
        fullName: fullName.trim(),
      });

      // Create workspace and owner membership
      const wsSlug = workspaceName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `ws-${Date.now()}`;
      const wsId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const { workspace } = await repo.createWorkspace(
        {
          id: wsId,
          name: workspaceName.trim(),
          slug: `${wsSlug}-${Math.random().toString(36).substring(2, 5)}`,
        },
        user.id
      );

      // Create session
      const rawToken = generateSessionToken();
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();

      await repo.createSession({
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sessionTokenHash: tokenHash,
        userId: user.id,
        activeWorkspaceId: workspace.id,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      setSessionCookie(res, rawToken);

      return res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          role: 'owner',
        },
        token: rawToken,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Registration error:', err);
      return res.status(500).json({ error: 'Internal server error during registration' });
    }
  });

  // POST /api/auth/login
  router.post('/login', authRateLimiter(20), async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const user = await repo.getUserByEmail(String(email).trim().toLowerCase());
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const isValidPassword = await verifyPassword(String(password), user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Retrieve workspaces
      const workspaces = await repo.getUserWorkspaces(user.id);
      if (workspaces.length === 0) {
        return res.status(403).json({ error: 'User does not belong to any active workspace' });
      }

      const activeWorkspace = workspaces[0];

      // Create session
      const rawToken = generateSessionToken();
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();

      await repo.createSession({
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sessionTokenHash: tokenHash,
        userId: user.id,
        activeWorkspaceId: activeWorkspace.id,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      setSessionCookie(res, rawToken);

      return res.json({
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
        workspace: {
          id: activeWorkspace.id,
          name: activeWorkspace.name,
          slug: activeWorkspace.slug,
          role: activeWorkspace.role,
        },
        workspaces,
        token: rawToken,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Login error:', err);
      return res.status(500).json({ error: 'Internal server error during login' });
    }
  });

  // POST /api/auth/logout
  router.post('/logout', async (req, res) => {
    try {
      let token: string | undefined = req.cookies?.[COOKIE_NAME];
      const authHeader = req.headers.authorization;
      if (!token && authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      }

      if (token) {
        const tokenHash = hashSessionToken(token);
        await repo.deleteSession(tokenHash);
      }

      clearSessionCookie(res);
      return res.json({ success: true, message: 'Logged out successfully' });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Logout error:', err);
      clearSessionCookie(res);
      return res.json({ success: true });
    }
  });

  // GET /api/auth/me
  router.get('/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const user = req.user!;
      const workspace = req.workspace!;
      const workspaces = await repo.getUserWorkspaces(user.id);

      return res.json({
        user,
        workspace,
        workspaces,
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Session verification error:', err);
      return res.status(500).json({ error: 'Internal server error verifying session' });
    }
  });

  // POST /api/auth/switch-workspace
  router.post('/switch-workspace', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { workspaceId } = req.body || {};
      if (!workspaceId) {
        return res.status(400).json({ error: 'workspaceId is required' });
      }

      // Verify that user is a member of the target workspace
      const membership = await repo.getMembership(workspaceId, req.user!.id);
      if (!membership) {
        return res.status(403).json({ error: 'Access denied: not a member of this workspace' });
      }

      const targetWorkspace = await repo.getWorkspaceById(workspaceId);
      if (!targetWorkspace) {
        return res.status(404).json({ error: 'Target workspace not found' });
      }

      await repo.updateSessionWorkspace(req.sessionId!, workspaceId);

      return res.json({
        success: true,
        workspace: {
          id: targetWorkspace.id,
          name: targetWorkspace.name,
          slug: targetWorkspace.slug,
          role: membership.role,
        },
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Switch workspace error:', err);
      return res.status(500).json({ error: 'Internal error switching workspace' });
    }
  });

  return router;
}
