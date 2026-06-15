import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  DeletePortfolioResponse,
  PortfolioResponse,
} from './types/portfolio-response.types';
import { ProfileResponse } from './types/profile-response.types';
import { DeleteSkillResponse, SkillResponse } from './types/skill-response.types';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

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
  ): Promise<PortfolioResponse> {
    return this.prisma.portfolio.create({
      data: {
        userId,
        title: input.title,
        description: input.description,
        projectUrl: input.projectUrl,
        imageUrl: input.imageUrl,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    });
  }

  async updatePortfolio(
    userId: string,
    portfolioId: string,
    input: UpdatePortfolioDto,
  ): Promise<PortfolioResponse> {
    const data = this.removeUndefinedFields(input);
    const result = await this.prisma.portfolio.updateMany({
      where: {
        id: portfolioId,
        userId,
        deletedAt: null,
      },
      data,
    });

    if (result.count === 0) {
      throw new NotFoundException('Portfolio item not found');
    }

    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
    });

    if (!portfolio) {
      throw new NotFoundException('Portfolio item not found');
    }

    return portfolio;
  }

  async deletePortfolio(
    userId: string,
    portfolioId: string,
  ): Promise<DeletePortfolioResponse> {
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

    return { deleted: true };
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }
}
