import crypto from 'node:crypto';
import { Request } from 'express';
import { DatabaseRepository } from '../db/repository';
import { AuthRequest } from '../types';
import { hashSessionToken } from './tokens';
import { ReviewerPrincipalType } from '../../types';

export type ReviewerScope = 'evidence:review' | 'evidence:external_verify' | 'evidence:read';

export interface ReviewerServicePrincipalRecord {
  id: string;
  principalId: string;
  displayName: string;
  secretHash: string;
  keyId: string;
  scopes: string[];
  status: 'active' | 'revoked';
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthenticatedReviewerPrincipal {
  reviewerId: string;
  reviewerRole: 'platform_reviewer';
  principalType: Extract<ReviewerPrincipalType, 'human_reviewer' | 'service_principal'>;
  authMethod: 'reviewer_session' | 'service_token_registry' | 'platform_service_secret';
  scopes: string[];
  keyId?: string;
  humanUserId?: string;
  /**
   * Caller-supplied X-AIXSHOP-Reviewer-Id header captured strictly as an untrusted audit diagnostic.
   * NEVER used as authoritative reviewer identity.
   */
  claimedReviewerId?: string;
}

export type ReviewerAuthFailureCode =
  | 'FORBIDDEN_REVIEWER_REQUIRED'
  | 'FORBIDDEN_REVIEWER_REVOKED'
  | 'FORBIDDEN_REVIEWER_EXPIRED'
  | 'FORBIDDEN_INSUFFICIENT_REVIEWER_SCOPE'
  | 'FORBIDDEN_SELF_REVIEW';

export interface ReviewerAuthResult {
  authorized: boolean;
  principal?: AuthenticatedReviewerPrincipal;
  errorCode?: ReviewerAuthFailureCode;
  errorMessage?: string;
}

interface EnvServicePrincipalEntry {
  principalId: string;
  keyId: string;
  secretDigest: Buffer;
  scopes: string[];
  revoked: boolean;
  expiresAt?: string;
}

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function sha256Buffer(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function constantTimeSecretDigestMatch(expectedDigestHexOrBuf: string | Buffer, providedSecret: string): boolean {
  if (!providedSecret) return false;
  const providedBuf = sha256Buffer(providedSecret);
  const expectedBuf =
    typeof expectedDigestHexOrBuf === 'string'
      ? Buffer.from(expectedDigestHexOrBuf, 'hex')
      : expectedDigestHexOrBuf;
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function parseRevokedKeyIdsFromEnv(): Set<string> {
  const raw = process.env.AIXSHOP_PLATFORM_REVIEWER_REVOKED_KEY_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function loadEnvConfiguredServicePrincipals(): EnvServicePrincipalEntry[] {
  const entries: EnvServicePrincipalEntry[] = [];
  const revokedKeyIds = parseRevokedKeyIdsFromEnv();

  const jsonRaw = process.env.AIXSHOP_REVIEWER_SERVICE_PRINCIPALS_JSON?.trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const principalId = typeof item.principalId === 'string' ? item.principalId.trim() : '';
          const keyId = typeof item.keyId === 'string' ? item.keyId.trim() : principalId;
          const secret = typeof item.secret === 'string' ? item.secret.trim() : '';
          const secretHash = typeof item.secretHash === 'string' ? item.secretHash.trim().toLowerCase() : '';
          if (!principalId || !keyId) continue;

          let digest: Buffer | null = null;
          if (/^[a-f0-9]{64}$/i.test(secretHash)) {
            digest = Buffer.from(secretHash, 'hex');
          } else if (secret.length >= 32) {
            digest = sha256Buffer(secret);
          }
          if (!digest) continue;

          const scopes = Array.isArray(item.scopes)
            ? item.scopes.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
            : ['evidence:review', 'evidence:external_verify'];
          const revoked =
            item.status === 'revoked' ||
            Boolean(item.revokedAt) ||
            revokedKeyIds.has(keyId);

          entries.push({
            principalId,
            keyId,
            secretDigest: digest,
            scopes,
            revoked,
            expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : undefined,
          });
        }
      }
    } catch {
      // Ignore malformed JSON without falling back silently to permissive defaults
    }
  }

  // Legacy shared secret acts strictly as an authentication credential for a single server-defined
  // service principal (never as proof of a human identity and never trusting X-AIXSHOP-Reviewer-Id).
  const legacySecret = process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET?.trim() || '';
  if (legacySecret.length >= 32) {
    const keyId = process.env.AIXSHOP_PLATFORM_REVIEWER_KEY_ID?.trim() || 'default_v1';
    entries.push({
      principalId: process.env.AIXSHOP_PLATFORM_REVIEWER_PRINCIPAL_ID?.trim() || 'platform-compliance-reviewer',
      keyId,
      secretDigest: sha256Buffer(legacySecret),
      scopes: ['evidence:review', 'evidence:external_verify'],
      revoked: revokedKeyIds.has(keyId),
    });
  }

  return entries;
}

function hasRequiredScope(scopes: string[], requiredScope: ReviewerScope): boolean {
  if (scopes.includes('*') || scopes.includes(requiredScope)) return true;
  if (requiredScope === 'evidence:external_verify' && scopes.includes('evidence:review')) {
    return true;
  }
  return false;
}

async function resolveHumanReviewerFromToken(
  repo: DatabaseRepository,
  sessionToken: string,
  requiredScope: ReviewerScope,
  claimedReviewerId: string | undefined,
  evidenceSubmittedByUserId?: string
): Promise<ReviewerAuthResult | null> {
  const tokenHash = hashSessionToken(sessionToken);
  const session = await repo.getSessionByTokenHash(tokenHash);
  if (!session) return null;

  const expiresAtDate = new Date(session.expiresAt);
  if (isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
    return null;
  }

  const user = await repo.getUserById(session.userId);
  if (!user) return null;

  const grant = await repo.getPlatformReviewerGrant(user.id);
  const envAllowList = (process.env.AIXSHOP_PLATFORM_REVIEWER_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isEnvGranted = envAllowList.includes(user.id);
  const isDbGranted = grant?.platformRole === 'platform_reviewer';

  if (!isDbGranted && !isEnvGranted) {
    return null;
  }

  if (grant?.revokedAt) {
    return {
      authorized: false,
      errorCode: 'FORBIDDEN_REVIEWER_REVOKED',
      errorMessage: 'Forbidden: reviewer authorization has been revoked.',
    };
  }

  const scopes =
    grant?.scopes && grant.scopes.length > 0
      ? grant.scopes
      : isEnvGranted
      ? ['evidence:review', 'evidence:external_verify']
      : [];

  if (!hasRequiredScope(scopes, requiredScope)) {
    return {
      authorized: false,
      errorCode: 'FORBIDDEN_INSUFFICIENT_REVIEWER_SCOPE',
      errorMessage: `Forbidden: reviewer account lacks required scope "${requiredScope}".`,
    };
  }

  if (evidenceSubmittedByUserId && evidenceSubmittedByUserId === user.id) {
    return {
      authorized: false,
      errorCode: 'FORBIDDEN_SELF_REVIEW',
      errorMessage: 'Forbidden: a reviewer cannot approve or verify evidence they submitted.',
    };
  }

  return {
    authorized: true,
    principal: {
      reviewerId: `user:${user.id}`,
      reviewerRole: 'platform_reviewer',
      principalType: 'human_reviewer',
      authMethod: 'reviewer_session',
      scopes,
      humanUserId: user.id,
      claimedReviewerId,
    },
  };
}

/**
 * Establishes a server-authoritative reviewer principal from either:
 * 1. A cryptographically verified service credential (`X-AIXSHOP-Reviewer-Token`) mapped to a
 *    server-managed service principal (DB or server env configuration); OR
 * 2. An authenticated human reviewer session (`X-AIXSHOP-Reviewer-Session` or `req.user` session)
 *    holding an active server-assigned `platform_reviewer` grant and required permission scope.
 *
 * `X-AIXSHOP-Reviewer-Id` is NEVER trusted as authoritative identity.
 */
export async function authenticateReviewerPrincipal(
  repo: DatabaseRepository,
  req: AuthRequest | Request,
  options: {
    requiredScope?: ReviewerScope;
    evidenceSubmittedByUserId?: string;
  } = {}
): Promise<ReviewerAuthResult> {
  const requiredScope: ReviewerScope = options.requiredScope || 'evidence:review';
  const rawClaimedHeader = String(req.headers['x-aixshop-reviewer-id'] || '').trim();
  const claimedReviewerId = rawClaimedHeader || undefined;

  const providedServiceToken = String(req.headers['x-aixshop-reviewer-token'] || '').trim();
  const providedReviewerSession = String(req.headers['x-aixshop-reviewer-session'] || '').trim();

  // 1. Dedicated human reviewer session header (when workspace call and reviewer session are distinct)
  if (providedReviewerSession) {
    const humanRes = await resolveHumanReviewerFromToken(
      repo,
      providedReviewerSession,
      requiredScope,
      claimedReviewerId,
      options.evidenceSubmittedByUserId
    );
    if (humanRes) return humanRes;
    return {
      authorized: false,
      errorCode: 'FORBIDDEN_REVIEWER_REQUIRED',
      errorMessage:
        'Forbidden: provided reviewer session is invalid, expired, or lacks platform reviewer authorization.',
    };
  }

  // 2. Service-to-service credential (`X-AIXSHOP-Reviewer-Token`)
  if (providedServiceToken) {
    const dbPrincipals = await repo.listReviewerServicePrincipals();
    const envPrincipals = loadEnvConfiguredServicePrincipals();

    let matchedDbPrincipal: ReviewerServicePrincipalRecord | null = null;
    for (const p of dbPrincipals) {
      if (constantTimeSecretDigestMatch(p.secretHash, providedServiceToken)) {
        matchedDbPrincipal = p;
      }
    }

    if (matchedDbPrincipal) {
      if (matchedDbPrincipal.status === 'revoked' || Boolean(matchedDbPrincipal.revokedAt)) {
        return {
          authorized: false,
          errorCode: 'FORBIDDEN_REVIEWER_REVOKED',
          errorMessage: 'Forbidden: reviewer service credential has been revoked.',
        };
      }
      if (matchedDbPrincipal.expiresAt) {
        const expMs = new Date(matchedDbPrincipal.expiresAt).getTime();
        if (isNaN(expMs) || expMs <= Date.now()) {
          return {
            authorized: false,
            errorCode: 'FORBIDDEN_REVIEWER_EXPIRED',
            errorMessage: 'Forbidden: reviewer service credential has expired.',
          };
        }
      }
      if (!hasRequiredScope(matchedDbPrincipal.scopes || [], requiredScope)) {
        return {
          authorized: false,
          errorCode: 'FORBIDDEN_INSUFFICIENT_REVIEWER_SCOPE',
          errorMessage: `Forbidden: service principal lacks required scope "${requiredScope}".`,
        };
      }

      return {
        authorized: true,
        principal: {
          reviewerId: `service:${matchedDbPrincipal.principalId}`,
          reviewerRole: 'platform_reviewer',
          principalType: 'service_principal',
          authMethod: 'service_token_registry',
          scopes: [...matchedDbPrincipal.scopes],
          keyId: matchedDbPrincipal.keyId,
          claimedReviewerId,
        },
      };
    }

    let matchedEnvPrincipal: EnvServicePrincipalEntry | null = null;
    for (const p of envPrincipals) {
      if (constantTimeSecretDigestMatch(p.secretDigest, providedServiceToken)) {
        matchedEnvPrincipal = p;
      }
    }

    if (matchedEnvPrincipal) {
      if (matchedEnvPrincipal.revoked) {
        return {
          authorized: false,
          errorCode: 'FORBIDDEN_REVIEWER_REVOKED',
          errorMessage: 'Forbidden: reviewer service credential has been revoked.',
        };
      }
      if (matchedEnvPrincipal.expiresAt) {
        const expMs = new Date(matchedEnvPrincipal.expiresAt).getTime();
        if (isNaN(expMs) || expMs <= Date.now()) {
          return {
            authorized: false,
            errorCode: 'FORBIDDEN_REVIEWER_EXPIRED',
            errorMessage: 'Forbidden: reviewer service credential has expired.',
          };
        }
      }
      if (!hasRequiredScope(matchedEnvPrincipal.scopes, requiredScope)) {
        return {
          authorized: false,
          errorCode: 'FORBIDDEN_INSUFFICIENT_REVIEWER_SCOPE',
          errorMessage: `Forbidden: service principal lacks required scope "${requiredScope}".`,
        };
      }

      return {
        authorized: true,
        principal: {
          reviewerId: `service:${matchedEnvPrincipal.principalId}`,
          reviewerRole: 'platform_reviewer',
          principalType: 'service_principal',
          authMethod: 'platform_service_secret',
          scopes: [...matchedEnvPrincipal.scopes],
          keyId: matchedEnvPrincipal.keyId,
          claimedReviewerId,
        },
      };
    }

    return {
      authorized: false,
      errorCode: 'FORBIDDEN_REVIEWER_REQUIRED',
      errorMessage:
        'Forbidden: invalid or unrecognized reviewer service credential.',
    };
  }

  // 3. Authenticated caller session (only if user account has server-assigned platform_reviewer role)
  const authReq = req as AuthRequest;
  if (authReq.user?.id) {
    let rawBearerOrCookie: string | undefined = (req as any).cookies?.aixshop_session;
    const authHeader = req.headers.authorization;
    if (!rawBearerOrCookie && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      rawBearerOrCookie = authHeader.substring(7).trim();
    }
    if (rawBearerOrCookie) {
      const humanRes = await resolveHumanReviewerFromToken(
        repo,
        rawBearerOrCookie,
        requiredScope,
        claimedReviewerId,
        options.evidenceSubmittedByUserId
      );
      if (humanRes) return humanRes;
    }
  }

  return {
    authorized: false,
    errorCode: 'FORBIDDEN_REVIEWER_REQUIRED',
    errorMessage:
      'Forbidden: workspace users cannot self-approve or modify evidence verification status. A server-authorized platform reviewer credential or reviewer account is required.',
  };
}

export function hashReviewerServiceSecret(secret: string): string {
  return sha256Hex(secret);
}
