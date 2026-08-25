import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CommerceController } from './commerce.controller';
import { CommerceService } from './commerce.service';
import { CommerceOrderService } from './commerce-order.service';
import { VouchersModule } from '../vouchers/vouchers.module';
import { CoursesModule } from '../courses/courses.module';
import { CommerceAdminController } from './commerce-admin.controller';
import { CommerceAdminService } from './commerce-admin.service';
import { CommerceProductService } from './commerce-product.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, VouchersModule, CoursesModule],
  controllers: [CommerceController, CommerceAdminController],
  providers: [CommerceService, CommerceOrderService, CommerceAdminService, CommerceProductService],
  exports: [CommerceService, CommerceOrderService, CommerceProductService],
})
export class CommerceModule {}
