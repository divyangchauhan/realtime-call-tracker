import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CallStatus } from '../database/entities/call-status.enum';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * Live representation of a call stored as a Redis hash.
 *
 * CONTRACT — later PRs depend on this shape:
 * - PR #5 reads `apiKeyId` + `status` for rate-limit accounting.
 * - PR #6 reads/writes `status` when driving the state machine.
 * - PR #7 publishes state-change events keyed by `id`.
 * - PR #8/#9 writes `recordingUrl` after the worker completes.
 *
 * Timestamps are ISO 8601 strings (UTC) so they are safe to round-trip
 * through Redis hash fields without any Date serialization surprises.
 */
export interface CallState {
  id: string;
  apiKeyId: string;
  from: string;
  to: string;
  status: CallStatus;
  /** Arbitrary JSON blob supplied by the caller. Null when not provided. */
  metadata: Record<string, unknown> | null;
  /** S3 URL written by the recording worker (PR #8/#9). Null until then. */
  recordingUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Redis key for a given call ID. */
function callKey(id: string): string {
  return `call:${id}`;
}

/**
 * Thin store that wraps Redis hash operations for live call state.
 *
 * Why a separate Redis representation alongside Postgres?
 * - Sub-millisecond reads for the hot GET /calls/:id path.
 * - The WebSocket gateway (PR #7) fans out state-change events via pub/sub;
 *   having the state in Redis makes atomic read-modify-publish easy.
 * - The TTL guarantees stale hashes are cleaned up automatically, unlike
 *   Postgres rows which are retained for billing/audit.
 */
@Injectable()
export class CallStateStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Write (or overwrite) all fields of the call state hash and set a TTL.
   * Uses a pipeline so the HSET + EXPIRE are sent in a single round-trip.
   */
  async write(state: CallState, ttlSeconds: number): Promise<void> {
    const key = callKey(state.id);

    // Serialize metadata as a JSON string; Redis hashes only store strings.
    // An empty string represents null so we can distinguish "not set" from
    // a genuine empty object without an extra field.
    const metadataStr = state.metadata !== null ? JSON.stringify(state.metadata) : '';
    const recordingUrlStr = state.recordingUrl ?? '';

    const pipeline = this.redis.pipeline();
    pipeline.hset(key, {
      id: state.id,
      apiKeyId: state.apiKeyId,
      from: state.from,
      to: state.to,
      status: state.status,
      metadata: metadataStr,
      recordingUrl: recordingUrlStr,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
    pipeline.expire(key, ttlSeconds);

    // ioredis resolves pipeline.exec() with an array of [error, result] tuples
    // and does NOT reject when individual commands fail (e.g. Redis is down).
    // Surface the first command error so the caller's best-effort
    // log-and-continue path runs instead of silently assuming success.
    const results = await pipeline.exec();
    const firstError = results?.find(([err]) => err)?.[0];
    if (firstError) {
      throw firstError;
    }
  }

  /**
   * Write-behind status update: set only `status` + `updatedAt` on the existing
   * hash and refresh the TTL.
   *
   * This is the hot path called by the progression engine on every state
   * transition.  We intentionally touch only two fields so the operation is
   * cheap and does NOT require reading the full state first.
   *
   * The TTL is refreshed with every transition so an active call's hash does
   * not expire while it is still progressing.
   *
   * Uses a pipeline (HSET + EXPIRE) identical to write() so error surfacing
   * follows the same pattern — the caller should treat failures as best-effort.
   */
  async updateStatus(
    id: string,
    status: CallStatus,
    updatedAt: string,
    ttlSeconds: number,
  ): Promise<void> {
    const key = callKey(id);

    const pipeline = this.redis.pipeline();
    pipeline.hset(key, { status, updatedAt });
    pipeline.expire(key, ttlSeconds);

    const results = await pipeline.exec();
    const firstError = results?.find(([err]) => err)?.[0];
    if (firstError) {
      throw firstError;
    }
  }

  /**
   * Read the call state from Redis.
   * Returns null when the key does not exist or has expired.
   */
  async read(id: string): Promise<CallState | null> {
    const raw = await this.redis.hgetall(callKey(id));

    // hgetall returns {} when the key is missing.
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    // Guard against a PARTIAL hash. The write-behind updateStatus() path does a
    // blind HSET of just status+updatedAt; if it ever runs against a key whose
    // full write() never landed (e.g. Redis was down at create time and only
    // recovered before the first progression transition), Redis materialises a
    // skeleton hash with only those two fields. Trusting it would yield an empty
    // apiKeyId and make GET /calls/:id 404 instead of falling back to Postgres.
    // Treat any hash missing its identifying fields as a cache miss so the
    // durable Postgres copy serves the request.
    if (!raw['id'] || !raw['apiKeyId']) {
      return null;
    }

    // Deserialize: empty metadata string → null; empty recordingUrl → null.
    const metadata: Record<string, unknown> | null = raw['metadata']
      ? (JSON.parse(raw['metadata']) as Record<string, unknown>)
      : null;
    const recordingUrl: string | null = raw['recordingUrl'] || null;

    return {
      id: raw['id'] ?? id,
      apiKeyId: raw['apiKeyId'] ?? '',
      from: raw['from'] ?? '',
      to: raw['to'] ?? '',
      status: (raw['status'] as CallStatus) ?? CallStatus.QUEUED,
      metadata,
      recordingUrl,
      createdAt: raw['createdAt'] ?? '',
      updatedAt: raw['updatedAt'] ?? '',
    };
  }
}
