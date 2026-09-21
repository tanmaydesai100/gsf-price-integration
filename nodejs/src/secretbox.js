/**
 * The cookie jar is a live credential, so it is encrypted at rest exactly as
 * Laravel's Crypt:: does it. AES-256-GCM: tampering fails the auth tag, so a
 * corrupted or edited cache entry is rejected rather than half-trusted.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { config } from './config.js';
import { GsfError } from './errors.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Throws unless a key is configured. Call this before doing any work. */
export function assertKeyConfigured() {
  if (!config.appKey) {
    throw new GsfError(
      'GSF_APP_KEY is not set. It encrypts the cached session cookie. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
}

const key = () => {
  assertKeyConfigured();
  return createHash('sha256').update(config.appKey).digest();
};

export function encrypt(plain) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
