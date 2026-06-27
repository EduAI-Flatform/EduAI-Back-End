import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { AppLoggerService } from './common/logging/app-logger.service';
import { RequestLoggingInterceptor } from './common/logging/request-logging.interceptor';

export function configureApp(
  app: INestApplication,
  nodeEnv: string,
  logger: AppLoggerService,
): void {
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',').map((o) =>
    o.trim(),
  ) ?? [];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
    new ApiResponseInterceptor(),
  );

  app.useGlobalFilters(new GlobalExceptionFilter(nodeEnv, logger));
}
