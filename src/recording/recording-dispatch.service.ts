import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RECORDING_JOB, RECORDING_QUEUE } from './recording.constants';

/**
 * RecordingDispatchService is the BullMQ producer for recording upload jobs.
 *
 * It enqueues a single 'upload-recording' job onto the 'recording' queue
 * whenever a call reaches the COMPLETED state.  PR #9 will add the @Processor
 * worker that consumes these jobs, uploads the recording to S3, and writes the
 * resulting URL back to Postgres and Redis.
 *
 * Idempotency note:
 *   We use `jobId: callId` so BullMQ deduplicates by call ID — while the first
 *   job is still waiting/active a second enqueue for the same call is a no-op.
 *   (Caveat: with `removeOnComplete: true`, once the job has finished and been
 *   pruned its jobId is freed, so a much-later re-dispatch could create a new
 *   job.) A call completes exactly once, so this guard is mostly defensive.
 */
@Injectable()
export class RecordingDispatchService {
  private readonly logger = new Logger(RecordingDispatchService.name);

  constructor(
    @InjectQueue(RECORDING_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * Enqueue a recording upload job for the given call.
   *
   * Job options rationale:
   *  - jobId: callId   — idempotency; BullMQ rejects a duplicate jobId if the
   *                       first job is still active/waiting, preventing double uploads.
   *  - attempts: 3     — transient S3 / network errors are retried up to 3 times.
   *  - backoff.type: 'exponential', delay: 1000  — back off 1 s, 2 s, 4 s between
   *                       attempts to give the upstream time to recover.
   *  - removeOnComplete: true  — completed jobs are pruned automatically; we do
   *                              not need to inspect them after the URL is written back.
   *  - removeOnFail: false     — failed jobs are retained for manual inspection /
   *                              ops alerting; recording failures are high-value signal.
   */
  async dispatch(callId: string): Promise<void> {
    this.logger.log(`Dispatching recording job for call ${callId}`);

    await this.queue.add(
      RECORDING_JOB,
      { callId },
      {
        // Idempotent: a given call enqueues at most one recording job.
        jobId: callId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Recording job enqueued for call ${callId}`);
  }
}
