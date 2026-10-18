import crypto from 'crypto';

/**
 * Generates an unguessable 256-bit cryptographic session token (hex encoded, 64 chars).
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hashes a raw session token using SHA-256 for secure database storage.
 * Prevents session token theft in the event of database snapshot disclosure.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
