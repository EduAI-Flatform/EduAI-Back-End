import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RunPaymentExpiryDto } from './dto/payment-lifecycle.dto';
import { PaymentLifecycleService } from './payment-lifecycle.service';

@ApiTags('Admin Payment Lifecycle')
@ApiBearerAuth()
@Controller('admin/commerce/payment-lifecycle')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class PaymentLifecycleController {
  constructor(private readonly lifecycle: PaymentLifecycleService) {}

  @Post('expiry-runs')
  @RateLimit({ identity: 'user', limit: 4, name: 'payment-expiry-run', windowSeconds: 60 })
  @ApiOkResponse({ description: 'Bounded provider-authoritative expiry checkpoint.' })
  runExpiry(@CurrentUser('id') actorId: string, @Body() input: RunPaymentExpiryDto) {
    return this.lifecycle.runExpiry(actorId, input);
  }
}
