/**
 * Worker entrypoint — STUB (to be expanded in PR #9).
 *
 * In PR #9 this process will host the BullMQ consumer that drives
 * call-state transitions (QUEUED → RINGING → ANSWERED/UNANSWERED → COMPLETED).
 * For now it simply initialises the Nest application context and stays alive.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // Create a standalone application context (no HTTP server)
  const app = await NestFactory.createApplicationContext(AppModule);

  logger.log('Worker started');

  // Explicit keep-alive handle so the event loop stays open and the process
  // does not exit immediately (which would cause a Docker restart-loop).
  // BullMQ listeners added in PR #9 will take over this role.
  const keepAlive = setInterval(() => {
    /* noop until BullMQ listeners land in PR #9 */
  }, 2_147_483_647);

  process.on('SIGTERM', () => {
    logger.log('Worker received SIGTERM, shutting down');
    clearInterval(keepAlive);
    void app.close();
    process.exit(0);
  });
}

bootstrap();
