import { CallStatus } from '../../database/entities/call-status.enum';

/**
 * Per-status call counts, scoped to a single API key.
 * Every CallStatus key is always present (zero-filled) even when the key has
 * never had a call in that status — consumers should not need to guard
 * against missing keys.
 */
export type CallCountsByStatus = Record<CallStatus, number>;

/**
 * Snake-case JSON shape returned by GET /metrics.
 * Mirrors the snake_case + mapper-function convention used by CallResponse
 * (see ../../calls/dto/call-response.dto.ts).
 */
export interface MetricsResponse {
  api_key_id: string;
  calls: {
    total: number;
    by_status: CallCountsByStatus;
    with_recording: number;
  };
  live: {
    active_calls: number;
  };
  limits: {
    max_concurrent: number;
    max_cps: number;
  };
  generated_at: string;
}

/**
 * Build a zero-filled CallCountsByStatus map so every CallStatus is present
 * with a default of 0. The caller then overlays the actual per-status counts
 * from the raw query results. Kept as a small helper so MetricsService does
 * not need to repeat the Object.values(CallStatus) zero-fill logic inline.
 */
export function zeroFilledStatusCounts(): CallCountsByStatus {
  const counts = {} as CallCountsByStatus;
  for (const status of Object.values(CallStatus)) {
    counts[status] = 0;
  }
  return counts;
}
