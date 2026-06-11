import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable, map } from 'rxjs';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message: string;
}

@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, T | ApiSuccessResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<T | ApiSuccessResponse<T>> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        if (this.shouldSkipWrap(data, response)) {
          return data;
        }

        return {
          success: true,
          data,
          message: 'OK',
        };
      }),
    );
  }

  private shouldSkipWrap(data: T, response: Response): boolean {
    return (
      data instanceof StreamableFile ||
      Buffer.isBuffer(data) ||
      response.headersSent ||
      response.statusCode === 204
    );
  }
}
