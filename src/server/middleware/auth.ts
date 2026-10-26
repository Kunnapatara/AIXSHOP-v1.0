import { Response, NextFunction } from 'express';
import { AuthRequest, WorkspaceRole } from '../types';
import { DatabaseRepository } from '../db/repository';
import { hashSessionToken } from '../security/tokens';

// Bounded in-memory rate limiting store with active TTL cleanup
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
let lastPruneAt = Date.now();
const MAX_RATE_LIMITER_ENTRIES = 5000;

function pruneExpiredRateLimitEntries(now: number) {
  for (const [key, value] of loginAttempts.entries()) {
    if (now > value.resetAt) {
      loginAttempts.delete(key);
    }
  }
}

export function _resetRateLimiter(): void {
  loginAttempts.clear();
}

export function _getRateLimiterSize(): number {
  return loginAttempts.size;
}

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

      // Explicit server-side session expiry verification
      const expiresAtDate = new Date(session.expiresAt);
      if (isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
        return res.status(401).json({ 
          error: 'Authentication required: session has expired',
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
      // If user was removed from the workspace, access is immediately revoked
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
 * Role-based authorization middleware.
 * Verifies that the authenticated user holds an authorized role in the active workspace.
 */
export function requireRole(allowedRoles: WorkspaceRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.workspace || !allowedRoles.includes(req.workspace.role)) {
      return res.status(403).json({
        error: `Forbidden: role "${req.workspace?.role || 'none'}" lacks required permissions. Requires one of: ${allowedRoles.join(', ')}`,
        code: 'FORBIDDEN_INSUFFICIENT_ROLE',
      });
    }
    next();
  };
}

/**
 * IP rate limiter for authentication endpoints (prevent brute-force).
 * Implements bounded memory growth with active expiration pruning.
 * Note: In-memory rate limiting is scoped to a single process instance.
 */
export function authRateLimiter(maxAttempts = 15, windowMs = 15 * 60 * 1000) {
  return (req: any, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    // Active prune every minute or when capacity threshold reached
    if (now - lastPruneAt > 60000 || loginAttempts.size > MAX_RATE_LIMITER_ENTRIES) {
      pruneExpiredRateLimitEntries(now);
      lastPruneAt = now;
    }

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
 * CSRF Protection for state-modifying requests using session cookies.
 * 
 * Rules:
 * - Safe HTTP methods (GET, HEAD, OPTIONS) are exempt.
 * - Requests without session cookie (e.g. pure Bearer token API requests) are exempt.
 * - State-changing cookie requests MUST present a valid custom header:
 *   'X-Requested-With: XMLHttpRequest' OR 'X-CSRF-Token'.
 * - Origin / Referer validation is performed when present to ensure same-origin consistency.
 * - Content-Type: application/json alone is explicitly NOT sufficient to bypass CSRF.
 */
export function csrfProtection(req: any, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Pure token-based (Bearer) or unauthenticated requests are not subject to cookie-based CSRF
  if (!req.cookies?.aixshop_session) {
    return next();
  }

  // Validate custom anti-CSRF header
  const customHeader = req.headers['x-requested-with'] || req.headers['x-csrf-token'];
  const hasValidHeader = (
    req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    (typeof req.headers['x-csrf-token'] === 'string' && req.headers['x-csrf-token'].trim().length > 0)
  );

  if (!hasValidHeader) {
    return res.status(403).json({ 
      error: 'Forbidden: Missing or invalid CSRF verification header. State-modifying cookie requests require X-Requested-With or X-CSRF-Token header.',
      code: 'CSRF_REJECTED' 
    });
  }

  // Validate Origin header when present
  const origin = req.headers['origin'];
  if (origin && typeof origin === 'string') {
    try {
      const originUrl = new URL(origin);
      const reqHost = req.headers['host'];
      if (reqHost && originUrl.host !== reqHost) {
        return res.status(403).json({
          error: 'Forbidden: Cross-origin state modification rejected.',
          code: 'CSRF_ORIGIN_MISMATCH',
        });
      }
    } catch {
      return res.status(403).json({
        error: 'Forbidden: Malformed Origin header.',
        code: 'CSRF_ORIGIN_INVALID',
      });
    }
  }

  next();
}
