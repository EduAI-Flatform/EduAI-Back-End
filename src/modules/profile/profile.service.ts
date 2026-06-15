import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
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

  private removeUndefinedFields(input: UpdateProfileDto): UpdateProfileDto {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as UpdateProfileDto;
  }
}
