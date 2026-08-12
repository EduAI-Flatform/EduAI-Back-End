import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { migrateLegacyPublicMediaUrl } from '../../modules/media/public-media-url.util';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message: string;
}

@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, T | ApiSuccessResponse<T>>
{
  constructor(private readonly legacyPublicMediaBaseUrl?: string) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<T | ApiSuccessResponse<T>> {
    const response = context.switchToHttp().getResponse<Response>();
    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((data) => {
        if (this.shouldSkipWrap(data, response)) {
          return data;
        }

        return {
          success: true,
          data: this.resolveCanonicalMediaUrls(data, request),
          message: 'OK',
        };
      }),
    );
  }

  private resolveCanonicalMediaUrls<TValue>(
    value: TValue,
    request: Request,
  ): TValue {
    if (typeof value === 'string' && value.startsWith('/api/v1/media/public/')) {
      const forwardedProto = request
        .get('x-forwarded-proto')
        ?.split(',')[0]
        ?.trim();
      const protocol = forwardedProto || request.protocol;
      return `${protocol}://${request.get('host')}${value}` as TValue;
    }
    if (typeof value === 'string') {
      const canonicalPath = migrateLegacyPublicMediaUrl(
        value,
        this.legacyPublicMediaBaseUrl,
      );
      if (canonicalPath) {
        const forwardedProto = request
          .get('x-forwarded-proto')
          ?.split(',')[0]
          ?.trim();
        const protocol = forwardedProto || request.protocol;
        return `${protocol}://${request.get('host')}${canonicalPath}` as TValue;
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        this.resolveCanonicalMediaUrls(item, request),
      ) as TValue;
    }
    if (
      value &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.resolveCanonicalMediaUrls(item, request),
        ]),
      ) as TValue;
    }
    return value;
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
