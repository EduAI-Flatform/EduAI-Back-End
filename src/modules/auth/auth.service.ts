import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { RegisterResponse } from './types/auth-response.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
  ) {}

  async register(input: RegisterDto): Promise<RegisterResponse> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    const passwordHash = await this.passwordService.hashPassword(input.password);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (existingUser) {
          throw new ConflictException('Email is already registered');
        }

        const studentRole = await tx.role.findUnique({
          where: { name: RoleName.student },
          select: { id: true, name: true },
        });

        if (!studentRole) {
          throw new InternalServerErrorException('Default student role is missing');
        }

        const user = await tx.user.create({
          data: {
            email,
            fullName,
            passwordHash,
          },
          select: {
            createdAt: true,
            email: true,
            fullName: true,
            id: true,
            status: true,
            updatedAt: true,
          },
        });

        await tx.userRole.create({
          data: {
            roleId: studentRole.id,
            userId: user.id,
          },
        });

        return {
          user: {
            ...user,
            roles: [studentRole.name],
          },
        };
      });
    } catch (error) {
      if (this.isEmailConflict(error)) {
        throw new ConflictException('Email is already registered');
      }

      throw error;
    }
  }

  private isEmailConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002' &&
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'target' in error.meta &&
      Array.isArray(error.meta.target) &&
      error.meta.target.includes('email')
    );
  }
}
