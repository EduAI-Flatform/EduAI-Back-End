import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
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
import { Public } from '../../common/security/public.decorator';
import { PublicVerificationRateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  CertificateResponse,
  CertificateListItem,
  CertificateVerificationResponse,
  CertificatesService,
} from './certificates.service';
import {
  CertificateListItemDto,
  CertificateVerificationDto,
} from './dto/certificate-response.dto';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import { RevokeCertificateDto } from './dto/revoke-certificate.dto';

@ApiTags('Certificates')
@Controller()
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('me/certificates')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Current user certificates returned successfully.',
    type: CertificateListItemDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  listMyCertificates(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CertificateListItem[]> {
    return this.certificatesService.listMyCertificates(user.id);
  }

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

  @Patch('admin/certificates/:id/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Certificate revoked and retained for verification.' })
  @ApiNotFoundResponse({ description: 'Certificate not found.' })
  revokeCertificate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) certificateId: string,
    @Body() input: RevokeCertificateDto,
  ): Promise<CertificateResponse> {
    return this.certificatesService.revokeCertificate(user.id, certificateId, input);
  }

  @Get('certificates/verify/:code')
  @Public()
  @PublicVerificationRateLimit()
  @ApiOkResponse({
    description: 'Public certificate verification returned successfully.',
    type: CertificateVerificationDto,
  })
  @ApiNotFoundResponse({ description: 'Certificate not found.' })
  verifyCertificate(@Param('code') code: string): Promise<CertificateVerificationResponse> {
    return this.certificatesService.verifyCertificate(code);
  }
}
