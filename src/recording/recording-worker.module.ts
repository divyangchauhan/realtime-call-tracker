import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RECORDING_QUEUE } from './recording.constants';
import { RecordingProcessor } from './recording.processor';
import { RecordingStorageService } from './recording-storage.service';
import { CallStateStore } from '../calls/call-state.store';
import { Call } from '../database/entities/call.entity';

/**
 * RecordingWorkerModule wires up ONLY the consumer side of the recording pipeline.
 *
 * It is imported exclusively by WorkerModule (src/worker.module.ts) and is
 * intentionally NEVER imported by AppModule or CallsModule.  This isolation
 * ensures that the @Processor BullMQ worker thread runs only in the `worker`
 * process, not in the `api` process.
 *
 * Why separate from RecordingModule (the producer module)?
 *   RecordingModule lives in the API process and provides RecordingDispatchService
 *   (the producer) to CallsModule.  If we added the @Processor here and imported
 *   this module into AppModule, the API would also start a BullMQ Worker thread,
 *   consuming jobs that should only be processed by the dedicated worker service.
 *
 * Providers:
 *  - RecordingProcessor      - @Processor(RECORDING_QUEUE) BullMQ consumer.
 *  - RecordingStorageService - S3 upload helper (OnModuleInit ensures bucket exists).
 *  - CallStateStore          - Redis hash write-through cache; only needs the
 *                              global REDIS_CLIENT token (injected from RedisModule
 *                              which WorkerModule imports as @Global).  Re-providing
 *                              it here avoids importing the heavier CallsModule with
 *                              its HTTP controllers and other API-only services.
 */
@Module({
  imports: [
    // Register the BullMQ queue consumer connection for the 'recording' queue.
    // The actual Redis connection parameters come from BullModule.forRootAsync()
    // registered in WorkerModule - no need to specify them here.
    BullModule.registerQueue({
      name: RECORDING_QUEUE,
    }),
    // Give TypeORM access to the Call entity so @InjectRepository(Call) works
    // inside RecordingProcessor.
    TypeOrmModule.forFeature([Call]),
  ],
  providers: [
    // BullMQ @Processor consumer - keeps the event loop alive in the worker process.
    RecordingProcessor,
    // S3 storage helper - creates the bucket on init if needed.
    RecordingStorageService,
    // Redis hash store - re-provided here to avoid importing CallsModule.
    // REDIS_CLIENT is provided globally by RedisModule (imported in WorkerModule).
    CallStateStore,
  ],
})
export class RecordingWorkerModule {}
