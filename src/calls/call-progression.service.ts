import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Configuration } from '../config/configuration';
import { CallStatus } from '../database/entities/call-status.enum';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CALL_EVENTS_CHANNEL } from './call-events.constants';
import { CallCompletionService } from './call-completion.service';
import { CallState, CallStateStore } from './call-state.store';
import { callResponseFromState } from './dto/call-response.dto';

/**
 * Background auto-progression engine for the call lifecycle.
 *
 * Drives each newly-created call through its full lifecycle on plain Node.js
 * `setTimeout` timers — no external scheduler dependency (@nestjs/schedule is
 * deliberately NOT used):
 *
 *   QUEUED ──[queuedToRingingMs]──► RINGING
 *   RINGING ──[ringingMs]──► ANSWERED (p = answerProbability)
 *                          └─► UNANSWERED (p = 1 − answerProbability)
 *   ANSWERED ──[answeredToCompletedMs]──► COMPLETED
 *   UNANSWERED ──[unansweredToCompletedMs]──► COMPLETED
 *
 * Write-behind semantics:
 *   Intermediate transitions update ONLY the Redis live-state hash (via
 *   CallStateStore.updateStatus).  Postgres is NOT touched for these in-flight
 *   transitions — the Postgres row stays at its initial QUEUED status until a
 *   later PR reconciles it.  Each non-terminal transition also marks the call
 *   ID dirty (CallStateStore.markDirty) so PR #10's CallFlushService knows to
 *   reconcile it into Postgres on its next periodic pass.
 *
 * Pub/sub:
 *   Every transition PUBLISHes the `callResponseFromState` JSON payload on the
 *   `call:events` channel so PR #7's WebSocket gateway can fan it out to
 *   subscribed clients.
 *
 * Rate-limit slot release:
 *   On the terminal COMPLETED transition the concurrency slot is released via
 *   RateLimiterService.release() so the API key can accept a new in-flight call.
 *
 * Resilience:
 *   Timer callbacks are fully async-safe — any rejected promise inside a
 *   callback is caught and logged rather than propagated as an unhandled
 *   rejection.  A single Redis failure on one leg does NOT abort the rest of
 *   the machine.
 */
@Injectable()
export class CallProgressionService implements OnModuleDestroy {
  private readonly logger = new Logger(CallProgressionService.name);

  /**
   * Tracks the single pending `setTimeout` handle for each in-progress call.
   * On each transition we remove the previous handle (it has already fired) and
   * insert the next one.  onModuleDestroy() clears all remaining handles so
   * in-flight timers do not outlive the application.
   *
   * Note: there is a microsecond TOCTOU window inside a transition between the
   * `pendingTimers.delete()` and the next `setTimer()` where onModuleDestroy
   * could miss the follow-on timer.  This is inherent to vanilla setTimeout; in
   * that window the connection is already closing, so the orphaned callback just
   * fails its best-effort Redis calls and logs — it cannot crash the process.
   */
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly stateStore: CallStateStore,
    private readonly rateLimiter: RateLimiterService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<Configuration, true>,
    private readonly completion: CallCompletionService,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start the timed state machine for a newly-created call.
   *
   * This is intentionally synchronous (returns void) so the caller — typically
   * CallsService.createCall — fires it and continues building the HTTP 201
   * response without waiting on any timer resolution.
   *
   * The `state` object is mutated in-place as transitions occur; the original
   * reference is safe to discard after this call because we keep our own copy
   * of what we need.
   */
  schedule(state: CallState): void {
    // Clone so later mutations to the caller's object do not affect our machine.
    const localState: CallState = { ...state };

    this.logger.log(
      `Scheduling progression for call ${localState.id} (apiKeyId=${localState.apiKeyId})`,
    );

    const { queuedToRingingMs } = this.config.get('call', { infer: true }).progression;
    this.setTimer(localState.id, queuedToRingingMs, () => this.transitionToRinging(localState));
  }

  // ── Lifecycle hook ──────────────────────────────────────────────────────────

  /**
   * Clear all pending timers when the NestJS DI container shuts down.
   * This prevents timer callbacks from firing after the Redis connection and
   * other providers have been destroyed, which would cause noisy errors in test
   * teardown and during graceful shutdown in production.
   */
  onModuleDestroy(): void {
    const count = this.pendingTimers.size;
    for (const [id, handle] of this.pendingTimers) {
      clearTimeout(handle);
      this.logger.debug(`Cleared pending timer for call ${id} on module destroy`);
    }
    this.pendingTimers.clear();
    if (count > 0) {
      this.logger.log(`Cleared ${count} pending progression timer(s) on module destroy`);
    }
  }

  // ── Ring-outcome isolation ──────────────────────────────────────────────────

  /**
   * Determine whether a ringing call is ANSWERED or UNANSWERED.
   *
   * Isolated in a protected method so unit tests can stub it to produce a
   * deterministic outcome (Jest `jest.spyOn(service, 'pickRingOutcome')`).
   */
  protected pickRingOutcome(
    answerProbability: number,
  ): CallStatus.ANSWERED | CallStatus.UNANSWERED {
    return Math.random() < answerProbability ? CallStatus.ANSWERED : CallStatus.UNANSWERED;
  }

  // ── Private state-machine steps ─────────────────────────────────────────────

  /**
   * Transition: QUEUED → RINGING.
   * Schedules the ring-resolution step after `ringingMs`.
   */
  private async transitionToRinging(state: CallState): Promise<void> {
    this.pendingTimers.delete(state.id);

    await this.applyTransition(state, CallStatus.RINGING);

    const { ringingMs } = this.config.get('call', { infer: true }).progression;
    this.setTimer(state.id, ringingMs, () => this.transitionRingResult(state));
  }

  /**
   * Transition: RINGING → ANSWERED | UNANSWERED.
   * Schedules the terminal COMPLETED step.
   */
  private async transitionRingResult(state: CallState): Promise<void> {
    this.pendingTimers.delete(state.id);

    const { answerProbability, answeredToCompletedMs, unansweredToCompletedMs } = this.config.get(
      'call',
      { infer: true },
    ).progression;

    const outcome = this.pickRingOutcome(answerProbability);
    await this.applyTransition(state, outcome);

    const delay = outcome === CallStatus.ANSWERED ? answeredToCompletedMs : unansweredToCompletedMs;

    this.setTimer(state.id, delay, () => this.transitionToCompleted(state));
  }

  /**
   * Transition: ANSWERED | UNANSWERED → COMPLETED (terminal).
   *
   * Execution order on the COMPLETED transition:
   *  1. applyTransition() — Redis write-behind (updateStatus) + publish to
   *     call:events channel so WS clients receive the COMPLETED event promptly.
   *  2. completion.complete() — Postgres write-through (status=COMPLETED,
   *     completed_at=now) + BullMQ recording job dispatch (best-effort).
   *     complete() already swallows all exceptions internally, but we wrap
   *     with a catch for belt-and-suspenders safety (it's in a timer callback).
   *  3. rateLimiter.release() — frees the concurrency slot so the API key can
   *     accept a new in-flight call.
   */
  private async transitionToCompleted(state: CallState): Promise<void> {
    this.pendingTimers.delete(state.id);

    // Step 1: Redis write-behind + WS pub/sub event.
    await this.applyTransition(state, CallStatus.COMPLETED);

    // Step 2: Postgres write-through + BullMQ recording dispatch.
    // complete() never throws (swallows internally), but guard anyway since
    // this runs inside a timer callback where an unhandledRejection would crash.
    try {
      await this.completion.complete(state);
    } catch (err) {
      this.logger.warn(
        `Unexpected error from CallCompletionService.complete() for call ${state.id}. ` +
          `Error: ${String(err)}`,
      );
    }

    // Step 3: Release the concurrency slot so this API key can accept a new
    // in-flight call.  best-effort — RateLimiterService.release() already
    // swallows its own errors.
    await this.rateLimiter.release(state.apiKeyId, state.id);
  }

  // ── Shared helpers ───────────────────────────────────────────────────────────

  /**
   * Apply a single status transition:
   *  1. Mutate the local `state` copy (status + updatedAt).
   *  2. Write-behind to Redis (best-effort: log + continue on failure).
   *  3. Publish the public JSON payload to the call:events channel.
   *
   * Any error in step 2 or 3 is logged as a warning; the machine continues.
   */
  private async applyTransition(state: CallState, newStatus: CallStatus): Promise<void> {
    const previousStatus = state.status;
    state.status = newStatus;
    state.updatedAt = new Date().toISOString();

    this.logger.log(
      `Call ${state.id}: ${previousStatus} → ${newStatus} (updatedAt=${state.updatedAt})`,
    );

    const ttl = this.config.get('call', { infer: true }).stateTtlSeconds;

    // ── Write-behind to Redis ────────────────────────────────────────────────
    try {
      await this.stateStore.updateStatus(state.id, newStatus, state.updatedAt, ttl);
    } catch (err) {
      this.logger.warn(
        `Redis updateStatus failed for call ${state.id} (${previousStatus}→${newStatus}). ` +
          `The hash may be stale until the next write. Error: ${String(err)}`,
      );
      // Continue the machine — a stale hash is recoverable; crashing the process
      // from inside a timer callback is not.
    }

    // ── Dirty-mark for PR #10's flush ────────────────────────────────────────
    // Every non-terminal transition leaves Postgres behind the Redis hash, so
    // record the call ID in the dirty set for CallFlushService to reconcile.
    // COMPLETED is excluded: it goes through CallCompletionService's synchronous
    // Postgres write-through instead, so there is nothing to flush for it.
    // Best-effort and isolated in its own try/catch — a failure to mark dirty
    // must never break the state machine; at worst the flush misses this call
    // until its next transition (if any) re-marks it.
    if (newStatus !== CallStatus.COMPLETED) {
      try {
        await this.stateStore.markDirty(state.id);
      } catch (err) {
        this.logger.warn(
          `Redis markDirty failed for call ${state.id} (${previousStatus}→${newStatus}). ` +
            `Postgres reconciliation may be delayed until the next transition. Error: ${String(err)}`,
        );
      }
    }

    // ── Publish transition event ─────────────────────────────────────────────
    // Produce the public response shape and publish it as a JSON string on the
    // call:events channel.  PR #7's WebSocket gateway will subscribe and forward
    // this payload directly to connected WS clients.
    try {
      const payload = JSON.stringify(callResponseFromState(state));
      await this.redis.publish(CALL_EVENTS_CHANNEL, payload);
    } catch (err) {
      this.logger.warn(
        `Redis publish failed for call ${state.id} (${previousStatus}→${newStatus}). ` +
          `WebSocket subscribers may miss this transition. Error: ${String(err)}`,
      );
      // Non-fatal — the WS client will receive the next transition or can poll
      // GET /calls/:id to reconcile.
    }
  }

  /**
   * Register a `setTimeout` handle and track it so it can be cleared on destroy.
   *
   * The callback is wrapped so any thrown error or rejected promise is caught
   * and logged rather than escaping as an unhandled rejection.
   */
  private setTimer(callId: string, delayMs: number, callback: () => Promise<void>): void {
    const handle = setTimeout(() => {
      // We must not let a rejected promise escape the timer callback;
      // Node.js would emit an unhandledRejection event and, in strict mode,
      // crash the process.
      Promise.resolve()
        .then(callback)
        .catch((err: unknown) => {
          this.logger.error(
            `Unhandled error in progression timer for call ${callId}. Error: ${String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        });
    }, delayMs);

    this.pendingTimers.set(callId, handle);
  }
}
