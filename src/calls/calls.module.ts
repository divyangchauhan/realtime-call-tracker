import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Call } from '../database/entities/call.entity';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RecordingModule } from '../recording/recording.module';
import { CallCompletionService } from './call-completion.service';
import { CallFlushService } from './call-flush.service';
import { CallProgressionService } from './call-progression.service';
import { CallStateStore } from './call-state.store';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

/**
 * Feature module for the /calls endpoints.
 * RedisModule is @Global() so REDIS_CLIENT is available without an explicit import.
 * RateLimitModule is imported explicitly so the dependency edge is visible.
 *
 * CallProgressionService (PR #6) is registered here so it shares the same
 * DI scope as CallsService and can be injected into it without a circular dep.
 *
 * CallCompletionService (PR #8) handles the two durable COMPLETED side-effects:
 *   1. Postgres write-through (status=COMPLETED, completed_at=now).
 *   2. BullMQ recording job dispatch via RecordingDispatchService.
 * RecordingModule is imported to make RecordingDispatchService available.
 *
 * CallStateStore is exported so WebsocketModule (PR #7) can inject it for the
 * initial snapshot read on WebSocket connect.  RedisModule is @Global() so
 * WebsocketModule does not need to import it explicitly.
 *
 * CallFlushService (PR #10) periodically reconciles the Redis write-behind
 * dirty set into Postgres. It is registered here (API process only) — the
 * BullMQ recording worker process does not import CallsModule, so it never
 * runs a flush loop.
 */
@Module({
  imports: [
    // Provides the Call repository for injection via @InjectRepository(Call).
    TypeOrmModule.forFeature([Call]),
    // Provides RateLimiterService for the per-API-key Lua rate-limit gate.
    RateLimitModule,
    // Provides RecordingDispatchService (BullMQ producer) used by
    // CallCompletionService to enqueue recording upload jobs on COMPLETED.
    RecordingModule,
  ],
  controllers: [CallsController],
  providers: [
    CallsService,
    CallStateStore,
    CallProgressionService,
    CallCompletionService,
    // CallFlushService (PR #10): periodic write-behind reconciler, API process only.
    CallFlushService,
  ],
  // Export CallStateStore so WebsocketModule can import CallsModule and inject
  // it into CallsGateway for the on-connect snapshot read.
  exports: [CallStateStore],
})
export class CallsModule {}
