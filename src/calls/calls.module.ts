import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Call } from '../database/entities/call.entity';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
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
 * CallStateStore is exported so WebsocketModule (PR #7) can inject it for the
 * initial snapshot read on WebSocket connect.  RedisModule is @Global() so
 * WebsocketModule does not need to import it explicitly.
 */
@Module({
  imports: [
    // Provides the Call repository for injection via @InjectRepository(Call).
    TypeOrmModule.forFeature([Call]),
    // Provides RateLimiterService for the per-API-key Lua rate-limit gate.
    RateLimitModule,
  ],
  controllers: [CallsController],
  providers: [CallsService, CallStateStore, CallProgressionService],
  // Export CallStateStore so WebsocketModule can import CallsModule and inject
  // it into CallsGateway for the on-connect snapshot read.
  exports: [CallStateStore],
})
export class CallsModule {}
