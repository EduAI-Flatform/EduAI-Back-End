import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ServiceEntitlementService } from './service-entitlement.service';

@ApiTags('Membership Service Entitlements')
@ApiBearerAuth()
@Controller('membership/service-entitlements')
@UseGuards(JwtAuthGuard)
export class ServiceEntitlementController {
  constructor(private readonly service: ServiceEntitlementService) {}

  @Get()
  @ApiOkResponse({ description: 'Own service entitlement decisions and separate current-card quota facts. Authenticated accounts only; no caller-selected user ID.' })
  listOwn(@CurrentUser('id') userId: string) {
    return this.service.listForUser(userId);
  }
}
