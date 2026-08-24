import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ServiceEntitlementService } from './service-entitlement.service';

@ApiTags('Membership Service Entitlements')
@ApiBearerAuth()
@Controller('membership/service-entitlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class ServiceEntitlementController {
  constructor(private readonly service: ServiceEntitlementService) {}

  @Get()
  @ApiOkResponse({ description: 'Authenticated learner service entitlement decisions and remaining quotas.' })
  listOwn(@CurrentUser('id') userId: string) {
    return this.service.listForUser(userId);
  }
}
