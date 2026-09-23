import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import {
  allowedHostHeaders,
  hostHeaderMiddleware,
  isLoopbackHost,
  resolveBindHost,
} from './common/host-guard';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const port = process.env['PORT'] ?? '3000';
  // Localhost only: there is no auth layer. EMAIL_AI_HOST overrides it.
  const host = resolveBindHost();
  if (!isLoopbackHost(host)) {
    logger.warn(
      `EMAIL_AI_HOST=${host} is not a loopback address: this API has no authentication ` +
        'and will be reachable from the network',
    );
  }
  // Reject requests whose Host header is not this server (DNS rebinding).
  app.use(hostHeaderMiddleware(allowedHostHeaders(host, port)));
  await app.listen(Number(port), host);
  logger.log(`Running on http://${host}:${port}`);
}

void bootstrap();
