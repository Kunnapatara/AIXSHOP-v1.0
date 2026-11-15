import { Response, NextFunction } from 'express';
import { AuthRequest, WorkspaceRole } from '../types';
import { DatabaseRepository } from '../db/repository';
import { hashSessionToken } from '../security/tokens';
import {
  AuthRateLimitFailureMode,
  resolveAuthRateLimitFailurePolicy,
} from '../config/productionConfig';

// Bounded in-memory rate limiting store with active TTL cleanup and FIFO eviction under load
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const resetHooks = new Set<() => void>();
let lastPruneAt = Date.now();
const DEFAULT_MAX_RATE_LIMITER_ENTRIES = 5000;

export interface AuthRateLimiterDiagnostics {
  policy: AuthRateLimitFailureMode;
  failClosedByDefaultInProd: boolean;
  explicitOverrideActive: boolean;
  storageDegraded: boolean;
  degradedEvents: number;
  lastFailureAt: string | null;
  lastRecoveredAt: string | null;
  lastErrorCategory: string | null;
}

const rateLimiterDiagState = {
  storageDegraded: false,
  degradedEvents: 0,
  lastFailureAt: null as string | null,
  lastRecoveredAt: null as string | null,
  lastErrorCategory: null as string | null,
};

export function getAuthRateLimiterDiagnostics(): AuthRateLimiterDiagnostics {
  const policy = resolveAuthRateLimitFailurePolicy();
  return {
    policy: policy.mode,
    failClosedByDefaultInProd: true,
    explicitOverrideActive: policy.explicitOverride,
    storageDegraded: rateLimiterDiagState.storageDegraded,
    degradedEvents: rateLimiterDiagState.degradedEvents,
    lastFailureAt: rateLimiterDiagState.lastFailureAt,
    lastRecoveredAt: rateLimiterDiagState.lastRecoveredAt,
    lastErrorCategory: rateLimiterDiagState.lastErrorCategory,
  };
}

function pruneExpiredRateLimitEntries(now: number) {
  for (const [key, value] of loginAttempts.entries()) {
    if (now > value.resetAt) {
      loginAttempts.delete(key);
    }
  }
}

function consumeLocalBoundedRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
  maxEntries: number
): { allowed: boolean; count: number; resetAt: number } {
  const now = Date.now();

  if (now - lastPruneAt > 60000 || loginAttempts.size >= maxEntries) {
    pruneExpiredRateLimitEntries(now);
    lastPruneAt = now;
  }

  const existing = loginAttempts.get(key);
  if (existing && now <= existing.resetAt) {
    // Refresh insertion order for LRU behavior
    loginAttempts.delete(key);
    if (existing.count >= maxAttempts) {
      loginAttempts.set(key, existing);
      return { allowed: false, count: existing.count, resetAt: existing.resetAt };
    }
    const nextEntry = { count: existing.count + 1, resetAt: existing.resetAt };
    loginAttempts.set(key, nextEntry);
    return { allowed: true, count: nextEntry.count, resetAt: nextEntry.resetAt };
  }

  // Evict oldest entries if at strict cap even with active non-expired keys
  while (loginAttempts.size >= maxEntries) {
    const oldestKey = loginAttempts.keys().next().value;
    if (oldestKey === undefined) break;
    loginAttempts.delete(oldestKey);
  }

  const resetAt = now + windowMs;
  loginAttempts.set(key, { count: 1, resetAt });
  return { allowed: true, count: 1, resetAt };
}

export function _resetRateLimiter(): void {
  loginAttempts.clear();
  rateLimiterDiagState.storageDegraded = false;
  rateLimiterDiagState.degradedEvents = 0;
  rateLimiterDiagState.lastFailureAt = null;
  rateLimiterDiagState.lastRecoveredAt = null;
  rateLimiterDiagState.lastErrorCategory = null;
  for (const hook of resetHooks) {
    try {
      hook();
    } catch {
      // ignore
    }
  }
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

export interface AuthRateLimiterOptions {
  keyPrefix?: string;
  maxMemoryEntries?: number;
  failClosedOnStorageError?: boolean;
}

/**
 * Shared rate limiter for authentication endpoints (brute-force & high-cardinality flood protection).
 * - Uses shared PostgreSQL / Repository storage via repo.consumeRateLimit when provided.
 * - In production (NODE_ENV=production), defaults to FAIL CLOSED (HTTP 503 RATE_LIMITER_UNAVAILABLE)
 *   when shared storage fails, unless explicitly overridden via AUTH_RATE_LIMIT_FAILURE_MODE=fallback_local
 *   or options.failClosedOnStorageError=false.
 * - In development/test, safely falls back to a strictly capacity-bounded local Map unless configured fail_closed.
 * - Applies trusted Express req.ip (respecting configured 'trust proxy') + normalized account email bucket.
 */
export function authRateLimiter(
  maxAttempts = 15,
  windowMs = 15 * 60 * 1000,
  repo?: DatabaseRepository,
  options: AuthRateLimiterOptions = {}
) {
  const keyPrefix = options.keyPrefix || 'auth';
  const maxEntries = Math.max(10, options.maxMemoryEntries ?? DEFAULT_MAX_RATE_LIMITER_ENTRIES);

  if (repo && typeof (repo as any).clearRateLimits === 'function') {
    resetHooks.add(() => (repo as any).clearRateLimits());
  }

  return async (req: any, res: Response, next: NextFunction) => {
    // Express resolves req.ip safely according to app.set('trust proxy', ...) — never blindly parse raw X-Forwarded-For
    const rawIp = String(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown').trim();
    const ipKey = `rl:${keyPrefix}:ip:${rawIp}`;

    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const keysToCheck = [ipKey];
    if (rawEmail) {
      keysToCheck.push(`rl:${keyPrefix}:acct:${rawEmail}`);
    }

    const policy = resolveAuthRateLimitFailurePolicy();
    const failClosed =
      options.failClosedOnStorageError !== undefined
        ? options.failClosedOnStorageError
        : policy.failClosedOnStorageError;

    try {
      if (repo && typeof repo.consumeRateLimit === 'function') {
        for (const k of keysToCheck) {
          const result = await repo.consumeRateLimit(k, maxAttempts, windowMs);
          // Mirror key presence into bounded local tracker for memory-mode observability
          if (repo.getBackendType() === 'memory') {
            while (loginAttempts.size >= maxEntries && !loginAttempts.has(k)) {
              const oldest = loginAttempts.keys().next().value;
              if (oldest === undefined) break;
              loginAttempts.delete(oldest);
            }
            loginAttempts.set(k, { count: result.count, resetAt: result.resetAt });
          }
          if (!result.allowed) {
            return res.status(429).json({
              error: 'Too many authentication attempts. Please try again later.',
              code: 'RATE_LIMITED',
              retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
            });
          }
        }
        if (rateLimiterDiagState.storageDegraded) {
          rateLimiterDiagState.storageDegraded = false;
          rateLimiterDiagState.lastRecoveredAt = new Date().toISOString();
          rateLimiterDiagState.lastErrorCategory = null;
        }
        return next();
      }
    } catch {
      rateLimiterDiagState.storageDegraded = true;
      rateLimiterDiagState.degradedEvents += 1;
      rateLimiterDiagState.lastFailureAt = new Date().toISOString();
      rateLimiterDiagState.lastErrorCategory = 'shared_storage_unavailable';
      console.error(
        `[AIXSHOP Auth RateLimit] Shared rate-limit storage error (policy=${failClosed ? 'fail_closed' : 'fallback_local'}).`
      );
      if (failClosed) {
        return res.status(503).json({
          error: 'Authentication rate limiter temporarily unavailable. Please retry shortly.',
          code: 'RATE_LIMITER_UNAVAILABLE',
        });
      }
      // Explicit/non-production override allows falling through to bounded local limiter fallback below
    }

    if (failClosed && (!repo || typeof repo.consumeRateLimit !== 'function')) {
      rateLimiterDiagState.storageDegraded = true;
      rateLimiterDiagState.degradedEvents += 1;
      rateLimiterDiagState.lastFailureAt = new Date().toISOString();
      rateLimiterDiagState.lastErrorCategory = 'shared_storage_unconfigured';
      return res.status(503).json({
        error: 'Authentication rate limiter temporarily unavailable. Please retry shortly.',
        code: 'RATE_LIMITER_UNAVAILABLE',
      });
    }

    for (const k of keysToCheck) {
      const localRes = consumeLocalBoundedRateLimit(k, maxAttempts, windowMs, maxEntries);
      if (!localRes.allowed) {
        return res.status(429).json({
          error: 'Too many authentication attempts. Please try again later.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: Math.max(1, Math.ceil((localRes.resetAt - Date.now()) / 1000)),
        });
      }
    }

    return next();
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
