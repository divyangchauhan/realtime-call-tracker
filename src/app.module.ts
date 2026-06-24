import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { CallsModule } from './calls/calls.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
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
    // RedisModule is @Global() — import it early so REDIS_CLIENT and
    // REDIS_SUBSCRIBER are available to all feature modules without explicit
    // re-imports.
    RedisModule,
    // AuthModule registers ApiKeyAuthGuard as a global APP_GUARD.
    // Import it after DatabaseModule so the TypeORM connection is available.
    AuthModule,
    CallsModule,
    HealthModule,
    // WebsocketModule registers CallsGateway which streams live call-state
    // transitions to connected WS clients (PR #7).
    WebsocketModule,
  ],
})
export class AppModule {}
