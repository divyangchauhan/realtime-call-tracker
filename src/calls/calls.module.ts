import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Call } from '../database/entities/call.entity';
import { CallStateStore } from './call-state.store';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

/**
 * Feature module for the /calls endpoints.
 * RedisModule is @Global() so REDIS_CLIENT is available without an explicit import.
 */
@Module({
  imports: [
    // Provides the Call repository for injection via @InjectRepository(Call).
    TypeOrmModule.forFeature([Call]),
  ],
  controllers: [CallsController],
  providers: [CallsService, CallStateStore],
})
export class CallsModule {}
