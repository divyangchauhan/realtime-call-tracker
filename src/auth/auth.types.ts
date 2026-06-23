import { Request } from 'express';

/**
 * Subset of ApiKey entity fields attached to the request after successful authentication.
 * PR #5's rate-limiter reads maxConcurrent and maxCps from this object
 * without an extra DB round-trip.
 */
export interface RequestApiKey {
  id: string;
  name: string;
  maxConcurrent: number;
  maxCps: number;
}

/**
 * Express Request extended with the authenticated API key payload.
 * Set by ApiKeyAuthGuard on every successfully authenticated request.
 */
export type AuthenticatedRequest = Request & { apiKey?: RequestApiKey };
