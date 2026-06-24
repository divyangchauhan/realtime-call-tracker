import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Apply global validation pipe: strip unknown properties and auto-transform types
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Enable Node.js process signal handling so NestJS can call OnModuleDestroy /
  // OnApplicationShutdown hooks (e.g. Redis quit) before the process exits.
  app.enableShutdownHooks();

  // Install the raw ws WebSocket adapter so clients can connect with a plain
  // ws:// URL (no socket.io protocol overhead).  Must be called after
  // enableShutdownHooks and before listen() so the adapter is in place before
  // the server starts accepting connections.
  app.useWebSocketAdapter(new WsAdapter(app));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  await app.listen(port);
  logger.log(`Application listening on http://localhost:${port}`);
}

bootstrap();
