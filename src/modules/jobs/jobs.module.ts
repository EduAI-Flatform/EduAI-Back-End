import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({ imports: [PrismaModule, AuthModule, AuditModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
