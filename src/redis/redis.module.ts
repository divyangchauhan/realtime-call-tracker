import { Global, Module, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Configuration } from '../config/configuration';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Thin wrapper that holds the Redis client reference so we can call quit()
 * when the module tears down.  OnModuleDestroy fires when the DI container
 * is destroyed, which happens before the process exits.
 */
@Module({})
class RedisLifecycleHost implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycleHost.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing Redis COMMAND connection…');
    await this.client.quit();
  }
}

/**
 * @Global() so that REDIS_CLIENT is available everywhere without each feature
 * module importing RedisModule explicitly.
 *
 * This module provides the COMMAND connection only.
 * PR #5 will call client.defineCommand() here to load the Lua rate-limit script.
 * PR #7/#9 will open SEPARATE connections for pub/sub and BullMQ — subscriber
 * connections cannot issue normal Redis commands.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<Configuration, true>): Redis => {
        const { host, port } = config.get('redis', { infer: true });
        return new Redis({
          host,
          port,
          // The COMMAND client must FAIL FAST. createCall mirrors to Redis on a
          // best-effort basis and must never block the request path when Redis
          // is down, and the PR #5 Lua rate-limit gate should reject quickly
          // rather than hang. A finite retry count plus a command timeout bound
          // how long any single command can wait before it rejects and the
          // caller falls through to its log-and-continue path.
          //
          // NOTE: maxRetriesPerRequest: null is a BullMQ-only requirement and
          // belongs ONLY on the SEPARATE BullMQ connections added in PR #9 — it
          // must NOT be set here.
          maxRetriesPerRequest: 3,
          commandTimeout: 2000,
          lazyConnect: false,
        });
      },
      inject: [ConfigService],
    },
    // Registers the lifecycle host so OnModuleDestroy fires on shutdown.
    RedisLifecycleHost,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
