import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { CallsGateway } from './calls.gateway';

/**
 * Feature module that wires up the WebSocket gateway.
 *
 * Why import CallsModule?
 *   CallsModule exports CallStateStore so CallsGateway can inject it for the
 *   initial snapshot read on connect (giving late-joining clients the current
 *   state without waiting for the next pub/sub event).
 *
 * Why NOT import RedisModule?
 *   RedisModule is @Global(), so REDIS_CLIENT and REDIS_SUBSCRIBER are already
 *   available in every module's DI context without an explicit import.
 */
@Module({
  imports: [
    // Gives CallsGateway access to CallStateStore (exported by CallsModule).
    CallsModule,
  ],
  providers: [CallsGateway],
})
export class WebsocketModule {}
