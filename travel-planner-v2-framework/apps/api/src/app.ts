import 'reflect-metadata';
import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { ApiExceptionFilter } from './common/api-exception.filter';

export async function createApp(options?: NestApplicationOptions) {
  const app = await NestFactory.create(AppModule, options);
  app.setGlobalPrefix('api');
  const config = app.get(ConfigService).values;
  if (config.trustLoopbackProxy) {
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  }
  app.enableCors({ origin: config.corsOrigins });
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}
