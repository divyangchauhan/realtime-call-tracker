import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { IsNull, Not, Repository } from 'typeorm';
import { RequestApiKey } from '../auth/auth.types';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { MetricsResponse, zeroFilledStatusCounts } from './dto/metrics-response.dto';

/** Raw row shape returned by the `status` / `COUNT(*)` group-by query. */
interface StatusCountRow {
  status: CallStatus;
  count: string;
}

/**
 * Business logic backing GET /metrics.
 *
 * Produces a per-API-key operational snapshot combining:
 *  - Postgres: durable call counts by status, and recordings-present count.
 *  - Redis: a best-effort live concurrency reading (the rate limiter's
 *    active-calls SET cardinality).
 *  - The caller's own RequestApiKey: its configured limits, with no DB
 *    round-trip needed since ApiKeyAuthGuard already attached them to the
 *    request.
 *
 * Every count is scoped to `apiKey.id` — this service must never aggregate
 * across API keys, since /metrics is multi-tenant and each key's snapshot is
 * only ever shown to that key's own caller (see MetricsController).
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Assemble the full metrics snapshot for the given API key.
   *
   * The Postgres-backed reads (by-status counts, recordings count) are
   * treated as load-bearing — if they fail, the request fails, since they are
   * the durable source of truth and a silent zero would be misleading.
   *
   * The Redis-backed read (live active-call concurrency) is best-effort and
   * mirrors RateLimiterService's fail-open philosophy: if Redis is
   * unreachable or the SCARD call errors out, we log a warning and degrade
   * `live.active_calls` to 0 rather than failing the whole metrics request.
   * Operational metrics should stay available even during a Redis outage —
   * the rest of the snapshot (durable Postgres counts, key limits) is still
   * useful on its own.
   */
  async getMetrics(apiKey: RequestApiKey): Promise<MetricsResponse> {
    const [byStatus, withRecording, activeCalls] = await Promise.all([
      this.countByStatus(apiKey.id),
      this.countWithRecording(apiKey.id),
      this.readActiveCalls(apiKey.id),
    ]);

    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);

    return {
      api_key_id: apiKey.id,
      calls: {
        total,
        by_status: byStatus,
        with_recording: withRecording,
      },
      live: {
        active_calls: activeCalls,
      },
      limits: {
        max_concurrent: apiKey.maxConcurrent,
        max_cps: apiKey.maxCps,
      },
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Count this key's calls grouped by status, zero-filled so every CallStatus
   * is always present in the result (even if the key has zero calls in that
   * status, or zero calls at all).
   *
   * Postgres returns COUNT(*) as a bigint, which the pg driver/TypeORM
   * surfaces as a string via getRawMany() — each row's `count` is parsed back
   * to a number before being placed in the response.
   */
  private async countByStatus(apiKeyId: string): Promise<Record<CallStatus, number>> {
    const rows = await this.callRepo
      .createQueryBuilder('call')
      .select('call.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('call.api_key_id = :apiKeyId', { apiKeyId })
      .groupBy('call.status')
      .getRawMany<StatusCountRow>();

    const counts = zeroFilledStatusCounts();
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  /** Count this key's calls that have a non-null recording_url. */
  private async countWithRecording(apiKeyId: string): Promise<number> {
    return this.callRepo.count({
      where: { apiKeyId, recordingUrl: Not(IsNull()) },
    });
  }

  /**
   * Read the current live concurrency for this key via SCARD on the
   * rate limiter's `active_calls:{apiKeyId}` SET (see RateLimiterService's
   * activeCallsKey()).
   *
   * Best-effort / fail-open: if Redis is unreachable or errors, log a warning
   * and degrade to 0 rather than failing the whole /metrics request. This
   * matches RateLimiterService.acquire()'s fail-open policy — a metrics read
   * is even less critical than a rate-limit gate, so it must never block the
   * response.
   */
  private async readActiveCalls(apiKeyId: string): Promise<number> {
    try {
      return await this.redis.scard(`active_calls:${apiKeyId}`);
    } catch (err) {
      this.logger.warn(
        `Failed to read active-calls concurrency from Redis — degrading to 0 (apiKeyId=${apiKeyId}). ` +
          `Error: ${String(err)}`,
      );
      return 0;
    }
  }
}
