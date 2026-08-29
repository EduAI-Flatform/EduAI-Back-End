import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { CorrelatedRequest } from './common/http/request-context';
import { MonitoringService } from './common/monitoring/monitoring.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { AppLoggerService } from './common/logging/app-logger.service';
import { RequestLoggingInterceptor } from './common/logging/request-logging.interceptor';

export function configureApp(
  app: INestApplication,
  nodeEnv: string,
  logger: AppLoggerService,
  legacyPublicMediaBaseUrl?: string,
  corsAllowedOrigins: readonly string[] = [],
): void {
  if (nodeEnv === 'production') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  const allowedOrigins = corsAllowedOrigins.length > 0
    ? [...corsAllowedOrigins]
    : nodeEnv === 'development'
      ? ['http://localhost:5173', 'http://127.0.0.1:5173']
      : [];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use((request: CorrelatedRequest, response: Response, next: NextFunction) => {
    const supplied = request.header('x-request-id');
    const correlationId = supplied && /^[a-zA-Z0-9._:-]{8,64}$/.test(supplied)
      ? supplied
      : randomUUID();
    request.correlationId = correlationId;
    response.setHeader('X-Request-Id', correlationId);
    next();
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [{ method: RequestMethod.GET, path: 'health' }],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  app.useGlobalInterceptors(
    new RequestLoggingInterceptor(logger),
    new ApiResponseInterceptor(legacyPublicMediaBaseUrl),
  );

  let monitoring: MonitoringService | undefined;
  try {
    monitoring = app.get(MonitoringService, { strict: false });
  } catch {
    monitoring = undefined;
  }
  app.useGlobalFilters(new GlobalExceptionFilter(nodeEnv, logger, monitoring));
}
