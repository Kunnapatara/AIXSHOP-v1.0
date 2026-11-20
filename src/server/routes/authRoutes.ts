import { Router, Request, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { hashPassword, verifyPassword } from '../security/passwords';
import { generateSessionToken, hashSessionToken } from '../security/tokens';
import { createAuthMiddleware, authRateLimiter } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getTrustedBaseUrl } from '../config/productionConfig';
import { sendPasswordResetEmail } from '../services/emailService';

function validatePasswordInput(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password must not exceed 128 characters' };
  }
  if (password.trim().length === 0) {
    return { valid: false, error: 'Password cannot consist solely of whitespace' };
  }
  return { valid: true };
}

export function createAuthRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const requireAuth = createAuthMiddleware(repo);

  const COOKIE_NAME = 'aixshop_session';
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const extractIncomingToken = (req: Request): string | undefined => {
    let token: string | undefined = req.cookies?.[COOKIE_NAME];
    const authHeader = req.headers.authorization;
    if (!token && authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
    return token;
  };

  const revokeIncomingToken = async (req: Request): Promise<void> => {
    const incoming = extractIncomingToken(req);
    if (incoming) {
      await repo.deleteSession(hashSessionToken(incoming)).catch(() => {});
    }
  };

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
  router.post('/register', authRateLimiter(20, 15 * 60 * 1000, repo, { keyPrefix: 'register' }), async (req, res) => {
    try {
      const { email, password, fullName, workspaceName } = req.body || {};

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email address is required' });
      }
      const pwCheck = validatePasswordInput(password);
      if (!pwCheck.valid) {
        return res.status(400).json({ error: pwCheck.error });
      }
      if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
        return res.status(400).json({ error: 'Full name is required' });
      }
      if (!workspaceName || typeof workspaceName !== 'string' || !workspaceName.trim()) {
        return res.status(400).json({ error: 'Workspace name is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Check existing user
      const existingUser = await repo.getUserByEmail(normalizedEmail);
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Rotate away any pre-existing session cookie
      await revokeIncomingToken(req);

      // Hash password
      const passwordHash = await hashPassword(password);
      const userId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const wsSlug = workspaceName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `ws-${Date.now()}`;
      const wsId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const rawToken = generateSessionToken();
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
      const sessId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      // Atomic registration (transaction in PostgreSQL, atomic commit in Memory)
      const { user, workspace } = await repo.registerUser({
        user: {
          id: userId,
          email: normalizedEmail,
          passwordHash,
          fullName: fullName.trim(),
        },
        workspace: {
          id: wsId,
          name: workspaceName.trim(),
          slug: `${wsSlug}-${Math.random().toString(36).substring(2, 5)}`,
        },
        session: {
          id: sessId,
          sessionTokenHash: tokenHash,
          userId,
          activeWorkspaceId: wsId,
          expiresAt,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        },
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
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Registration error:', err);
      return res.status(500).json({ error: 'Internal server error during registration' });
    }
  });

  // POST /api/auth/login
  router.post('/login', authRateLimiter(20, 15 * 60 * 1000, repo, { keyPrefix: 'login' }), async (req, res) => {
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

      // Session rotation on login: revoke any prior incoming session before creating fresh token
      await revokeIncomingToken(req);

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
      });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Login error:', err);
      return res.status(500).json({ error: 'Internal server error during login' });
    }
  });

  // POST /api/auth/forgot-password — Non-enumerating account recovery initiation
  router.post(
    '/forgot-password',
    authRateLimiter(10, 15 * 60 * 1000, repo, { keyPrefix: 'forgot_pw' }),
    async (req, res) => {
      try {
        const rawEmail = req.body?.email;
        if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@')) {
          return res.status(400).json({ error: 'Valid email address is required' });
        }

        const normalizedEmail = rawEmail.trim().toLowerCase();
        const user = await repo.getUserByEmail(normalizedEmail);

        if (user) {
          const ttlMinutesRaw = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 30);
          const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? Math.min(120, ttlMinutesRaw) : 30;
          const rawResetToken = generateSessionToken();
          const tokenHash = hashSessionToken(rawResetToken);
          const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

          await repo.createPasswordResetToken({
            id: `pwr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            userId: user.id,
            tokenHash,
            expiresAt,
            requestedIp: req.ip,
          });

          const baseUrl = getTrustedBaseUrl(req);
          const resetUrl = `${baseUrl}/#reset_token=${encodeURIComponent(rawResetToken)}`;
          await sendPasswordResetEmail({
            to: user.email,
            fullName: user.fullName,
            resetUrl,
            ttlMinutes,
          });
        }

        // Strict non-enumeration response: identical regardless of whether email matched an account
        return res.json({
          success: true,
          message: 'If an account matches that email address, password reset instructions have been sent.',
        });
      } catch (err: any) {
        console.error('[AIXSHOP Auth] Forgot password error:', err);
        return res.status(500).json({ error: 'Unable to process password reset request' });
      }
    }
  );

  // POST /api/auth/reset-password — Single-use token verification, password update, and full session revocation
  router.post(
    '/reset-password',
    authRateLimiter(10, 15 * 60 * 1000, repo, { keyPrefix: 'reset_pw' }),
    async (req, res) => {
      try {
        const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const rawNewPassword =
          typeof req.body?.newPassword === 'string' ? req.body.newPassword : req.body?.password;

        if (!rawToken) {
          return res.status(400).json({
            error: 'Password reset token is required',
            code: 'INVALID_RESET_TOKEN',
          });
        }

        const pwCheck = validatePasswordInput(rawNewPassword);
        if (!pwCheck.valid) {
          return res.status(400).json({
            error: pwCheck.error,
            code: 'INVALID_PASSWORD',
          });
        }

        const tokenHash = hashSessionToken(rawToken);
        const newPasswordHash = await hashPassword(rawNewPassword as string);
        const consumed = await repo.consumePasswordResetTokenAndUpdatePassword(tokenHash, newPasswordHash);

        if (!consumed) {
          return res.status(400).json({
            error: 'Password reset link is invalid, expired, or has already been used.',
            code: 'INVALID_RESET_TOKEN',
          });
        }

        clearSessionCookie(res);
        return res.json({
          success: true,
          message: 'Password updated successfully. All active sessions have been signed out; please sign in again.',
        });
      } catch (err: any) {
        console.error('[AIXSHOP Auth] Reset password error:', err);
        return res.status(500).json({ error: 'Unable to reset password' });
      }
    }
  );

  // POST /api/auth/logout
  router.post('/logout', async (req, res) => {
    try {
      await revokeIncomingToken(req);
      clearSessionCookie(res);
      return res.json({ success: true, message: 'Logged out successfully' });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Logout error:', err);
      clearSessionCookie(res);
      return res.json({ success: true });
    }
  });

  // POST /api/auth/logout-all — Revoke all active sessions across all devices
  router.post('/logout-all', requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.id;
      await repo.deleteUserSessions(userId);
      clearSessionCookie(res);
      return res.json({ success: true, message: 'All active sessions revoked successfully' });
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Logout-all error:', err);
      clearSessionCookie(res);
      return res.status(500).json({ error: 'Failed to revoke sessions' });
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

      // Rotate session token on workspace context transition
      const incomingToken = extractIncomingToken(req);
      const newRawToken = generateSessionToken();
      const newTokenHash = hashSessionToken(newRawToken);
      const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();

      await repo.createSession({
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sessionTokenHash: newTokenHash,
        userId: req.user!.id,
        activeWorkspaceId: workspaceId,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      if (incomingToken) {
        await repo.deleteSession(hashSessionToken(incomingToken)).catch(() => {});
      }

      setSessionCookie(res, newRawToken);

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
