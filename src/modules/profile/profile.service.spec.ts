import { ProfileService } from './profile.service';
import { NotFoundException } from '@nestjs/common';

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
  const skill = {
    id: 'skill-id',
    userId: 'user-id',
    name: 'Machine Learning',
    level: 'intermediate',
    category: 'AI',
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  };

  function createService() {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
        upsert: jest.fn().mockResolvedValue(profile),
      },
      userSkill: {
        create: jest.fn().mockResolvedValue(skill),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
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

  it('adds a skill for the authenticated user', async () => {
    const { prisma, service } = createService();

    await expect(
      service.addSkill('user-id', {
        name: 'Machine Learning',
        level: 'intermediate',
        category: 'AI',
      }),
    ).resolves.toEqual(skill);

    expect(prisma.userSkill.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        name: 'Machine Learning',
        level: 'intermediate',
        category: 'AI',
      },
    });
  });

  it('deletes only a skill owned by the authenticated user', async () => {
    const { prisma, service } = createService();

    await expect(service.deleteSkill('user-id', 'skill-id')).resolves.toEqual({
      deleted: true,
    });

    expect(prisma.userSkill.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'skill-id',
        userId: 'user-id',
      },
    });
  });

  it('rejects deleting a missing or unowned skill', async () => {
    const { prisma, service } = createService();
    prisma.userSkill.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.deleteSkill('user-id', 'skill-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
