import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RecordingStorageService } from './recording-storage.service';
import { RECORDING_JOB, RECORDING_QUEUE } from './recording.constants';
import { Call } from '../database/entities/call.entity';
import { CallStateStore } from '../calls/call-state.store';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CALL_EVENTS_CHANNEL } from '../calls/call-events.constants';
import { callResponseFromState } from '../calls/dto/call-response.dto';
import { Configuration } from '../config/configuration';

/**
 * Payload shape for 'upload-recording' jobs enqueued by RecordingDispatchService.
 * Matches the definition in recording.constants.ts.
 */
interface UploadRecordingPayload {
  callId: string;
}

/**
 * RecordingProcessor is the BullMQ consumer for the 'recording' queue.
 *
 * It runs ONLY in the dedicated worker process (src/worker.ts → WorkerModule →
 * RecordingWorkerModule).  It is intentionally NOT registered in AppModule or
 * CallsModule so the API server does not spin up a second BullMQ Worker thread.
 *
 * For each 'upload-recording' job the processor:
 *   1. Reads the mock MP3 from disk.
 *   2. Uploads it to S3 via RecordingStorageService.
 *   3. Persists the resulting URL to the Postgres `calls` row.   ← throw-to-retry
 *   4. Updates the Redis hash cache with the recording URL.       ← best-effort
 *   5. Reads the full call state from Redis and publishes a final
 *      WS event so connected clients receive the recording URL.  ← best-effort
 *
 * ─── Retry vs best-effort rationale ──────────────────────────────────────────
 *
 * Steps 2 and 3 (S3 upload + Postgres update) THROW on failure so BullMQ
 * retries the job (up to the `attempts` configured in RecordingDispatchService).
 * Retries are safe because:
 *   - S3 key is deterministic: `recordings/<callId>.mp3` — re-uploading
 *     overwrites the same key with identical bytes.
 *   - repo.update() is an idempotent upsert of the same URL.
 *   - The BullMQ jobId is set to callId, so there is at most one active job per
 *     call at a time.
 *
 * Steps 4 and 5 (Redis cache + WS publish) are caught and logged rather than
 * re-thrown.  The Redis hash is a best-effort write-through cache; the Postgres
 * row is always the durable source of truth.  If the cache update fails the
 * next GET /calls/:id will fall back to Postgres and the hash will be rebuilt.
 * If the publish fails the connected WebSocket client misses one event but can
 * re-fetch the call via HTTP.  Failing the entire BullMQ job for a Redis/WS
 * error would cause an unnecessary S3 re-upload, so we accept the inconsistency.
 */
@Injectable()
@Processor(RECORDING_QUEUE)
export class RecordingProcessor extends WorkerHost {
  private readonly logger = new Logger(RecordingProcessor.name);

  constructor(
    private readonly storage: RecordingStorageService,
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    private readonly stateStore: CallStateStore,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly config: ConfigService<Configuration, true>,
  ) {
    super();
  }

  /**
   * Entry point called by BullMQ for every 'upload-recording' job.
   *
   * @returns { recordingUrl } — BullMQ stores this as the job's return value,
   *   which makes it inspectable via the Bull Board UI or the BullMQ API.
   */
  async process(job: Job<UploadRecordingPayload>): Promise<{ recordingUrl: string }> {
    // Guard against future job types on this queue: WorkerHost.process receives
    // every job name, so reject anything we don't recognise rather than blindly
    // destructuring an unexpected payload.
    if (job.name !== RECORDING_JOB) {
      throw new Error(`RecordingProcessor received unexpected job name '${job.name}'`);
    }

    const { callId } = job.data;
    this.logger.log(`Processing recording job ${job.id} for call ${callId}`);

    // ── Step 1: Read mock recording from disk ──────────────────────────────
    // The mock file path is resolved against process.cwd() so it works from
    // both the project root (ts-node) and /app (compiled Docker image).
    const mockFilePath = this.config.get('recording', { infer: true }).mockFilePath;
    const body = await readFile(resolve(process.cwd(), mockFilePath));

    // ── Step 2: Upload to S3 (throw-to-retry) ─────────────────────────────
    // The object key is deterministic so retries are idempotent (same bytes,
    // same key — S3 simply overwrites the previous attempt).
    const key = `recordings/${callId}.mp3`;
    const url = await this.storage.upload(key, body, 'audio/mpeg');

    // ── Step 3: Persist URL to Postgres (throw-to-retry) ──────────────────
    // This is the durable write.  If it fails BullMQ retries the whole job
    // (including the S3 upload, which is idempotent).  Once this succeeds the
    // recording URL is durably committed regardless of what happens next.
    await this.callRepo.update(callId, { recordingUrl: url });
    this.logger.log(`Postgres recording_url updated for call ${callId}`);

    // ── Steps 4 + 5: Redis cache + WS publish (best-effort) ───────────────
    // These run after the durable writes and are best-effort: failures are
    // caught and logged, not re-thrown, so the job is still marked complete.
    try {
      const ttlSeconds = this.config.get('call', { infer: true }).stateTtlSeconds;
      const nowIso = new Date().toISOString();

      // Step 4: Update the Redis hash cache.
      await this.stateStore.updateRecordingUrl(callId, url, nowIso, ttlSeconds);
      this.logger.log(`Redis cache recording_url updated for call ${callId}`);

      // Step 5: Read the updated state and publish the final WS event.
      // The gateway (PR #7) subscribes to CALL_EVENTS_CHANNEL and forwards the
      // JSON payload to any WebSocket client that joined room `callId`.
      const state = await this.stateStore.read(callId);
      if (state) {
        const payload = JSON.stringify(callResponseFromState(state));
        await this.redis.publish(CALL_EVENTS_CHANNEL, payload);
        this.logger.log(`WS event published for call ${callId} with recording_url`);
      } else {
        // State may be absent if the Redis hash expired between updateRecordingUrl
        // and the read.  Not an error — Postgres is already updated.
        this.logger.warn(
          `Redis state not found for call ${callId} after upload — WS publish skipped`,
        );
      }
    } catch (err) {
      // Redis is a cache layer; losing the cache update or WS publish is
      // acceptable.  The Postgres row (written above) is the durable source of
      // truth — the next GET /calls/:id will rebuild the cache from Postgres.
      this.logger.warn(
        `Best-effort Redis/WS step failed for call ${callId} (job still complete): ${String(err)}`,
      );
    }

    return { recordingUrl: url };
  }
}
