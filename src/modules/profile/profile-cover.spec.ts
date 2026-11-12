import { BadRequestException } from '@nestjs/common';
import { ProfileService } from './profile.service';

describe('Profile cover uploads', () => {
  const file = { buffer: Buffer.from('synthetic-image'), mimetype: 'image/png', size: 15 };
  function setup() {
    const prisma = { userProfile: {
      findUnique: jest.fn().mockResolvedValue({ coverStorageKey: 'profile-covers/previous.png' }),
      upsert: jest.fn().mockResolvedValue({ coverUrl: '/api/v1/media/public/new' }),
    } };
    const storage = {
      uploadCover: jest.fn().mockResolvedValue({ key: 'profile-covers/new.png', url: '/api/v1/media/public/new' }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    return { prisma, storage, service: new ProfileService(prisma as never, storage as never) };
  }

  it('stores a cover only for the authenticated owner and cleans the old image', async () => {
    const { prisma, storage, service } = setup();
    await expect(service.uploadCover('owner-id', file)).resolves.toEqual({ coverUrl: '/api/v1/media/public/new' });
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'owner-id' },
      create: { userId: 'owner-id', coverUrl: '/api/v1/media/public/new', coverStorageKey: 'profile-covers/new.png' },
      update: { coverUrl: '/api/v1/media/public/new', coverStorageKey: 'profile-covers/new.png' },
    });
    expect(storage.delete).toHaveBeenCalledWith('profile-covers/previous.png');
  });

  it('removes the newly uploaded object when persistence fails, preserving the old cover', async () => {
    const { prisma, storage, service } = setup();
    prisma.userProfile.upsert.mockRejectedValueOnce(new Error('write failed'));
    await expect(service.uploadCover('owner-id', file)).rejects.toThrow('write failed');
    expect(storage.delete).toHaveBeenCalledWith('profile-covers/new.png');
    expect(storage.delete).not.toHaveBeenCalledWith('profile-covers/previous.png');
  });

  it('rejects a missing file without writing a profile or object', async () => {
    const { prisma, storage, service } = setup();
    await expect(service.uploadCover('owner-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.userProfile.upsert).not.toHaveBeenCalled();
    expect(storage.uploadCover).not.toHaveBeenCalled();
  });
});
