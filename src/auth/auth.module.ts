import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../database/entities/api-key.entity';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

/**
 * AuthModule registers ApiKeyAuthGuard as a global APP_GUARD so every route
 * in the application requires a valid API key by default.
 * Routes that should be publicly accessible must be decorated with @Public().
 */
@Module({
  imports: [
    // Make the ApiKey repository available for injection into ApiKeyAuthGuard.
    TypeOrmModule.forFeature([ApiKey]),
  ],
  providers: [
    ApiKeyAuthGuard,
    // Register the guard globally via the APP_GUARD token so NestJS applies it
    // to every incoming request without requiring it on individual modules.
    {
      provide: APP_GUARD,
      useClass: ApiKeyAuthGuard,
    },
  ],
})
export class AuthModule {}
