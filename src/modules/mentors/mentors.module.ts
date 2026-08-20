import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MentorsController } from './mentors.controller';
import { MentorsService } from './mentors.service';

@Module({ imports: [PrismaModule, AuthModule, AuditModule], controllers: [MentorsController], providers: [MentorsService], exports: [MentorsService] })
export class MentorsModule {}
