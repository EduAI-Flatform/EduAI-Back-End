import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminUserService } from './admin-user.service';
import { AdminService } from './admin.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [AdminController],
  providers: [AdminService, AdminUserService],
})
export class AdminModule {}
