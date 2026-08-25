import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateMembershipCheckoutDto } from './dto/membership-plan.dto';
import { MembershipCheckoutService } from './membership-checkout.service';

@ApiTags('Membership')
@ApiBearerAuth()
@Controller('membership')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class MembershipCheckoutController {
  constructor(private readonly checkout: MembershipCheckoutService) {}

  @Get('catalog')
  @ApiOkResponse({ description: 'Published membership versions and authoritative duration pricing.' })
  catalog() { return this.checkout.catalog(); }

  @Get('current')
  @ApiOkResponse({ description: 'The learner current active membership, when present.' })
  current(@CurrentUser('id') learnerId: string) { return this.checkout.current(learnerId); }

  @Post('checkout')
  @ApiCreatedResponse({ description: 'Pending membership order and immutable checkout intent.' })
  checkoutMembership(
    @CurrentUser('id') learnerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateMembershipCheckoutDto,
  ) { return this.checkout.createCheckout(learnerId, idempotencyKey, input); }
}
