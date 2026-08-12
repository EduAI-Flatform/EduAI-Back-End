import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException } from '@nestjs/common';
import {
  LessonMediaStorageService,
  MAX_LESSON_DOCUMENT_SIZE_BYTES,
  MAX_VIDEO_UPLOAD_SIZE_BYTES,
} from './lesson-media-storage.service';

const send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: jest.fn((input) => input),
  GetObjectCommand: jest.fn((input) => input),
  HeadObjectCommand: jest.fn((input) => input),
  PutObjectCommand: jest.fn((input) => input),
  S3Client: jest.fn().mockImplementation(() => ({ send })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('LessonMediaStorageService', () => {
  const config = {
    r2: {
      accountId: 'account',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      bucketName: 'private-media',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue({});
    (getSignedUrl as jest.Mock).mockResolvedValue('https://signed.example/upload');
  });

  it('authorizes a bounded direct video upload under a server-generated course key', async () => {
    const service = new LessonMediaStorageService(config as never);
    const result = await service.authorizeVideoUpload('course-id', 'video/mp4', 1024);

    expect(result.storageKey).toMatch(
      /^lessons\/course-id\/videos\/[0-9a-f-]{36}\.mp4$/,
    );
    expect(result.uploadUrl).toBe('https://signed.example/upload');
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'private-media',
        ContentLength: 1024,
        ContentType: 'video/mp4',
        Key: result.storageKey,
      }),
    );
    expect(S3Client).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['application/octet-stream', 1024],
    ['video/mp4', MAX_VIDEO_UPLOAD_SIZE_BYTES + 1],
  ])('rejects invalid video authorization (%s, %s)', async (mimeType, size) => {
    const service = new LessonMediaStorageService(config as never);
    await expect(service.authorizeVideoUpload('course-id', mimeType, size)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('finalizes only an owned object with matching type and size', async () => {
    const service = new LessonMediaStorageService(config as never);
    const key = 'lessons/course-id/videos/00000000-0000-4000-8000-000000000000.mp4';
    send.mockResolvedValue({ ContentLength: 1024, ContentType: 'video/mp4' });

    await expect(
      service.finalizeVideoUpload('course-id', key, 'video/mp4', 1024),
    ).resolves.toEqual({ storageKey: key });
    expect(HeadObjectCommand).toHaveBeenCalledWith({ Bucket: 'private-media', Key: key });

    await expect(
      service.finalizeVideoUpload('another-course', key, 'video/mp4', 1024),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uploads a valid PDF and rejects invalid or oversized documents', async () => {
    const service = new LessonMediaStorageService(config as never);
    const pdf = {
      buffer: Buffer.from('%PDF-1.7'),
      mimetype: 'application/pdf',
      originalname: 'lesson.pdf',
      size: 8,
    };

    await expect(service.uploadDocument('course-id', pdf)).resolves.toEqual({
      storageKey: expect.stringMatching(
        /^lessons\/course-id\/documents\/[0-9a-f-]{36}\.pdf$/,
      ),
    });
    await expect(
      service.uploadDocument('course-id', { ...pdf, mimetype: 'text/plain' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.uploadDocument('course-id', {
        ...pdf,
        size: MAX_LESSON_DOCUMENT_SIZE_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
