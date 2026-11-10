import crypto from 'node:crypto';

/**
 * Resolves the 32-byte AES-256 encryption key from the environment.
 * Accepts 64-character hex, 44-character base64, or exact 32-byte string.
 * Fails safely if missing or invalid — NEVER falls back to plaintext storage.
 */
export function getEncryptionKey(customKey?: string): Buffer {
  const rawKey = customKey || process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;

  if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error(
      '[AIXSHOP Security Error] SHOPIFY_TOKEN_ENCRYPTION_KEY environment secret is not configured. ' +
      'Plaintext fallback is strictly prohibited for Shopify merchant credentials.'
    );
  }

  const trimmed = rawKey.trim();

  // Try 64-character hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Try base64 32 bytes
  try {
    const b64Buf = Buffer.from(trimmed, 'base64');
    if (b64Buf.length === 32) {
      return b64Buf;
    }
  } catch {
    // not valid base64
  }

  // Try exact 32-byte UTF-8 string
  const utf8Buf = Buffer.from(trimmed, 'utf8');
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  throw new Error(
    `[AIXSHOP Security Error] Invalid SHOPIFY_TOKEN_ENCRYPTION_KEY length: got ${utf8Buf.length} bytes, expected exactly 32 bytes (256 bits). Provide 64 hex characters or 32 raw bytes.`
  );
}

export interface EncryptedData {
  encryptedString: string;
  version: string;
}

/**
 * Encrypts sensitive merchant credentials at rest using AES-256-GCM authenticated encryption.
 * Output format: "v1:<iv_hex>:<authTag_hex>:<cipher_hex>"
 */
export function encryptCredential(plaintext: string, customKey?: string): string {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Credential plaintext cannot be empty.');
  }

  const key = getEncryptionKey(customKey);
  const iv = crypto.randomBytes(12); // Recommended 12 bytes (96 bits) for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext}`;
}

/**
 * Decrypts AES-256-GCM ciphertext.
 * Verifies authenticated auth tag to guarantee ciphertext integrity and authenticity.
 */
export function decryptCredential(encryptedPayload: string, customKey?: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('Encrypted payload is missing or invalid.');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported or corrupted encrypted credential format.');
  }

  const [, ivHex, tagHex, cipherHex] = parts;
  const key = getEncryptionKey(customKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Timing-safe HMAC verification against timing side-channel attacks.
 */
export function verifyHmacSha256(
  data: string | Buffer,
  secret: string,
  expectedHmacHex: string
): boolean {
  if (!data || !secret || !expectedHmacHex) return false;

  try {
    const computed = crypto.createHmac('sha256', secret).update(data).digest('hex');
    const computedBuf = Buffer.from(computed, 'hex');
    const expectedBuf = Buffer.from(expectedHmacHex, 'hex');

    if (computedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Verifies Shopify Base64 HMAC (used in Shopify webhooks).
 */
export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  secret: string,
  expectedBase64Hmac: string
): boolean {
  if (!rawBody || !secret || !expectedBase64Hmac) return false;

  try {
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const computedBuf = Buffer.from(computed, 'utf8');
    const expectedBuf = Buffer.from(expectedBase64Hmac, 'utf8');

    if (computedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuf, expectedBuf);
  } catch {
    return false;
  }
}
