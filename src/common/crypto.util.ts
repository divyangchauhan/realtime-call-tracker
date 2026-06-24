import { createHash } from 'crypto';

/**
 * Returns the lowercase hex SHA-256 digest of a raw API key string.
 *
 * Used by the seed script to store the hashed key in api_keys.key_hash.
 * The auth guard re-uses this same function to hash the incoming Bearer token
 * before doing a DB lookup, so the raw key never has to be stored.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
