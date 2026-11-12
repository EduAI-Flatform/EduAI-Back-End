import { Body, Controller, Get, GoneException, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiGoneResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
  catalog(@CurrentUser('id') learnerId: string) { return this.checkout.catalog(learnerId); }

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
    throw new GoneException({ error: 'MEMBERSHIP_SALES_RETIRED', message: 'Membership packages have been replaced by GDS membership cards.' });
  }
}
