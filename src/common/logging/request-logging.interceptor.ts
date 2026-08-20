import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AppLoggerService } from './app-logger.service';
import { CorrelatedRequest, safeRequestPath } from '../http/request-context';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<CorrelatedRequest>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log('request completed', 'HttpRequest', {
            method: request.method,
            path: safeRequestPath(request),
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt,
            correlationId: request.correlationId,
          });
        },
        error: (error: unknown) => {
          this.logger.warn('request failed', 'HttpRequest', {
            method: request.method,
            path: safeRequestPath(request),
            statusCode: error instanceof HttpException ? error.getStatus() : 500,
            durationMs: Date.now() - startedAt,
            correlationId: request.correlationId,
          });
        },
      }),
    );
  }
}
