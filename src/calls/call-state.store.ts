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
 * Redis SET holding the IDs of calls whose Redis status is ahead of the
 * Postgres `calls.status` column (i.e. an intermediate write-behind
 * transition has not yet been reconciled to Postgres). A plain string — not
 * per-id formatted — since the set itself is the single shared key.
 *
 * CallProgressionService adds IDs here on every non-terminal transition;
 * CallFlushService (PR #10) periodically drains it, writing each ID's latest
 * status to Postgres and removing it on success.
 */
const DIRTY_SET_KEY = 'calls:dirty';

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
   * Write-behind recording URL update: set only `recordingUrl` + `updatedAt` on
   * the existing hash and refresh the TTL.
   *
   * Called by the BullMQ recording worker (PR #9) after a successful S3 upload.
   * We intentionally touch only two fields — not the full state — so the op is
   * cheap and does NOT require reading/re-writing the entire hash.
   *
   * Why this is best-effort from the worker's perspective:
   *   The durable source of truth for the recording URL is the Postgres `calls`
   *   row (written first, with throw-to-retry semantics).  The Redis hash is a
   *   read-through cache; if this update fails the next GET /calls/:id will fall
   *   back to Postgres and rebuild the cache automatically.  Failing the BullMQ
   *   job over a Redis cache miss would cause unnecessary retries and duplicate S3
   *   uploads, so the worker catches this method's rejection and logs it instead.
   *
   * Uses the same pipeline (HSET + EXPIRE) pattern as updateStatus() — see its
   * comment for the ioredis error-surfacing detail.
   */
  async updateRecordingUrl(
    id: string,
    recordingUrl: string,
    updatedAt: string,
    ttlSeconds: number,
  ): Promise<void> {
    const key = callKey(id);

    const pipeline = this.redis.pipeline();
    pipeline.hset(key, { recordingUrl, updatedAt });
    pipeline.expire(key, ttlSeconds);

    // Surface the first command error so the caller's catch block can log it.
    // ioredis resolves exec() with [error, result] tuples — it does NOT reject
    // on individual command failures, so we must inspect manually.
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

  /**
   * Mark a call as "dirty": its Redis status is ahead of the Postgres row.
   * Called by the progression engine after every non-terminal write-behind
   * transition so CallFlushService (PR #10) knows which IDs to reconcile.
   *
   * A single SADD — no pipeline needed.  Best-effort from the caller's
   * perspective: the caller should catch and log rather than let a failure
   * here break the state machine.
   */
  async markDirty(id: string): Promise<void> {
    await this.redis.sadd(DIRTY_SET_KEY, id);
  }

  /**
   * Read every call ID currently marked dirty.
   * Returns an empty array when the set does not exist or is empty.
   */
  async readDirtyIds(): Promise<string[]> {
    return this.redis.smembers(DIRTY_SET_KEY);
  }

  /**
   * Clear a call's dirty marker once its status has been reconciled to
   * Postgres (or once reconciliation is no longer meaningful, e.g. the Redis
   * hash has already expired).
   */
  async clearDirty(id: string): Promise<void> {
    await this.redis.srem(DIRTY_SET_KEY, id);
  }
}
