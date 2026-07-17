import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  CertificateResponse,
  CertificateVerificationResponse,
  CertificatesService,
} from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

@ApiTags('Certificates')
@Controller()
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post('certificates/issue')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiCreatedResponse({ description: 'Certificate issued successfully.' })
  @ApiBadRequestResponse({ description: 'Course is not completed.' })
  @ApiNotFoundResponse({ description: 'Enrollment or certificate template not found.' })
  issueCertificate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: IssueCertificateDto,
  ): Promise<CertificateResponse> {
    return this.certificatesService.issueCertificate(user.id, input);
  }

  @Get('certificates/verify/:code')
  @ApiOkResponse({ description: 'Public certificate verification returned successfully.' })
  @ApiNotFoundResponse({ description: 'Certificate not found.' })
  verifyCertificate(@Param('code') code: string): Promise<CertificateVerificationResponse> {
    return this.certificatesService.verifyCertificate(code);
  }
}
