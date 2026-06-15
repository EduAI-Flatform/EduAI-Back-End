import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { AvatarStorageService } from './avatar-storage.service';

describe('AvatarStorageService', () => {
  function createService(options?: {
    nodeEnv?: 'development' | 'test' | 'production';
    publicUrl?: string;
  }) {
    const config = {
      app: {
        nodeEnv: options?.nodeEnv ?? 'test',
      },
      r2: {
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
        buffer: Buffer.from('avatar'),
        mimetype: 'image/png',
        originalname: 'client-name.exe',
        size: 6,
      }),
    ).resolves.toEqual({
      key: expect.stringMatching(
        /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
      ),
      url: expect.stringMatching(
        /^https:\/\/cdn\.example\.com\/avatars\/[0-9a-f-]{36}\.png$/,
      ),
    });
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

  it('does not fall back to local storage paths in production', async () => {
    const service = createService({
      nodeEnv: 'production',
      publicUrl: undefined,
    });

    await expect(
      service.uploadAvatar({
        buffer: Buffer.from('avatar'),
        mimetype: 'image/webp',
        originalname: 'avatar.webp',
        size: 6,
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
