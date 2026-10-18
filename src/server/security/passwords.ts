import crypto from 'crypto';

const KEY_LENGTH = 64;

/**
 * Hashes a plaintext password using crypto.scrypt with a random 16-byte salt.
 * Format: `<saltHex>:<derivedKeyHex>`
 */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Securely verifies a plaintext password against a stored scrypt hash using timingSafeEqual.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = storedHash.split(':');
    if (parts.length !== 2) {
      return resolve(false);
    }
    const [salt, keyHex] = parts;
    const expectedKey = Buffer.from(keyHex, 'hex');

    crypto.scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return resolve(false);
      try {
        const matches = crypto.timingSafeEqual(expectedKey, derivedKey);
        resolve(matches);
      } catch {
        resolve(false);
      }
    });
  });
}
