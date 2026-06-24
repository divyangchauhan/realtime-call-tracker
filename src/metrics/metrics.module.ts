import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Call } from '../database/entities/call.entity';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Feature module for the GET /metrics endpoint.
 *
 * TypeOrmModule.forFeature([Call]) provides the Call repository for
 * MetricsService's per-API-key aggregate queries (counts by status, counts
 * with a recording).
 *
 * RedisModule is @Global() (see redis/redis.module.ts), so REDIS_CLIENT is
 * injectable into MetricsService without an explicit import here - same
 * pattern CallsModule and RateLimiterService rely on.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Call])],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
