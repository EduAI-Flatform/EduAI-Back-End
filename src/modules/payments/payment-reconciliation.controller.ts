import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ListPaymentReviewsDto, ResolvePaymentReviewDto, RunPaymentReconciliationDto } from './dto/payment-reconciliation.dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';

@ApiTags('Admin Payment Reconciliation')
@ApiBearerAuth()
@Controller('admin/commerce/reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class PaymentReconciliationController {
  constructor(private readonly service: PaymentReconciliationService) {}

  @Post('runs')
  @RateLimit({ identity: 'user', limit: 4, name: 'payment-reconciliation-run', windowSeconds: 60 })
  @ApiOkResponse({ description: 'Bounded payment reconciliation checkpoint.' })
  run(@CurrentUser('id') actorId: string, @Body() input: RunPaymentReconciliationDto) {
    return this.service.run(actorId, input);
  }

  @Get('cases')
  list(@Query() query: ListPaymentReviewsDto) {
    return this.service.list(query);
  }

  @Get('cases/:caseId')
  get(@Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string) {
    return this.service.get(caseId);
  }

  @Post('cases/:caseId/resolve')
  @RateLimit({ identity: 'user', limit: 10, name: 'payment-reconciliation-resolve', windowSeconds: 60 })
  resolve(
    @CurrentUser('id') actorId: string,
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: ResolvePaymentReviewDto,
  ) {
    return this.service.resolve(actorId, caseId, input);
  }
}
