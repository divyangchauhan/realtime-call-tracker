import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Call } from '../database/entities/call.entity';
import { CallStatus } from '../database/entities/call-status.enum';
import { RecordingDispatchService } from '../recording/recording-dispatch.service';
import { CallState } from './call-state.store';

/**
 * CallCompletionService handles the two durable side-effects that occur when a
 * call reaches the COMPLETED terminal state:
 *
 *  1. **Postgres write-through (synchronous, durable):**
 *     Update the `calls` row to status=COMPLETED and set completed_at=now().
 *     This is the write-through point in the split-durability design:
 *       - Intermediate transitions (QUEUED→RINGING→ANSWERED/UNANSWERED) are
 *         write-behind (Redis only; Postgres row remains at its initial status).
 *       - COMPLETED is the single point where the call's outcome is committed to
 *         Postgres durably. PR #10's flush will reconcile any intermediate states.
 *
 *  2. **BullMQ recording dispatch (best-effort):**
 *     Enqueue a recording upload job onto the 'recording' BullMQ queue.
 *     PR #9's worker will consume this job, upload the recording to S3, and
 *     write the resulting URL back (recording_url in Postgres + Redis).
 *
 * Ordering trade-off / outbox note:
 *   True atomicity between the Postgres write and the queue enqueue would
 *   require an outbox pattern (write a pending-dispatch record in the same DB
 *   transaction, then relay from it).  For this take-home we accept a pragmatic
 *   ordering: durable DB write first, then best-effort enqueue.  Failure modes:
 *
 *   - DB write fails  → we return early; no job is enqueued; the call will be
 *                        reconciled by PR #10's flush pass.
 *   - Enqueue fails   → DB write is already committed; the call is durably
 *                        COMPLETED in Postgres but the recording job was lost.
 *                        Operations must detect and manually re-enqueue if needed.
 *                        This is an acceptable lesser failure for the take-home.
 *
 * Never throws:
 *   complete() is called from a timer callback inside CallProgressionService.
 *   Letting an exception escape would cause an unhandledRejection.  All errors
 *   are caught internally and logged as warnings.
 */
@Injectable()
export class CallCompletionService {
  private readonly logger = new Logger(CallCompletionService.name);

  constructor(
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    private readonly recordingDispatch: RecordingDispatchService,
  ) {}

  /**
   * Handle all durable side-effects for a call transitioning to COMPLETED.
   *
   * Called by CallProgressionService.transitionToCompleted() immediately after
   * the COMPLETED applyTransition() (Redis write-behind + publish) and before
   * the rate-limit slot release.
   *
   * @param state - The call state object after the COMPLETED transition has been
   *   applied in memory (state.status === CallStatus.COMPLETED).
   */
  async complete(state: CallState): Promise<void> {
    // ── Step 1: Postgres write-through ────────────────────────────────────────
    // Mark the row as COMPLETED with the current timestamp.  This is the only
    // point in the lifecycle where the progression engine touches Postgres.
    try {
      await this.callRepo.update(state.id, {
        status: CallStatus.COMPLETED,
        completedAt: new Date(),
      });

      this.logger.log(`Postgres write-through: call ${state.id} marked COMPLETED`);
    } catch (err) {
      // DB failure: log and return early.  Do NOT enqueue a recording job for a
      // call we couldn't durably mark complete — the PR #10 flush will reconcile.
      this.logger.warn(
        `Postgres write-through failed for call ${state.id}. ` +
          `Skipping recording dispatch. Error: ${String(err)}`,
      );
      return;
    }

    // ── Step 2: BullMQ recording dispatch ─────────────────────────────────────
    // Enqueue the recording upload job.  The DB write above is already committed,
    // so a failure here is a lesser problem — the call IS durably COMPLETED; only
    // the recording job was lost.
    try {
      await this.recordingDispatch.dispatch(state.id);
    } catch (err) {
      this.logger.warn(
        `BullMQ recording dispatch failed for call ${state.id}. ` +
          `The COMPLETED state is durable in Postgres; ` +
          `recording job must be re-enqueued manually. Error: ${String(err)}`,
      );
      // Do not re-throw — COMPLETED is already committed.
    }
  }
}
