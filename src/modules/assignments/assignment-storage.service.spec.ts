import { S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  AssignmentStorageService,
  MAX_ASSIGNMENT_FILE_SIZE_BYTES,
} from './assignment-storage.service';

function createService(options?: { configured?: boolean; production?: boolean }) {
  const configured = options?.configured ?? true;
  return new AssignmentStorageService({
    app: { nodeEnv: options?.production ? 'production' : 'development' },
    r2: {
      accountId: configured ? 'account-id' : undefined,
      accessKeyId: configured ? 'access-key' : undefined,
      secretAccessKey: configured ? 'secret-key' : undefined,
      bucketName: configured ? 'bucket' : undefined,
      publicUrl: configured ? 'https://cdn.example.com/' : undefined,
    },
  } as never);
}

describe('AssignmentStorageService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uploads a PDF using a server-generated key', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const service = createService();

    const result = await service.upload({
      buffer: Buffer.from('%PDF-1.7'),
      mimetype: 'application/pdf',
      originalname: '../../answer.pdf',
      size: 8,
    });

    expect(result.key).toMatch(/^assignments\/[0-9a-f-]{36}\.pdf$/);
    expect(result.url).toBe(`https://cdn.example.com/${result.key}`);
    expect(S3Client.prototype.send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported types and oversized files', async () => {
    const service = createService();

    await expect(
      service.upload({
        buffer: Buffer.from('script'),
        mimetype: 'text/html',
        originalname: 'answer.html',
        size: 6,
      }),
    ).rejects.toEqual(new BadRequestException('Assignment file type is not supported'));

    await expect(
      service.upload({
        buffer: Buffer.from('%PDF-1.7'),
        mimetype: 'application/pdf',
        originalname: 'answer.pdf',
        size: MAX_ASSIGNMENT_FILE_SIZE_BYTES + 1,
      }),
    ).rejects.toEqual(new BadRequestException('Assignment file must be 20MB or smaller'));
  });

  it('rejects files whose bytes do not match their declared MIME type', async () => {
    const service = createService();

    await expect(
      service.upload({
        buffer: Buffer.from('not-a-png'),
        mimetype: 'image/png',
        originalname: 'answer.png',
        size: 9,
      }),
    ).rejects.toEqual(new BadRequestException('Assignment file content is invalid'));
  });

  it('fails closed in production without R2 configuration', async () => {
    const service = createService({ configured: false, production: true });

    await expect(
      service.upload({
        buffer: Buffer.from('%PDF-1.7'),
        mimetype: 'application/pdf',
        originalname: 'answer.pdf',
        size: 8,
      }),
    ).rejects.toEqual(new InternalServerErrorException('R2 storage is not configured'));
  });
});
