import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { DatabaseRepository } from '../db/repository';
import { hashSessionToken } from '../security/tokens';

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export function createAuthMiddleware(repo: DatabaseRepository) {
  return async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // 1. Extract session token from HTTP-only cookie or Authorization Bearer header
      let token: string | undefined = req.cookies?.aixshop_session;
      
      const authHeader = req.headers.authorization;
      if (!token && authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      }

      if (!token) {
        return res.status(401).json({ 
          error: 'Authentication required: missing session token',
          code: 'UNAUTHORIZED' 
        });
      }

      // 2. Hash token and look up active session
      const tokenHash = hashSessionToken(token);
      const session = await repo.getSessionByTokenHash(tokenHash);

      if (!session) {
        return res.status(401).json({ 
          error: 'Authentication required: invalid or expired session',
          code: 'SESSION_EXPIRED' 
        });
      }

      // 3. Look up user
      const user = await repo.getUserById(session.userId);
      if (!user) {
        return res.status(401).json({ 
          error: 'Authentication failed: user record not found',
          code: 'USER_NOT_FOUND' 
        });
      }

      // 4. Look up workspace
      const workspace = await repo.getWorkspaceById(session.activeWorkspaceId);
      if (!workspace) {
        return res.status(403).json({ 
          error: 'Forbidden: active workspace not found',
          code: 'WORKSPACE_NOT_FOUND' 
        });
      }

      // 5. Strictly verify user's membership and permissions in this workspace
      const membership = await repo.getMembership(workspace.id, user.id);
      if (!membership) {
        return res.status(403).json({ 
          error: 'Forbidden: access denied for this workspace',
          code: 'CROSS_WORKSPACE_FORBIDDEN' 
        });
      }

      // 6. Attach authenticated identity to request context
      req.user = {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
      };
      req.workspace = {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: membership.role,
      };
      req.sessionId = session.id;

      next();
    } catch (err: any) {
      console.error('[AIXSHOP Auth] Internal error during authentication check:', err);
      return res.status(500).json({ error: 'Internal server authentication error' });
    }
  };
}

/**
 * Basic IP rate limiter for authentication endpoints (prevent brute-force).
 */
export function authRateLimiter(maxAttempts = 15, windowMs = 15 * 60 * 1000) {
  return (req: any, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    if (entry) {
      if (now > entry.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
        return next();
      }
      if (entry.count >= maxAttempts) {
        return res.status(429).json({ 
          error: 'Too many authentication attempts. Please try again later.',
          code: 'RATE_LIMITED' 
        });
      }
      entry.count += 1;
    } else {
      loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    }

    next();
  };
}

/**
 * CSRF Protection for state-modifying requests using cookies
 */
export function csrfProtection(req: any, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Modern browsers require preflight for JSON + custom header.
  // Validate that request includes a custom header or comes with same-origin
  const customHeader = req.headers['x-requested-with'] || req.headers['x-csrf-token'];
  const contentType = req.headers['content-type'];

  if (req.cookies?.aixshop_session && !customHeader && !contentType?.includes('application/json')) {
    return res.status(403).json({ 
      error: 'Forbidden: Missing CSRF verification header',
      code: 'CSRF_REJECTED' 
    });
  }

  next();
}
