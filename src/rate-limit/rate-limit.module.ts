import { Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Feature module that provides the per-API-key Redis Lua rate limiter.
 *
 * RateLimiterService depends on:
 *  - REDIS_CLIENT  (provided globally by RedisModule - no explicit import needed)
 *  - ConfigService (provided globally by ConfigModule - no explicit import needed)
 *
 * This module is intentionally NOT @Global() - consumers must import it
 * explicitly so the dependency graph remains visible (currently: CallsModule).
 */
@Module({
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimitModule {}
