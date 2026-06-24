import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration, { Configuration } from './config/configuration';
import { validate } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { RecordingWorkerModule } from './recording/recording-worker.module';

/**
 * WorkerModule is the root module for the dedicated `worker` process.
 *
 * It is intentionally LEAN — it contains only what the recording worker needs:
 *  - Config (global)
 *  - Database connection (TypeORM, used by RecordingProcessor via @InjectRepository)
 *  - Redis connections (global REDIS_CLIENT + REDIS_SUBSCRIBER from RedisModule)
 *  - BullMQ root connection (same factory as AppModule)
 *  - RecordingWorkerModule (the @Processor consumer + S3 storage)
 *
 * What is intentionally ABSENT (to keep the worker process minimal):
 *  - No HTTP server / platform-express
 *  - No WebSocket gateway (CallsGateway lives in WebsocketModule → AppModule only)
 *  - No API controllers (CallsController, HealthController, etc.)
 *  - No AuthModule / RateLimitModule / HealthModule
 *  - No CallProgressionService (the state machine engine runs in the API process)
 *
 * This separation means a crash or deploy of the worker does not take the API
 * down, and the API can be scaled independently of the recording worker replicas.
 */
@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────────────────────
    // isGlobal:true so ConfigService is injectable in all child modules without
    // each one importing ConfigModule again.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),

    // ── Postgres (TypeORM) ─────────────────────────────────────────────────
    // DatabaseModule reads the 'database' config block and runs migrations only
    // when DB_RUN_MIGRATIONS=true (set to false in docker-compose for the worker).
    // TypeOrmModule is exported by DatabaseModule so RecordingWorkerModule can
    // use TypeOrmModule.forFeature([Call]) without needing a second connection.
    DatabaseModule,

    // ── Redis ──────────────────────────────────────────────────────────────
    // RedisModule is @Global() — it provides REDIS_CLIENT and REDIS_SUBSCRIBER
    // to all child modules without explicit imports.  The worker only uses
    // REDIS_CLIENT (for HSET cache writes + PUBLISH); REDIS_SUBSCRIBER is
    // provided but not consumed in this process.
    RedisModule,

    // ── BullMQ root connection ─────────────────────────────────────────────
    // Mirrors the BullModule.forRootAsync() in AppModule so the recording queue
    // consumer connects to the same Redis instance as the producer.
    // BullMQ creates its own ioredis connection internally (with
    // maxRetriesPerRequest: null) — this is the THIRD Redis connection in the
    // worker process (alongside REDIS_CLIENT and REDIS_SUBSCRIBER).
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

    // ── Recording consumer ─────────────────────────────────────────────────
    // RecordingWorkerModule registers the @Processor('recording') consumer,
    // RecordingStorageService (S3 uploads), and CallStateStore (Redis cache).
    RecordingWorkerModule,
  ],
})
export class WorkerModule {}
