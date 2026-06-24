import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Configuration } from '../config/configuration';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { CallStateStore } from './call-state.store';

/**
 * Periodic reconciler that closes the gap left by the progression engine's
 * split-durability design.
 *
 * Split-durability recap:
 *   CallProgressionService writes intermediate transitions (RINGING/ANSWERED/
 *   UNANSWERED) ONLY to the Redis live-state hash (write-behind) — Postgres
 *   `calls.status` stays at its initial QUEUED value.  Only the terminal
 *   COMPLETED transition is written through to Postgres synchronously, by
 *   CallCompletionService.  This keeps the hot timer path cheap (one Redis
 *   round-trip per transition) at the cost of Postgres temporarily lagging
 *   reality for in-flight calls.
 *
 * CallFlushService exists to bound that lag: on a fixed interval it drains
 * the `calls:dirty` Redis SET (populated by CallProgressionService.
 * applyTransition() on every non-terminal transition) and writes each call's
 * latest known status through to Postgres.  This guarantees the durable store
 * eventually reflects the latest non-terminal status even for calls that
 * never reach COMPLETED (e.g. the process restarts mid-flight) or that are
 * merely slow to do so.
 *
 * Why the `status != COMPLETED` guard matters:
 *   By the time a dirty ID is processed here, the call may have already
 *   raced ahead to COMPLETED via CallCompletionService's write-through (which
 *   runs independently, immediately, on the terminal transition).  A flush
 *   pass that blindly overwrote `status` with a stale intermediate value
 *   (e.g. "ANSWERED") would regress an already-terminal, durably-COMPLETED
 *   row. The UPDATE is therefore guarded with `AND status != 'COMPLETED'` so
 *   it is a no-op against any row that has already reached the terminal
 *   state — COMPLETED is write-through and must never be overwritten here.
 *
 * Dirty-set lifecycle:
 *   Marked dirty by CallProgressionService.applyTransition() right after the
 *   Redis write-behind. Cleared here, either after a successful reconcile or
 *   when the Redis hash has already expired (nothing left to reconcile).  On
 *   a per-id failure the ID is deliberately left dirty so the next pass
 *   retries it.
 *
 * At-least-once / idempotent by construction:
 *   Statuses only move forward (QUEUED→RINGING→ANSWERED/UNANSWERED→
 *   COMPLETED), so writing the same (or a since-superseded) status more than
 *   once is harmless — re-applying an older status is prevented by nothing
 *   here, but because the Redis hash always holds the LATEST status for a
 *   given id, re-running a flush pass (e.g. after a crash, or concurrently
 *   from multiple API instances) converges on the same result rather than
 *   oscillating. Multiple API instances flushing the same dirty set
 *   concurrently is safe: each UPDATE is independently guarded and clearDirty
 *   is idempotent (SREM of an absent member is a no-op).
 *
 * Process scope:
 *   This service is registered only in CallsModule, which only the API
 *   process imports (see calls.module.ts) — the BullMQ recording worker
 *   process does not import CallsModule and therefore never runs a flush
 *   loop.
 */
@Injectable()
export class CallFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallFlushService.name);

  /** Handle for the periodic setInterval timer; cleared on module destroy. */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Re-entrancy guard. A flush pass that takes longer than `intervalMs` (e.g.
   * a slow Postgres) must not overlap with the next tick — overlapping passes
   * could race on the same IDs without any benefit.
   */
  private running = false;

  constructor(
    private readonly stateStore: CallStateStore,
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    private readonly config: ConfigService<Configuration, true>,
  ) {}

  /**
   * Start the periodic flush loop on module init.
   * Uses a plain Node `setInterval` — @nestjs/schedule is deliberately not a
   * dependency of this project (matches CallProgressionService's convention).
   */
  onModuleInit(): void {
    const { intervalMs } = this.config.get('flush', { infer: true });

    this.timer = setInterval(() => {
      this.flush().catch((err: unknown) => {
        // flush() is designed to never throw, but guard anyway since this
        // runs from a timer callback where an unhandledRejection would crash
        // the process.
        this.logger.error(
          `Unexpected error escaped CallFlushService.flush(). Error: ${String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      });
    }, intervalMs);

    this.logger.log(`CallFlushService started: flushing every ${intervalMs}ms`);
  }

  /** Stop the periodic flush loop when the DI container shuts down. */
  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.debug('CallFlushService stopped on module destroy');
    }
  }

  /**
   * Run a single flush pass: drain the dirty set and reconcile each call's
   * latest Redis status into Postgres.
   *
   * Never throws — this is called from a timer callback. Every failure mode
   * (readDirtyIds failing, a single id's read/update failing) is caught,
   * logged as a warning, and treated as "retry next cycle".
   */
  async flush(): Promise<void> {
    if (this.running) {
      // A previous pass is still in flight — skip this tick entirely.
      return;
    }

    try {
      this.running = true;
      await this.runFlushCycle();
    } finally {
      this.running = false;
    }
  }

  /** The actual flush work, isolated so flush() only has to manage the guard. */
  private async runFlushCycle(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.stateStore.readDirtyIds();
    } catch (err) {
      this.logger.warn(
        `Failed to read the dirty set; will retry next cycle. Error: ${String(err)}`,
      );
      return;
    }

    if (ids.length === 0) {
      return;
    }

    let processed = 0;

    for (const id of ids) {
      try {
        const state = await this.stateStore.read(id);

        if (state === null) {
          // The Redis hash has already expired/been removed — there is
          // nothing left to reconcile. Clear the marker so it doesn't leak.
          await this.stateStore.clearDirty(id);
          processed++;
          continue;
        }

        // Guarded UPDATE: only touch `status`. The @UpdateDateColumn stamps
        // `updated_at` to the flush time (not the precise transition time —
        // that precise timestamp lives in Redis's `updatedAt` field). This is
        // an accepted property of write-behind: Postgres records "when we
        // last reconciled," Redis records "when it actually happened."
        //
        // `status != COMPLETED` ensures a terminal row already written
        // through by CallCompletionService is never regressed by a stale
        // intermediate status here.
        await this.callRepo
          .createQueryBuilder()
          .update(Call)
          .set({ status: state.status })
          .where('id = :id', { id })
          .andWhere('status != :completed', { completed: CallStatus.COMPLETED })
          .execute();

        await this.stateStore.clearDirty(id);
        processed++;
      } catch (err) {
        // Leave this id dirty so the next cycle retries it; do not let one
        // failing id stop the rest of the batch.
        this.logger.warn(`Failed to flush call ${id}; left dirty for retry. Error: ${String(err)}`);
      }
    }

    if (processed > 0) {
      this.logger.log(`Flushed ${processed}/${ids.length} dirty call(s) to Postgres`);
    }
  }
}
