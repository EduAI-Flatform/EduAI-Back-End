import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GdsWalletService } from './gds-wallet.service';

@ApiTags('GDS Wallet (sandbox only)')
@ApiBearerAuth()
@Controller('wallet/gds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class GdsWalletController {
  constructor(private readonly wallet: GdsWalletService) {}

  @Get()
  @RateLimit({ identity: 'user', limit: 30, name: 'gds-wallet-summary', windowSeconds: 60 })
  summary(@CurrentUser('id') buyerId: string) {
    return this.wallet.summary(buyerId);
  }
}
