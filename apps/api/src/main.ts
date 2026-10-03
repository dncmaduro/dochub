import cookieParser from 'cookie-parser';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { AUTH_CONFIG, type AuthConfig } from './auth/auth.config.js';
import { ProductionExceptionFilter } from './common/production-exception.filter.js';
import { isAllowedBrowserOrigin } from './common/cors-policy.js';
import { RequestRateLimitMiddleware } from './common/request-rate-limit.middleware.js';
import { loadRuntimeSecurityConfig } from './common/runtime-security.config.js';

async function bootstrap() {
  const runtime = loadRuntimeSecurityConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const authConfig = app.get<AuthConfig>(AUTH_CONFIG);
  const logger = new Logger('Bootstrap');

  app.getHttpAdapter().getInstance().set('trust proxy', runtime.trustProxyHops);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: runtime.jsonBodyLimitBytes });
  app.useBodyParser('urlencoded', {
    limit: runtime.jsonBodyLimitBytes,
    extended: false,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header('origin');
    if (!isAllowedBrowserOrigin(origin, authConfig.webOrigins)) {
      response
        .status(403)
        .json({ statusCode: 403, message: 'Cross-origin request denied' });
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    next();
  });
  const rateLimiter = new RequestRateLimitMiddleware();
  app.use(rateLimiter.use.bind(rateLimiter));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ProductionExceptionFilter(runtime.production));
  if (authConfig.webOrigins.length) {
    app.enableCors({ origin: authConfig.webOrigins, credentials: true });
  } else {
    logger.warn('WEB_ORIGIN is not set; CORS is disabled');
  }

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
