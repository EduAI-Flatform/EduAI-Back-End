import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { JobApplicationsController } from './job-applications.controller';
import { JobApplicationsService } from './job-applications.service';

@Module({ imports: [PrismaModule, AuthModule, AuditModule, NotificationsModule], controllers: [JobsController, JobApplicationsController], providers: [JobsService, JobApplicationsService], exports: [JobsService, JobApplicationsService] })
export class JobsModule {}
