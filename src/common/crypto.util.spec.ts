import { hashApiKey } from './crypto.util';

describe('hashApiKey', () => {
  // Known SHA-256 of "dev-secret-key" (verified with: echo -n "dev-secret-key" | sha256sum)
  const KNOWN_HASH = '0537dfd229ccd644e29c82f0c27a1b3b075a1589fa75a186ed40abc25bfcd248';

  it('returns the expected SHA-256 hex for a known input', () => {
    expect(hashApiKey('dev-secret-key')).toBe(KNOWN_HASH);
  });

  it('is deterministic — same input always yields same output', () => {
    expect(hashApiKey('dev-secret-key')).toBe(hashApiKey('dev-secret-key'));
  });

  it('returns a 64-character lowercase hex string', () => {
    const hash = hashApiKey('any-key-value');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'));
  });
});
