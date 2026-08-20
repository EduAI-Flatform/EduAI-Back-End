import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { JobMatchingService } from './job-matching.service';

@ApiTags('Job matching')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('jobs')
export class JobMatchingController {
  constructor(private readonly matching: JobMatchingService) {}

  @Get(':jobId/match')
  @Roles(RoleName.student)
  @ApiOkResponse({ description: 'Deterministic learner skill fit and accessible course recommendations.' })
  match(@CurrentUser('id') userId: string, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) {
    return this.matching.match(userId, jobId);
  }
}
