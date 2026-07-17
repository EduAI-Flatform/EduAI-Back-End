import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CertificateResponse, CertificatesService } from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

@ApiTags('Certificates')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Student role required.' })
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post('certificates/issue')
  @Roles(RoleName.student)
  @ApiCreatedResponse({ description: 'Certificate issued successfully.' })
  @ApiBadRequestResponse({ description: 'Course is not completed.' })
  @ApiNotFoundResponse({ description: 'Enrollment or certificate template not found.' })
  issueCertificate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: IssueCertificateDto,
  ): Promise<CertificateResponse> {
    return this.certificatesService.issueCertificate(user.id, input);
  }
}
