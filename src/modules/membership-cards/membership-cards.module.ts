import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { MembershipCardsController } from './membership-cards.controller';

@Module({ imports: [AuthModule, PrismaModule, PlatformModule], controllers: [MembershipCardsController] })
export class MembershipCardsModule {}
