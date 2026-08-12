import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AvatarStorageService } from './avatar-storage.service';

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest.fn((input) => input),
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
}));

describe('AvatarStorageService', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function createService(options?: {
    configured?: boolean;
    nodeEnv?: 'development' | 'test' | 'production';
    publicUrl?: string;
  }) {
    const config = {
      app: {
        nodeEnv: options?.nodeEnv ?? 'test',
      },
      r2: {
        accountId: options?.configured === false ? undefined : 'account-id',
        accessKeyId: options?.configured === false ? undefined : 'access-key-id',
        secretAccessKey: options?.configured === false ? undefined : 'secret-access-key',
        bucketName: options?.configured === false ? undefined : 'media-bucket',
        publicUrl: Object.prototype.hasOwnProperty.call(options ?? {}, 'publicUrl')
          ? options?.publicUrl
          : 'https://cdn.example.com/',
      },
    };

    return new AvatarStorageService(config as never);
  }

  it('generates server-side avatar keys and public URLs', async () => {
    const service = createService();

    await expect(
      service.uploadAvatar({
        buffer: png,
        mimetype: 'image/png',
        originalname: 'client-name.exe',
        size: png.length,
      }),
    ).resolves.toEqual({
      key: expect.stringMatching(
        /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
      ),
      url: expect.stringMatching(
        /^\/api\/v1\/media\/public\/[A-Za-z0-9_-]+$/,
      ),
    });

    expect(S3Client).toHaveBeenCalledWith({
      endpoint: 'https://account-id.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: 'access-key-id',
        secretAccessKey: 'secret-access-key',
      },
    });
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'media-bucket',
        Body: png,
        ContentLength: png.length,
        ContentType: 'image/png',
        Key: expect.stringMatching(/^avatars\/[0-9a-f-]{36}\.png$/),
      }),
    );
  });

  it('rejects unsupported avatar file types', async () => {
    const service = createService();

    await expect(
      service.uploadAvatar({
        buffer: Buffer.from('pdf'),
        mimetype: 'application/pdf',
        originalname: 'avatar.pdf',
        size: 3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing R2 configuration instead of returning a fake URL', async () => {
    const service = createService({
      configured: false,
      nodeEnv: 'production',
    });

    await expect(
      service.uploadAvatar({
        buffer: png,
        mimetype: 'image/png',
        originalname: 'avatar.png',
        size: png.length,
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
