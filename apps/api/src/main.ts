import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const port = process.env['PORT'] ?? '3000';
  await app.listen(Number(port));
  logger.log(`Running on port ${port}`);
}

void bootstrap();
