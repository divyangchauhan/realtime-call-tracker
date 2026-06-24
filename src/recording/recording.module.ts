import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RECORDING_QUEUE } from './recording.constants';
import { RecordingDispatchService } from './recording-dispatch.service';

/**
 * RecordingModule wires up the BullMQ 'recording' queue and the
 * RecordingDispatchService producer.
 *
 * BullModule.registerQueue() registers the queue with the name defined in
 * RECORDING_QUEUE and makes its InjectQueue token available for injection.
 * The actual Redis connection parameters come from the root BullModule.forRootAsync()
 * registered in AppModule - no need to specify connection details here.
 *
 * RecordingDispatchService is both provided and exported so CallsModule (which
 * imports RecordingModule) can inject it into CallCompletionService.
 *
 * The consumer side (the @Processor that uploads recordings) lives in
 * RecordingWorkerModule, which is imported ONLY by the worker process's
 * WorkerModule - keeping the API process free of a BullMQ Worker thread.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: RECORDING_QUEUE,
    }),
  ],
  providers: [RecordingDispatchService],
  exports: [RecordingDispatchService],
})
export class RecordingModule {}
