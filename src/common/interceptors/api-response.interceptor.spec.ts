import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { firstValueFrom, of } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';

describe('ApiResponseInterceptor', () => {
  it('returns absolute URLs for canonical public media paths', async () => {
    const request = {
      protocol: 'http',
      get: jest.fn((name: string) => {
        if (name === 'x-forwarded-proto') return 'https';
        if (name === 'host') return 'api.eduai.giaoducso.org.vn';
        return undefined;
      }),
    } as unknown as Request;
    const response = {
      headersSent: false,
      statusCode: 200,
    } as Response;
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;
    const next = {
      handle: () =>
        of({
          avatarUrl: '/api/v1/media/public/YXZhdGFycy90ZXN0LnBuZw',
          nested: [{ thumbnailUrl: '/api/v1/media/public/dGh1bWJuYWls' }],
          legacyUrl: 'https://cdn.example.com/legacy.png',
          createdAt: new Date('2026-08-12T00:00:00.000Z'),
        }),
    } as CallHandler;

    const result = await firstValueFrom(
      new ApiResponseInterceptor().intercept(context, next),
    );

    expect(result).toEqual({
      success: true,
      data: {
        avatarUrl:
          'https://api.eduai.giaoducso.org.vn/api/v1/media/public/YXZhdGFycy90ZXN0LnBuZw',
        nested: [
          {
            thumbnailUrl:
              'https://api.eduai.giaoducso.org.vn/api/v1/media/public/dGh1bWJuYWls',
          },
        ],
        legacyUrl: 'https://cdn.example.com/legacy.png',
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
      },
      message: 'OK',
    });
  });

  it('migrates allowlisted legacy R2 URLs without changing external URLs', async () => {
    const request = {
      protocol: 'http',
      get: jest.fn((name: string) =>
        name === 'host' ? '127.0.0.1:3000' : undefined,
      ),
    } as unknown as Request;
    const response = { headersSent: false, statusCode: 200 } as Response;
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;
    const key = 'course-thumbnails/a83ea22c-3c75-4af6-a07d-389316add2f3.png';
    const next = {
      handle: () =>
        of({
          legacy: `https://public.example.com/${key}`,
          external: 'https://images.example.org/course.png',
          privateMedia:
            'https://public.example.com/lessons/course/upload/video.mp4',
        }),
    } as CallHandler;

    const result = await firstValueFrom(
      new ApiResponseInterceptor('https://public.example.com').intercept(
        context,
        next,
      ),
    );

    expect(result).toEqual({
      success: true,
      data: {
        legacy: `http://127.0.0.1:3000/api/v1/media/public/${Buffer.from(key).toString('base64url')}`,
        external: 'https://images.example.org/course.png',
        privateMedia:
          'https://public.example.com/lessons/course/upload/video.mp4',
      },
      message: 'OK',
    });
  });
});
