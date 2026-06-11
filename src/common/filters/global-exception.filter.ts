import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppLoggerService } from '../logging/app-logger.service';

interface StandardErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly nodeEnv: string,
    private readonly logger: AppLoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = this.getStatus(exception);
    const message = this.getMessage(exception, status);
    const code = this.getCode(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error('critical request error', this.getStack(exception), 'GlobalExceptionFilter', {
        code,
        method: request.method,
        path: request.originalUrl ?? request.url,
        statusCode: status,
      });
    }

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
      },
    } satisfies StandardErrorResponse);
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }

    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private getCode(exception: unknown, status: number): string {
    const response = this.getExceptionResponse(exception);

    if (this.isObjectRecord(response) && typeof response.error === 'string') {
      return this.toErrorCode(response.error);
    }

    return this.toErrorCode(HttpStatus[status] ?? 'Error');
  }

  private getMessage(exception: unknown, status: number): string {
    const response = this.getExceptionResponse(exception);

    if (this.isObjectRecord(response) && 'message' in response) {
      return this.formatMessage(response.message);
    }

    if (typeof response === 'string') {
      return response;
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR && this.nodeEnv === 'production') {
      return 'Internal server error';
    }

    if (exception instanceof Error && this.nodeEnv !== 'production') {
      return exception.message;
    }

    return 'Internal server error';
  }

  private getExceptionResponse(exception: unknown): unknown {
    if (exception instanceof HttpException) {
      return exception.getResponse();
    }

    return undefined;
  }

  private getStack(exception: unknown): string | undefined {
    return exception instanceof Error ? exception.stack : undefined;
  }

  private formatMessage(message: unknown): string {
    if (Array.isArray(message)) {
      return message.filter((item): item is string => typeof item === 'string').join('; ');
    }

    if (typeof message === 'string') {
      return message;
    }

    return 'Request failed';
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toErrorCode(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  }
}
