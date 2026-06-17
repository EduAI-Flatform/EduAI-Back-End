import { ProfileService } from './profile.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

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
  const portfolio = {
    id: 'portfolio-id',
    userId: 'user-id',
    title: 'AI Learning Assistant',
    description: 'Project description',
    projectUrl: 'https://example.com/project',
    imageUrl: null,
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: null,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    deletedAt: null,
  };

  function createService() {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue(profile),
        upsert: jest.fn().mockResolvedValue(profile),
      },
      userSkill: {
        create: jest.fn().mockResolvedValue(skill),
        findMany: jest.fn().mockResolvedValue([skill]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      portfolio: {
        create: jest.fn().mockResolvedValue(portfolio),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(portfolio),
      },
      user: {
        update: jest.fn().mockResolvedValue({
          avatarUrl: 'https://cdn.example.com/avatars/generated.png',
        }),
      },
    };
    const avatarStorage = {
      uploadAvatar: jest.fn().mockResolvedValue({
        key: 'avatars/generated.png',
        url: 'https://cdn.example.com/avatars/generated.png',
      }),
    };

    return {
      avatarStorage,
      prisma,
      service: new ProfileService(prisma as never, avatarStorage as never),
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

  it('lists only skills owned by the authenticated user', async () => {
    const { prisma, service } = createService();

    await expect(service.listSkills('user-id')).resolves.toEqual([skill]);

    expect(prisma.userSkill.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
      orderBy: {
        createdAt: 'desc',
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

  it('creates a portfolio item for the authenticated user', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createPortfolio('user-id', {
        title: 'AI Learning Assistant',
        description: 'Project description',
        projectUrl: 'https://example.com/project',
      }),
    ).resolves.toEqual(portfolio);

    expect(prisma.portfolio.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        title: 'AI Learning Assistant',
        description: 'Project description',
        projectUrl: 'https://example.com/project',
        imageUrl: undefined,
        startDate: undefined,
        endDate: undefined,
      },
    });
  });

  it('updates only an owned active portfolio item', async () => {
    const { prisma, service } = createService();

    await expect(
      service.updatePortfolio('user-id', 'portfolio-id', {
        title: 'Updated project',
        description: undefined,
      }),
    ).resolves.toEqual(portfolio);

    expect(prisma.portfolio.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'portfolio-id',
        userId: 'user-id',
        deletedAt: null,
      },
      data: {
        title: 'Updated project',
      },
    });
    expect(prisma.portfolio.findUnique).toHaveBeenCalledWith({
      where: { id: 'portfolio-id' },
    });
  });

  it('rejects updating a missing, deleted, or unowned portfolio item', async () => {
    const { prisma, service } = createService();
    prisma.portfolio.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updatePortfolio('user-id', 'portfolio-id', {
        title: 'Updated project',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('soft deletes only an owned active portfolio item', async () => {
    const { prisma, service } = createService();

    await expect(
      service.deletePortfolio('user-id', 'portfolio-id'),
    ).resolves.toEqual({
      deleted: true,
    });

    expect(prisma.portfolio.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'portfolio-id',
        userId: 'user-id',
        deletedAt: null,
      },
      data: {
        deletedAt: expect.any(Date),
      },
    });
  });

  it('uploads an avatar and stores only the generated public URL', async () => {
    const { avatarStorage, prisma, service } = createService();
    const file = {
      buffer: Buffer.from('avatar'),
      mimetype: 'image/png',
      originalname: 'client-name.png',
      size: 6,
    };

    await expect(service.uploadAvatar('user-id', file)).resolves.toEqual({
      avatarUrl: 'https://cdn.example.com/avatars/generated.png',
    });

    expect(avatarStorage.uploadAvatar).toHaveBeenCalledWith(file);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: {
        avatarUrl: 'https://cdn.example.com/avatars/generated.png',
      },
      select: {
        avatarUrl: true,
      },
    });
  });

  it('rejects missing avatar files', async () => {
    const { avatarStorage, service } = createService();

    await expect(service.uploadAvatar('user-id')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(avatarStorage.uploadAvatar).not.toHaveBeenCalled();
  });
});
