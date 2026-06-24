/**
 * Worker process entrypoint.
 *
 * Boots a lean NestJS application context (no HTTP server) from WorkerModule,
 * which registers the BullMQ @Processor('recording') consumer and all the
 * infrastructure it needs (Postgres, Redis, S3 config).
 *
 * Why createApplicationContext instead of create?
 *   createApplicationContext skips the HTTP adapter entirely - no Express server,
 *   no listening socket.  The event loop is kept alive by the BullMQ Worker
 *   thread that @nestjs/bullmq spins up for the @Processor decorator.
 *
 * Why enableShutdownHooks?
 *   Nest's shutdown hooks wire SIGINT/SIGTERM to the DI container's onModuleDestroy
 *   lifecycle.  This lets RedisModule (lifecycle host), TypeORM, and BullMQ drain
 *   their connections gracefully before the process exits.  The manual setInterval
 *   keep-alive and SIGTERM handler from the original stub are removed - the
 *   running BullMQ Worker already keeps the event loop alive, and Nest handles
 *   the shutdown sequence.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // Create a standalone application context (no HTTP server).
  // WorkerModule brings in Config, Database, Redis, BullMQ root, and the
  // RecordingWorkerModule with its @Processor consumer.
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Nest shutdown hooks close the BullMQ Worker, Redis connections, and TypeORM
  // pool gracefully on SIGINT/SIGTERM.  This replaces the manual process.on()
  // handler in the original stub.
  app.enableShutdownHooks();

  logger.log('Recording worker started');
}

// Surface a boot failure (e.g. Postgres/Redis unreachable) explicitly rather
// than emitting an unhandled rejection warning and exiting ambiguously.
bootstrap().catch((err: unknown) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
