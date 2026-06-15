import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponse } from './types/profile-response.types';

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

  private removeUndefinedFields(input: UpdateProfileDto): UpdateProfileDto {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as UpdateProfileDto;
  }
}
