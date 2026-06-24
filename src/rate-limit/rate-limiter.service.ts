import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Configuration } from '../config/configuration';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RATE_LIMIT_ACQUIRE_LUA } from './rate-limit.lua';

/**
 * ioredis does not expose a generic typed interface for custom commands defined
 * via defineCommand().  We extend the Redis class interface locally so we can
 * call this.redis.rateLimitAcquire(...) with full type safety and without
 * casting to `any` at each call site.
 *
 * The cast `this.redis as RedisWithRateLimitAcquire` is done ONCE in acquire().
 */
interface RedisWithRateLimitAcquire extends Redis {
  /**
   * Custom command registered via defineCommand('rateLimitAcquire', ...).
   *
   * Arguments mirror the Lua ARGV array (all converted to strings by ioredis):
   *   maxConcurrent, maxCps, nowMs, windowMs, callId, setTtlSeconds
   *
   * Returns a 2-tuple: [status, reason]
   *   [1, 'OK']           - both limits satisfied
   *   [0, 'CPS']          - CPS window full
   *   [0, 'CONCURRENCY']  - active-calls SET full
   */
  rateLimitAcquire(
    activeKey: string,
    cpsKey: string,
    maxConcurrent: number,
    maxCps: number,
    nowMs: number,
    windowMs: number,
    callId: string,
    setTtlSeconds: number,
  ): Promise<[number, string]>;
}

/**
 * Result returned by RateLimiterService.acquire() to the caller.
 * Discriminated union so callers can narrow `reason` without a cast: when
 * `allowed` is false, `reason` is always 'CPS' | 'CONCURRENCY'.
 */
export type AcquireResult =
  | { allowed: true; reason: 'OK' }
  | { allowed: false; reason: 'CPS' | 'CONCURRENCY' };

/**
 * Performs atomic per-API-key rate limiting using a Redis Lua script.
 *
 * Two limits are enforced simultaneously in a single round-trip:
 *  1. Concurrency - at most apiKey.maxConcurrent in-flight calls
 *                   (tracked in SET active_calls:{apiKeyId}).
 *  2. CPS         - at most apiKey.maxCps call-creates per rolling 1-second
 *                   window (tracked in ZSET cps:{apiKeyId}).
 *
 * The Lua script is loaded once on module init via defineCommand() so all
 * subsequent calls are a single EVALSHA round-trip (ioredis handles the
 * EVALSHA→EVAL fallback on cache miss automatically).
 *
 * Fail-open policy:
 *   If Redis is unavailable the Lua call throws.  We catch it, log a warning,
 *   and return { allowed: true }.  Rationale: rate limiting is a protective
 *   measure, not a correctness gate.  Postgres remains the source of truth for
 *   call data.  Prioritising availability over the rate-limit check means
 *   callers are not penalised during a Redis outage.  The fail-fast client
 *   (maxRetriesPerRequest: 3, commandTimeout: 2000 ms) guarantees this throw
 *   is quick - at most ~2 s - rather than a hang.
 */
@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(RateLimiterService.name);

  /**
   * Rolling window width for CPS tracking.
   * Hardcoded to 1000 ms (1 second) - the Lua script always uses this value.
   */
  private readonly windowMs = 1000;

  /** Safety TTL on the active-calls SET. Mirrors CALL_STATE_TTL_SECONDS. */
  private readonly setTtlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<Configuration, true>,
  ) {
    this.setTtlSeconds = this.config.get('call', { infer: true }).stateTtlSeconds;
  }

  /**
   * Register the Lua script with ioredis on module startup.
   *
   * defineCommand() caches the script SHA on the client so subsequent calls
   * use EVALSHA instead of EVAL.  ioredis automatically re-sends EVAL when
   * Redis reports NOSCRIPT (e.g. after a server restart), so we never need to
   * call defineCommand() more than once per client lifetime.
   */
  onModuleInit(): void {
    this.redis.defineCommand('rateLimitAcquire', {
      numberOfKeys: 2,
      lua: RATE_LIMIT_ACQUIRE_LUA,
    });

    this.logger.log('Lua rate-limit script registered (rateLimitAcquire)');
  }

  /**
   * Attempt to acquire a rate-limit slot for the given API key and call.
   *
   * This must be called BEFORE the Postgres persist so that rejected calls
   * never create DB rows or ancillary Redis state.
   *
   * @param apiKeyId     The API key identifier (used to scope Redis keys).
   * @param callId       Pre-generated UUID that will become the DB primary key
   *                     and the SET/ZSET member if the call is allowed.
   * @param maxConcurrent Maximum simultaneous in-flight calls for this key.
   * @param maxCps       Maximum call-creates per rolling 1-second window.
   * @returns            { allowed: true, reason: 'OK' } on success;
   *                     { allowed: false, reason: 'CPS' | 'CONCURRENCY' } on rejection.
   */
  async acquire(
    apiKeyId: string,
    callId: string,
    maxConcurrent: number,
    maxCps: number,
  ): Promise<AcquireResult> {
    // Key names must match the Lua script documentation in rate-limit.lua.ts.
    const activeKey = this.activeCallsKey(apiKeyId);
    const cpsKey = `cps:${apiKeyId}`;
    const nowMs = Date.now();

    try {
      // Cast once - the custom command is registered by onModuleInit().
      const [status, reason] = await (this.redis as RedisWithRateLimitAcquire).rateLimitAcquire(
        activeKey,
        cpsKey,
        maxConcurrent,
        maxCps,
        nowMs,
        this.windowMs,
        callId,
        this.setTtlSeconds,
      );

      if (status === 1) {
        return { allowed: true, reason: 'OK' };
      }

      // reason is 'CPS' or 'CONCURRENCY' per the Lua script contract.
      return { allowed: false, reason: reason as 'CPS' | 'CONCURRENCY' };
    } catch (err) {
      // Fail-open: Redis is down or timed out.  Log a warning and allow the
      // call through so callers are not penalised during a Redis outage.
      // The fail-fast client settings guarantee this path is reached quickly
      // rather than after a long hang.
      this.logger.warn(
        `Rate-limit Lua command failed - failing open (callId=${callId}, apiKeyId=${apiKeyId}). ` +
          `Error: ${String(err)}`,
      );
      return { allowed: true, reason: 'OK' };
    }
  }

  /**
   * Release a previously-acquired concurrency slot by removing the call ID from
   * the active-calls SET.
   *
   * Best-effort: a failure here only risks the slot lingering until the safety
   * TTL on the SET, so we log and swallow rather than propagate.
   *
   * Callers:
   *  - CallsService.createCall - compensating action if the Postgres persist
   *    throws AFTER a slot was reserved, so a failed create does not leak a slot.
   *  - CallProgressionService - when a call reaches its terminal COMPLETED state.
   *
   * The CPS ZSET is intentionally NOT touched: it self-expires within the
   * 1-second window and only counts creates-per-second, not in-flight calls.
   */
  async release(apiKeyId: string, callId: string): Promise<void> {
    try {
      await this.redis.srem(this.activeCallsKey(apiKeyId), callId);
    } catch (err) {
      this.logger.warn(
        `Failed to release concurrency slot (callId=${callId}, apiKeyId=${apiKeyId}) - ` +
          `it will clear with the SET safety TTL. Error: ${String(err)}`,
      );
    }
  }

  /** Redis SET key holding the in-flight call IDs for an API key. */
  private activeCallsKey(apiKeyId: string): string {
    return `active_calls:${apiKeyId}`;
  }
}
