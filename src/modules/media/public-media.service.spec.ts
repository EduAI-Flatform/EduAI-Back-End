import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NotFoundException } from '@nestjs/common';
import { PublicMediaService } from './public-media.service';
import { createPublicMediaUrl } from './public-media-url.util';

jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn((input) => input),
  S3Client: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('PublicMediaService', () => {
  const config = {
    r2: {
      accountId: 'account',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      bucketName: 'private-bucket',
    },
  };
  let service: PublicMediaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PublicMediaService(config as never);
    jest.mocked(getSignedUrl).mockResolvedValue('https://signed.example/image');
  });

  it.each([
    'course-thumbnails/00000000-0000-4000-8000-000000000000.webp',
    'avatars/00000000-0000-4000-8000-000000000000.png',
    'portfolio-images/00000000-0000-4000-8000-000000000000.jpg',
  ])('signs an allowlisted public image key without exposing credentials (%s)', async (key) => {
    const token = createPublicMediaUrl(key).split('/').pop()!;

    await expect(service.createRedirectUrl(token)).resolves.toBe(
      'https://signed.example/image',
    );
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'private-bucket',
      Key: key,
    });
    expect(S3Client).toHaveBeenCalledTimes(1);
  });

  it.each([
    'assignments/user/private.pdf',
    'lessons/course/videos/00000000-0000-4000-8000-000000000000.mp4',
    '../avatars/00000000-0000-4000-8000-000000000000.png',
  ])('rejects private or malformed object keys (%s)', async (key) => {
    const token = Buffer.from(key).toString('base64url');
    await expect(service.createRedirectUrl(token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
