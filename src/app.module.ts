import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration, { Configuration } from './config/configuration';
import { validate } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { CallsModule } from './calls/calls.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';
import { WebsocketModule } from './websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),
    DatabaseModule,
    // RedisModule is @Global() - import it early so REDIS_CLIENT and
    // REDIS_SUBSCRIBER are available to all feature modules without explicit
    // re-imports.
    RedisModule,
    // BullModule root configuration.
    // BullMQ creates its OWN ioredis connection internally with the
    // maxRetriesPerRequest: null setting it requires.  This is the THIRD
    // separate Redis connection in the design (alongside REDIS_CLIENT and
    // REDIS_SUBSCRIBER) - do NOT attempt to share the existing ioredis clients.
    // ConfigService is injected to reuse the 'redis' config block without adding
    // new environment variables.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Configuration, true>) => {
        const redis = config.get('redis', { infer: true });
        return {
          connection: {
            host: redis.host,
            port: redis.port,
          },
        };
      },
    }),
    // AuthModule registers ApiKeyAuthGuard as a global APP_GUARD.
    // Import it after DatabaseModule so the TypeORM connection is available.
    AuthModule,
    // CallsModule imports RecordingModule, which owns the BullMQ 'recording'
    // queue producer (RecordingDispatchService) dispatched on COMPLETED.
    CallsModule,
    HealthModule,
    // GET /metrics - per-API-key operational snapshot.
    MetricsModule,
    // WebsocketModule registers CallsGateway which streams live call-state
    // transitions to connected WS clients.
    WebsocketModule,
  ],
})
export class AppModule {}
