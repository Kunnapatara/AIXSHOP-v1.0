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

export const SESSION_COOKIE_NAME = 'aixshop_session';
export const SESSION_PRESENCE_COOKIE_NAME = 'aixshop_has_session';
export const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function setSessionPresenceCookie(res: Response, hasSession: boolean): void {
  res.cookie(SESSION_PRESENCE_COOKIE_NAME, hasSession ? '1' : '0', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
  setSessionPresenceCookie(res, false);
}

/**
 * Initializes or reconciles the non-security `aixshop_has_session` presence marker
 * on HTML document requests without weakening server-side authentication.
 * - Unauthenticated first visits receive `aixshop_has_session=0`.
 * - Pre-existing valid HttpOnly `aixshop_session` cookies without a marker receive `aixshop_has_session=1`.
 * - Expired/revoked `aixshop_session` cookies are cleared and marked `aixshop_has_session=0`.
 */
export function createSessionPresenceHtmlMiddleware(repo: DatabaseRepository) {
  return async function sessionPresenceHtmlMiddleware(req: any, res: Response, next: NextFunction) {
    if (req.method !== 'GET') return next();

    const rawPath = String(req.path || req.originalUrl?.split('?')[0] || '/').toLowerCase();
    const isNonHtmlOrAsset =
      rawPath.startsWith('/api') ||
      rawPath.startsWith('/src/') ||
      rawPath.startsWith('/@') ||
      rawPath.startsWith('/node_modules/') ||
      rawPath.startsWith('/assets/') ||
      rawPath === '/robots.txt' ||
      rawPath === '/sitemap.xml' ||
      rawPath === '/favicon.svg' ||
      /\.[a-z0-9]{1,8}$/i.test(rawPath);

    if (isNonHtmlOrAsset || !req.accepts('html')) {
      return next();
    }

    const sessionToken: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];
    const currentMarker: string | undefined = req.cookies?.[SESSION_PRESENCE_COOKIE_NAME];

    if (!sessionToken) {
      if (currentMarker !== '0') {
        setSessionPresenceCookie(res, false);
      }
      return next();
    }

    try {
      const session = await repo.getSessionByTokenHash(hashSessionToken(sessionToken));
      const expiresAtMs = session ? new Date(session.expiresAt).getTime() : NaN;
      const isValidSession = Boolean(session && !Number.isNaN(expiresAtMs) && expiresAtMs > Date.now());

      if (isValidSession) {
        if (currentMarker !== '1') {
          setSessionPresenceCookie(res, true);
        }
      } else {
        clearSessionCookies(res);
      }
    } catch {
      // On transient storage error, do not mark unauthenticated if an HttpOnly cookie is present
      if (currentMarker !== '1') {
        setSessionPresenceCookie(res, true);
      }
    }

    return next();
  };
}

export function createAuthMiddleware(repo: DatabaseRepository) {
  return async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // 1. Extract session token from HTTP-only cookie or Authorization Bearer header
      // Never accept aixshop_has_session as authentication evidence.
      const cookieToken: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];
      let token: string | undefined = cookieToken;
      
      const authHeader = req.headers.authorization;
      if (!token && authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      }

      if (!token) {
        if (req.cookies?.[SESSION_PRESENCE_COOKIE_NAME] === '1') {
          setSessionPresenceCookie(res, false);
        }
        return res.status(401).json({ 
          error: 'Authentication required: missing session token',
          code: 'UNAUTHORIZED' 
        });
      }

      // 2. Hash token and look up active session
      const tokenHash = hashSessionToken(token);
      const session = await repo.getSessionByTokenHash(tokenHash);

      if (!session) {
        if (cookieToken) {
          clearSessionCookies(res);
        }
        return res.status(401).json({ 
          error: 'Authentication required: invalid or expired session',
          code: 'SESSION_EXPIRED' 
        });
      }

      // Explicit server-side session expiry verification
      const expiresAtDate = new Date(session.expiresAt);
      if (isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
        if (cookieToken) {
          clearSessionCookies(res);
        }
        return res.status(401).json({ 
          error: 'Authentication required: session has expired',
          code: 'SESSION_EXPIRED' 
        });
      }

      // 3. Look up user
      const user = await repo.getUserById(session.userId);
      if (!user) {
        if (cookieToken) {
          clearSessionCookies(res);
        }
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
            const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
              error: 'Too many authentication attempts. Please try again later.',
              code: 'RATE_LIMITED',
              retryAfterSeconds,
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
        const retryAfterSeconds = Math.max(1, Math.ceil((localRes.resetAt - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error: 'Too many authentication attempts. Please try again later.',
          code: 'RATE_LIMITED',
          retryAfterSeconds,
        });
      }
    }

    return next();
  };
}

export interface WorkspaceRateLimiterOptions extends AuthRateLimiterOptions {
  keyPrefix: string;
  maxAttempts: number;
  windowMs: number;
  message?: string;
}

/**
 * Shared rate limiter for expensive workspace-scoped operational endpoints
 * (audit runs, catalog imports, Shopify syncs, feed validation/export, visibility uploads).
 */
export function createWorkspaceRateLimiter(
  options: WorkspaceRateLimiterOptions,
  repo?: DatabaseRepository
) {
  const maxEntries = Math.max(10, options.maxMemoryEntries ?? DEFAULT_MAX_RATE_LIMITER_ENTRIES);
  if (repo && typeof (repo as any).clearRateLimits === 'function') {
    resetHooks.add(() => (repo as any).clearRateLimits());
  }

  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const scopeId = req.workspace?.id
      ? `ws:${req.workspace.id}`
      : `ip:${String(req.ip || req.socket?.remoteAddress || 'unknown').trim()}`;
    const bucketKey = `rl:${options.keyPrefix}:${scopeId}`;

    const policy = resolveAuthRateLimitFailurePolicy();
    const failClosed =
      options.failClosedOnStorageError !== undefined
        ? options.failClosedOnStorageError
        : policy.failClosedOnStorageError;

    try {
      if (repo && typeof repo.consumeRateLimit === 'function') {
        const result = await repo.consumeRateLimit(bucketKey, options.maxAttempts, options.windowMs);
        if (!result.allowed) {
          const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
          res.setHeader('Retry-After', String(retryAfterSeconds));
          return res.status(429).json({
            error: options.message || 'Rate limit exceeded for this operation. Please try again shortly.',
            code: 'RATE_LIMITED',
            retryAfterSeconds,
          });
        }
        return next();
      }
    } catch {
      if (failClosed) {
        return res.status(503).json({
          error: 'Rate limiter temporarily unavailable. Please retry shortly.',
          code: 'RATE_LIMITER_UNAVAILABLE',
        });
      }
    }

    if (failClosed && (!repo || typeof repo.consumeRateLimit !== 'function')) {
      return res.status(503).json({
        error: 'Rate limiter temporarily unavailable. Please retry shortly.',
        code: 'RATE_LIMITER_UNAVAILABLE',
      });
    }

    const localRes = consumeLocalBoundedRateLimit(
      bucketKey,
      options.maxAttempts,
      options.windowMs,
      maxEntries
    );
    if (!localRes.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((localRes.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: options.message || 'Rate limit exceeded for this operation. Please try again shortly.',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
      });
    }

    return next();
  };
}

export class OperationInProgressError extends Error {
  public readonly code = 'OPERATION_IN_PROGRESS';
  public readonly statusCode = 409;
  public readonly operationKey: string;

  constructor(operationKey: string, message?: string) {
    super(
      message ||
        `Operation "${operationKey}" is already in progress for this workspace. Wait for completion before retrying.`
    );
    this.name = 'OperationInProgressError';
    this.operationKey = operationKey;
  }
}

/**
 * Acquires a shared database-backed workspace operation lease (Migration 014)
 * so concurrent syncs / imports across multiple instances fail fast with 409 OPERATION_IN_PROGRESS.
 */
export async function withWorkspaceOperationLease<T>(
  repo: DatabaseRepository,
  workspaceId: string,
  operationKey: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const leaseOwner = `op_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const lease = await repo.acquireWorkspaceOperationLease(workspaceId, operationKey, leaseOwner, ttlMs);
  if (!lease.acquired) {
    throw new OperationInProgressError(operationKey);
  }

  try {
    return await fn();
  } finally {
    await repo.releaseWorkspaceOperationLease(workspaceId, operationKey, leaseOwner).catch(() => {});
  }
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

  const reqHost = req.headers['host'];

  // Validate Origin header when present, with Referer same-origin fallback when Origin is absent
  const origin = req.headers['origin'];
  if (origin && typeof origin === 'string') {
    try {
      const originUrl = new URL(origin);
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
  } else {
    const referer = req.headers['referer'];
    if (referer && typeof referer === 'string') {
      try {
        const refererUrl = new URL(referer);
        if (reqHost && refererUrl.host !== reqHost) {
          return res.status(403).json({
            error: 'Forbidden: Cross-origin Referer state modification rejected.',
            code: 'CSRF_ORIGIN_MISMATCH',
          });
        }
      } catch {
        return res.status(403).json({
          error: 'Forbidden: Malformed Referer header.',
          code: 'CSRF_REFERER_INVALID',
        });
      }
    }
  }

  next();
}

