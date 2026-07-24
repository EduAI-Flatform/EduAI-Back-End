import { S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  CourseThumbnailStorageService,
  MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES,
} from './course-thumbnail-storage.service';

function createService(options?: { configured?: boolean }) {
  const configured = options?.configured ?? true;

  return new CourseThumbnailStorageService({
    r2: {
      accountId: configured ? 'account-id' : undefined,
      accessKeyId: configured ? 'access-key' : undefined,
      secretAccessKey: configured ? 'secret-key' : undefined,
      bucketName: configured ? 'bucket' : undefined,
      publicUrl: configured ? 'https://cdn.example.com/' : undefined,
    },
  } as never);
}

describe('CourseThumbnailStorageService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploads supported images under a server-generated R2 key', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const service = createService();

    const result = await service.uploadThumbnail({
      buffer: Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45,
        0x42, 0x50,
      ]),
      mimetype: 'image/webp',
      originalname: '../../client-name.png',
      size: 12,
    });

    expect(result.key).toMatch(
      /^course-thumbnails\/[0-9a-f-]{36}\.webp$/,
    );
    expect(result.url).toBe(`https://cdn.example.com/${result.key}`);
    expect(S3Client.prototype.send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported image types', async () => {
    const service = createService();

    await expect(
      service.uploadThumbnail({
        buffer: Buffer.from('svg'),
        mimetype: 'image/svg+xml',
        originalname: 'thumbnail.svg',
        size: 3,
      }),
    ).rejects.toEqual(
      new BadRequestException('Course thumbnail file type is not supported'),
    );
  });

  it('rejects files whose content does not match the declared image type', async () => {
    const service = createService();

    await expect(
      service.uploadThumbnail({
        buffer: Buffer.from('<script>alert(1)</script>'),
        mimetype: 'image/png',
        originalname: 'thumbnail.png',
        size: 25,
      }),
    ).rejects.toEqual(
      new BadRequestException('Course thumbnail file content is invalid'),
    );
  });

  it('rejects images larger than 5MB', async () => {
    const service = createService();

    await expect(
      service.uploadThumbnail({
        buffer: Buffer.alloc(1),
        mimetype: 'image/png',
        originalname: 'thumbnail.png',
        size: MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES + 1,
      }),
    ).rejects.toEqual(
      new BadRequestException('Course thumbnail file must be 5MB or smaller'),
    );
  });

  it('fails closed when R2 storage is not configured', async () => {
    const service = createService({ configured: false });

    await expect(
      service.uploadThumbnail({
        buffer: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]),
        mimetype: 'image/png',
        originalname: 'thumbnail.png',
        size: 8,
      }),
    ).rejects.toEqual(
      new InternalServerErrorException(
        'R2 storage is not configured for course thumbnails',
      ),
    );
  });
});
