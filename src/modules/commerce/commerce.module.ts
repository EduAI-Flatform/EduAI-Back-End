import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CommerceController } from './commerce.controller';
import { CommerceService } from './commerce.service';
import { CommerceOrderService } from './commerce-order.service';
import { VouchersModule } from '../vouchers/vouchers.module';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, VouchersModule],
  controllers: [CommerceController],
  providers: [CommerceService, CommerceOrderService],
  exports: [CommerceService, CommerceOrderService],
})
export class CommerceModule {}
