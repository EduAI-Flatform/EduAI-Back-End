import { ProfileService } from './profile.service';

describe('ProfileService', () => {
  const profile = {
    id: 'profile-id',
    userId: 'user-id',
    phoneNumber: null,
    dateOfBirth: null,
    bio: 'Bio',
    headline: 'Learner',
    location: null,
    websiteUrl: null,
    publicSlug: null,
    isPublic: false,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  };

  function createService() {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
        upsert: jest.fn().mockResolvedValue(profile),
      },
    };

    return {
      prisma,
      service: new ProfileService(prisma as never),
    };
  }

  it('gets only the authenticated user profile', async () => {
    const { prisma, service } = createService();

    await expect(service.getCurrentProfile('user-id')).resolves.toEqual(profile);

    expect(prisma.userProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
    });
  });

  it('upserts only the authenticated user profile', async () => {
    const { prisma, service } = createService();

    await service.updateCurrentProfile('user-id', {
      bio: 'Updated bio',
      headline: null,
      isPublic: true,
    });

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
      create: {
        userId: 'user-id',
        bio: 'Updated bio',
        headline: null,
        isPublic: true,
      },
      update: {
        bio: 'Updated bio',
        headline: null,
        isPublic: true,
      },
    });
  });

  it('ignores undefined fields during profile updates', async () => {
    const { prisma, service } = createService();

    await service.updateCurrentProfile('user-id', {
      bio: undefined,
      location: 'Hà Nội',
    });

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
      create: {
        userId: 'user-id',
        location: 'Hà Nội',
      },
      update: {
        location: 'Hà Nội',
      },
    });
  });
});
