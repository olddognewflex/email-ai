import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function deriveKey(rawKey: string): Buffer {
  return crypto.createHash('sha256').update(rawKey).digest();
}

export function encrypt(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), encrypted.toString('base64'), tag.toString('base64')].join(':');
}

export function decrypt(ciphertext: string, rawKey: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivB64, encryptedB64, tagB64] = parts as [string, string, string];
  const key = deriveKey(rawKey);
  const iv = Buffer.from(ivB64, 'base64');
  const encryptedBuffer = Buffer.from(encryptedB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]).toString('utf8');
}
