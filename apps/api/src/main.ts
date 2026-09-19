import cookieParser from 'cookie-parser';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AUTH_CONFIG, type AuthConfig } from './auth/auth.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const authConfig = app.get<AuthConfig>(AUTH_CONFIG);
  const logger = new Logger('Bootstrap');

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (authConfig.webOrigin) {
    app.enableCors({ origin: authConfig.webOrigin, credentials: true });
  } else {
    logger.warn('WEB_ORIGIN is not set; CORS is disabled');
  }

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
