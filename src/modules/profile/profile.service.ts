import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_UNPAGINATED_API_ITEMS } from '../../common/performance/list-limits';
import { AvatarStorageService } from './avatar-storage.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateLearningProfileDto } from './dto/update-learning-profile.dto';
import { UpdateCareerProfileDto } from './dto/update-career-profile.dto';
import {
  AvatarUploadResponse,
  UploadedAvatarFile,
} from './types/avatar-upload.types';
import {
  DeletePortfolioResponse,
  PortfolioResponse,
} from './types/portfolio-response.types';
import { ProfileResponse } from './types/profile-response.types';
import { LearningProfileResponse } from './types/learning-profile-response.types';
import { DeleteSkillResponse, SkillResponse } from './types/skill-response.types';
import {
  CareerProfileResponse,
  PublicCareerProfileResponse,
} from './types/career-profile-response.types';

const careerUserInclude = {
  profile: true,
  skills: { orderBy: { createdAt: 'desc' as const } },
  portfolios: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' as const },
  },
  enrollments: {
    where: { completedAt: { not: null } },
    orderBy: { completedAt: 'desc' as const },
    include: { course: { select: { title: true, slug: true, thumbnailUrl: true } } },
  },
  certificates: {
    where: { status: 'active' as const },
    orderBy: { issuedAt: 'desc' as const },
    include: { course: { select: { title: true, slug: true } } },
  },
};

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly avatarStorage: AvatarStorageService,
  ) {}

  async getCurrentProfile(userId: string): Promise<ProfileResponse | null> {
    return this.prisma.userProfile.findUnique({
      where: { userId },
    });
  }

  async updateCurrentProfile(
    userId: string,
    input: UpdateProfileDto,
  ): Promise<ProfileResponse> {
    const data = this.removeUndefinedFields(input);

    return this.prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...data,
      },
      update: data,
    });
  }

  async addSkill(userId: string, input: CreateSkillDto): Promise<SkillResponse> {
    return this.prisma.userSkill.create({
      data: {
        userId,
        name: input.name,
        level: input.level,
        category: input.category,
      },
    });
  }

  async listSkills(userId: string): Promise<SkillResponse[]> {
    return this.prisma.userSkill.findMany({
      where: { userId },
      orderBy: {
        createdAt: 'desc',
      },
      take: MAX_UNPAGINATED_API_ITEMS,
    });
  }

  async deleteSkill(userId: string, skillId: string): Promise<DeleteSkillResponse> {
    const result = await this.prisma.userSkill.deleteMany({
      where: {
        id: skillId,
        userId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Skill not found');
    }

    return { deleted: true };
  }

  async createPortfolio(
    userId: string,
    input: CreatePortfolioDto,
    image?: UploadedAvatarFile,
  ): Promise<PortfolioResponse> {
    const storedImage = image
      ? await this.avatarStorage.uploadPortfolioImage(image)
      : undefined;
    try {
      const portfolio = await this.prisma.portfolio.create({
        data: {
          userId,
          title: input.title,
          description: input.description,
          projectUrl: input.projectUrl,
          imageUrl: storedImage?.url ?? input.imageUrl,
          imageStorageKey: storedImage?.key,
          startDate: input.startDate,
          endDate: input.endDate,
        },
      });
      return this.toPortfolioResponse(portfolio);
    } catch (error) {
      if (storedImage) await this.deleteBestEffort(storedImage.key);
      throw error;
    }
  }

  async listPortfolio(userId: string): Promise<PortfolioResponse[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: MAX_UNPAGINATED_API_ITEMS,
    });
    return portfolios.map((portfolio) => this.toPortfolioResponse(portfolio));
  }

  async updatePortfolio(
    userId: string,
    portfolioId: string,
    input: UpdatePortfolioDto,
    image?: UploadedAvatarFile,
  ): Promise<PortfolioResponse> {
    const existing = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId, deletedAt: null },
      select: { imageStorageKey: true },
    });
    if (!existing) throw new NotFoundException('Portfolio item not found');
    const storedImage = image
      ? await this.avatarStorage.uploadPortfolioImage(image)
      : undefined;
    const data = this.removeUndefinedFields({
      ...input,
      imageUrl: storedImage?.url ?? input.imageUrl,
      imageStorageKey: storedImage?.key,
    });
    const result = await this.prisma.portfolio.updateMany({
      where: {
        id: portfolioId,
        userId,
        deletedAt: null,
      },
      data,
    });

    if (result.count === 0) {
      if (storedImage) await this.deleteBestEffort(storedImage.key);
      throw new NotFoundException('Portfolio item not found');
    }

    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
    });

    if (!portfolio) {
      throw new NotFoundException('Portfolio item not found');
    }

    if (storedImage && existing.imageStorageKey) {
      await this.deleteBestEffort(existing.imageStorageKey);
    }
    return this.toPortfolioResponse(portfolio);
  }

  async deletePortfolio(
    userId: string,
    portfolioId: string,
  ): Promise<DeletePortfolioResponse> {
    const existing = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId, deletedAt: null },
      select: { imageStorageKey: true },
    });
    if (!existing) throw new NotFoundException('Portfolio item not found');
    const result = await this.prisma.portfolio.updateMany({
      where: {
        id: portfolioId,
        userId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Portfolio item not found');
    }

    if (existing.imageStorageKey) {
      await this.deleteBestEffort(existing.imageStorageKey);
    }

    return { deleted: true };
  }

  async uploadAvatar(
    userId: string,
    file?: UploadedAvatarFile,
  ): Promise<AvatarUploadResponse> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }

    const previous = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarStorageKey: true },
    });
    const storedAvatar = await this.avatarStorage.uploadAvatar(file);
    let user;
    try {
      user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          avatarUrl: storedAvatar.url,
          avatarStorageKey: storedAvatar.key,
        },
        select: {
          avatarUrl: true,
        },
      });
    } catch (error) {
      await this.deleteBestEffort(storedAvatar.key);
      throw error;
    }
    if (previous?.avatarStorageKey) {
      await this.deleteBestEffort(previous.avatarStorageKey);
    }

    return {
      avatarUrl: user.avatarUrl ?? storedAvatar.url,
    };
  }

  async getCareerProfile(userId: string): Promise<CareerProfileResponse | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: careerUserInclude,
    });
    if (!user) return null;

    return {
      ...this.toCareerProjection(user, user.profile),
      email: user.email,
      publicSlug: user.profile?.publicSlug ?? null,
      isPublic: user.profile?.isPublic ?? false,
    };
  }

  async updateCareerProfile(
    userId: string,
    input: UpdateCareerProfileDto,
  ): Promise<CareerProfileResponse | null> {
    const data = this.removeUndefinedFields(input);
    await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.getCareerProfile(userId);
  }

  async getPublicCareerProfile(publicSlug: string): Promise<PublicCareerProfileResponse> {
    if (publicSlug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publicSlug)) {
      throw new NotFoundException('Career profile not found');
    }
    const profile = await this.prisma.userProfile.findFirst({
      where: { publicSlug, isPublic: true },
      include: { user: { include: careerUserInclude } },
    });
    if (!profile || !profile.publicSlug) {
      throw new NotFoundException('Career profile not found');
    }

    return {
      ...this.toCareerProjection(profile.user, profile),
      publicSlug: profile.publicSlug,
    };
  }

  async getLearningProfile(userId: string): Promise<LearningProfileResponse | null> {
    return this.prisma.learningProfile.findUnique({
      where: { userId },
      include: { skillGaps: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async updateLearningProfile(
    userId: string,
    input: UpdateLearningProfileDto,
  ): Promise<LearningProfileResponse | null> {
    this.assertUniqueSkillGapNames(input.skillGaps);
    const { skillGaps, ...profileInput } = input;
    const profileData = this.removeUndefinedFields(profileInput);

    return this.prisma.$transaction(async (tx) => {
      const isExplicitlyEmpty =
        profileInput.learningGoal === null &&
        profileInput.currentLevel === null &&
        profileInput.weeklyAvailabilityHours === null &&
        skillGaps?.length === 0;

      if (isExplicitlyEmpty) {
        const existingProfile = await tx.learningProfile.findUnique({
          where: { userId },
        });
        if (existingProfile) {
          await tx.learningProfile.delete({ where: { id: existingProfile.id } });
        }
        return null;
      }

      const profile = await tx.learningProfile.upsert({
        where: { userId },
        create: { userId, ...profileData },
        update: profileData,
      });

      if (skillGaps !== undefined) {
        await tx.learningSkillGap.deleteMany({ where: { profileId: profile.id } });
        if (skillGaps.length > 0) {
          await tx.learningSkillGap.createMany({
            data: skillGaps.map((skillGap) => ({ profileId: profile.id, ...skillGap })),
          });
        }
      }

      return tx.learningProfile.findUniqueOrThrow({
        where: { id: profile.id },
        include: { skillGaps: { orderBy: { createdAt: 'asc' } } },
      });
    });
  }

  private async deleteBestEffort(storageKey: string): Promise<void> {
    try {
      await this.avatarStorage.delete(storageKey);
    } catch {
      // The database remains authoritative; orphan cleanup can be retried separately.
    }
  }

  private toPortfolioResponse(
    portfolio: PortfolioResponse & { imageStorageKey?: string | null },
  ): PortfolioResponse {
    const { imageStorageKey: _storageKey, ...response } = portfolio;
    return response;
  }

  private toCareerProjection(
    user: {
      fullName: string;
      avatarUrl: string | null;
      skills: Array<{ name: string; level: string | null; category: string | null }>;
      portfolios: Array<{
        title: string; description: string | null; projectUrl: string | null;
        imageUrl: string | null; startDate: Date | null; endDate: Date | null;
      }>;
      enrollments: Array<{
        completedAt: Date | null;
        course: { title: string; slug: string; thumbnailUrl: string | null };
      }>;
      certificates: Array<{
        title: string; issuedAt: Date; verificationUrl: string | null;
        course: { title: string; slug: string };
      }>;
    },
    profile: {
      bio: string | null; headline: string | null; location: string | null;
      websiteUrl: string | null; careerGoal: string | null; preferredRoles: string[];
      preferredWorkModes: string[]; availabilityStatus: string | null;
      availableFrom: Date | null;
    } | null,
  ): Omit<PublicCareerProfileResponse, 'publicSlug'> {
    return {
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      bio: profile?.bio ?? null,
      headline: profile?.headline ?? null,
      location: profile?.location ?? null,
      websiteUrl: profile?.websiteUrl ?? null,
      careerGoal: profile?.careerGoal ?? null,
      preferredRoles: profile?.preferredRoles ?? [],
      preferredWorkModes: profile?.preferredWorkModes ?? [],
      availabilityStatus: profile?.availabilityStatus ?? null,
      availableFrom: profile?.availableFrom ?? null,
      skills: user.skills.map(({ name, level, category }) => ({ name, level, category })),
      portfolio: user.portfolios.map(({ title, description, projectUrl, imageUrl, startDate, endDate }) => ({
        title, description, projectUrl, imageUrl, startDate, endDate,
      })),
      completedCourses: user.enrollments
        .filter((enrollment): enrollment is typeof enrollment & { completedAt: Date } => Boolean(enrollment.completedAt))
        .map(({ completedAt, course }) => ({ ...course, completedAt })),
      certificates: user.certificates.map(({ title, issuedAt, verificationUrl, course }) => ({
        title,
        issuedAt,
        verificationUrl,
        courseTitle: course.title,
        courseSlug: course.slug,
      })),
    };
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private assertUniqueSkillGapNames(skillGaps: UpdateLearningProfileDto['skillGaps']): void {
    if (!skillGaps) return;
    const names = new Set<string>();
    for (const skillGap of skillGaps) {
      const normalizedName = skillGap.name.trim().toLocaleLowerCase();
      if (names.has(normalizedName)) {
        throw new BadRequestException('Learning skill gaps must have unique names');
      }
      names.add(normalizedName);
    }
  }
}
