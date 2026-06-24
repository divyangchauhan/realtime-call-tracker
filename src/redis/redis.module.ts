import { Global, Module, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Configuration } from '../config/configuration';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.constants';

/**
 * Thin wrapper that holds the Redis COMMAND client reference so we can call
 * quit() when the module tears down.  OnModuleDestroy fires when the DI
 * container is destroyed, which happens before the process exits.
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
 * Thin wrapper that holds the Redis SUBSCRIBER connection so we can call
 * quit() on shutdown, independent of the command client.
 *
 * A subscriber connection cannot issue normal Redis commands, so it must be a
 * separate ioredis instance from REDIS_CLIENT.  ioredis automatically
 * re-subscribes to all active channels after a reconnect, so no manual
 * re-subscription is needed in the subscriber connection itself (the
 * CallsGateway registers a 'message' listener once in onModuleInit).
 */
@Module({})
class RedisSubscriberLifecycleHost implements OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberLifecycleHost.name);

  constructor(@Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing Redis SUBSCRIBER connection…');
    await this.subscriber.quit();
  }
}

/**
 * @Global() so that REDIS_CLIENT and REDIS_SUBSCRIBER are available everywhere
 * without each feature module importing RedisModule explicitly.
 *
 * Two connections are provided:
 *  - REDIS_CLIENT  — the command connection used for GET/SET/HSET/PUBLISH/etc.
 *    Configured with fail-fast knobs (commandTimeout, maxRetriesPerRequest) so
 *    the request path is never hung when Redis is temporarily unavailable.
 *  - REDIS_SUBSCRIBER — the dedicated subscriber connection used by the
 *    WebSocket gateway (PR #7) to SUBSCRIBE to call:events.  A connection in
 *    subscriber mode CANNOT issue normal commands, hence the separate instance.
 *    It carries no fail-fast knobs — a subscriber just needs to stay connected
 *    and ioredis re-subscribes automatically after a reconnect.
 *
 * PR #9 (BullMQ) will open a THIRD separate connection with maxRetriesPerRequest: null,
 * which is a BullMQ-specific requirement and must NOT be set here.
 */
@Global()
@Module({
  providers: [
    // ── COMMAND connection ───────────────────────────────────────────────────
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

    // ── SUBSCRIBER connection ────────────────────────────────────────────────
    {
      provide: REDIS_SUBSCRIBER,
      useFactory: (config: ConfigService<Configuration, true>): Redis => {
        const { host, port } = config.get('redis', { infer: true });
        // No commandTimeout / maxRetriesPerRequest: a subscriber connection
        // only needs to stay connected and receive messages.  ioredis will
        // automatically re-subscribe to all active channels after a reconnect,
        // so aggressive fail-fast settings would cause unnecessary channel drops.
        return new Redis({ host, port, lazyConnect: false });
      },
      inject: [ConfigService],
    },
    // Registers the lifecycle host so OnModuleDestroy fires on shutdown.
    RedisSubscriberLifecycleHost,
  ],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER],
})
export class RedisModule {}
