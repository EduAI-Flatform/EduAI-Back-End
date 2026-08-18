import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ScholarshipsController } from './scholarships.controller';
import { ScholarshipsService } from './scholarships.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [ScholarshipsController],
  providers: [ScholarshipsService],
  exports: [ScholarshipsService],
})
export class ScholarshipsModule {}
