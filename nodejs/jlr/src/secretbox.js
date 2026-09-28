/**
 * The cached JLR session holds a refresh token - a live credential - so it
 * is encrypted at rest. AES-256-GCM: an edited or corrupted entry fails the
 * auth tag and is discarded, which just means a fresh login.
 *
 * Key: JLR_APP_KEY, or GSF_APP_KEY when that is already set for GSF.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { config } from './config.js';
import { JlrError } from './errors.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

const key = () => {
  if (!config.appKey) {
    throw new JlrError(
      'JLR_APP_KEY (or GSF_APP_KEY) is not set. It encrypts the cached JLR session. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return createHash('sha256').update(config.appKey).digest();
};

export function seal(value) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The value, or null when the payload was sealed with another key or edited. */
export function open(payload) {
  try {
    const raw = Buffer.from(String(payload), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    if (error instanceof JlrError) throw error;
    return null;
  }
}
