import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiGoneResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateMembershipCheckoutDto } from './dto/membership-plan.dto';
import { MembershipCheckoutService } from './membership-checkout.service';
import { membershipSalesRetired } from './membership-sales-retired';

@ApiTags('Membership')
@ApiBearerAuth()
@Controller('membership')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class MembershipCheckoutController {
  constructor(private readonly checkout: MembershipCheckoutService) {}

  @Get('catalog')
  @ApiOkResponse({ description: 'Empty retired-package catalog. Use GDS membership cards for current tiers.' })
  catalog(@CurrentUser('id') learnerId: string) { return { items: [], salesRetired: true }; }

  @Get('current')
  @ApiOkResponse({ description: 'The learner latest membership state and any pending plan change.' })
  current(@CurrentUser('id') learnerId: string) { return this.checkout.current(learnerId); }

  @Post('checkout')
  @ApiGoneResponse({ description: 'Package sales are retired. Use the GDS membership card endpoint.' })
  checkoutMembership(
    @CurrentUser('id') learnerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateMembershipCheckoutDto,
  ) {
    return membershipSalesRetired();
  }
}
