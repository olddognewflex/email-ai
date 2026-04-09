import { decrypt, encrypt } from './crypto.util';

const KEY = 'test-key-for-unit-tests';

describe('crypto.util', () => {
  it('roundtrips a plaintext value', () => {
    const plaintext = 'super-secret-imap-password';
    const ciphertext = encrypt(plaintext, KEY);
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext each call', () => {
    const plaintext = 'same-value';
    expect(encrypt(plaintext, KEY)).not.toBe(encrypt(plaintext, KEY));
  });

  it('throws when ciphertext is tampered', () => {
    const ciphertext = encrypt('value', KEY);
    const [iv, enc, tag] = ciphertext.split(':');
    const encBytes = Buffer.from(enc, 'base64');
    encBytes[0] ^= 0xff;
    const tampered = [iv, encBytes.toString('base64'), tag].join(':');
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it('throws on malformed ciphertext', () => {
    expect(() => decrypt('not-valid', KEY)).toThrow('Invalid ciphertext format');
  });
});
