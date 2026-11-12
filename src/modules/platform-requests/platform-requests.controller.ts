import { Body, Controller, Header, StreamableFile, UploadedFile, UseInterceptors, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { Public } from '../../common/security/public.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateInvoiceRequestDto, CreatePartnerApplicationDto, CreateSupportTicketDto, PartnerListQueryDto, RequestListQueryDto, SupportListQueryDto, SupportReplyDto, UpdatePartnerApplicationDto, UpdateSupportTicketDto } from './platform-requests.dto';
import { PlatformRequestsService, SupportImageUpload } from './platform-requests.service';

@ApiTags('Support') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly requests: PlatformRequestsService) {}
  @Get() list(@CurrentUser('id') ownerId: string, @Query() query: SupportListQueryDto) { return this.requests.listSupport(ownerId, query); }
  @Post() @RateLimit({ identity: 'user', limit: 10, name: 'support-create', windowSeconds: 3600 })
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, parts: 3 } }))
  create(@CurrentUser('id') ownerId: string, @Body() input: CreateSupportTicketDto, @UploadedFile() image?: SupportImageUpload) { return this.requests.createSupport(ownerId, input, image); }
  @Get(':id/image') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async image(@CurrentUser('id') ownerId: string, @Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.requests.getSupportImage(ownerId, id), { type: 'image/png', disposition: 'inline' });
  }
  @Post('invoice-requests') @RateLimit({ identity: 'user', limit: 10, name: 'invoice-request', windowSeconds: 3600 })
  invoice(@CurrentUser('id') ownerId: string, @Body() input: CreateInvoiceRequestDto) { return this.requests.createInvoice(ownerId, input); }
  @Get(':id') detail(@CurrentUser('id') ownerId: string, @Param('id', ParseUUIDPipe) id: string, @Query() query: RequestListQueryDto) {
    return this.requests.getSupport(ownerId, id, query);
  }
  @Post(':id/replies') @RateLimit({ identity: 'user', limit: 30, name: 'support-reply', windowSeconds: 3600 })
  reply(@CurrentUser('id') ownerId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: SupportReplyDto) {
    return this.requests.reply(ownerId, id, input.content, false);
  }
}

@ApiTags('Partners') @Controller('platform/partner-applications')
export class PublicPartnerApplicationsController {
  constructor(private readonly requests: PlatformRequestsService) {}
  @Public() @Post() @RateLimit({ identity: 'ip', limit: 5, name: 'partner-apply', windowSeconds: 3600 })
  create(@Body() input: CreatePartnerApplicationDto) { return this.requests.createPartner(input); }
}

@ApiTags('Admin Requests') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
@Controller('admin/platform/requests')
export class AdminPlatformRequestsController {
  constructor(private readonly requests: PlatformRequestsService) {}
  @Get('readiness') readiness() { return this.requests.readiness(); }
  @Get('support') list(@Query() query: SupportListQueryDto) { return this.requests.listSupport(undefined, query); }
  @Get('support/:id/image') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async image(@Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.requests.getSupportImage(undefined, id), { type: 'image/png', disposition: 'inline' });
  }
  @Get('support/:id') detail(@Param('id', ParseUUIDPipe) id: string, @Query() query: RequestListQueryDto) { return this.requests.getSupport(undefined, id, query); }
  @Patch('support/:id') update(@CurrentUser('id') actorId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: UpdateSupportTicketDto) {
    return this.requests.updateSupport(actorId, id, input);
  }
  @Post('support/:id/replies') @RateLimit({ identity: 'user', limit: 60, name: 'support-admin-reply', windowSeconds: 3600 })
  reply(@CurrentUser('id') actorId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: SupportReplyDto) { return this.requests.reply(actorId, id, input.content, true); }
  @Get('partners') partners(@Query() query: PartnerListQueryDto) { return this.requests.listPartners(query); }
  @Patch('partners/:id') updatePartner(@CurrentUser('id') actorId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: UpdatePartnerApplicationDto) {
    return this.requests.updatePartner(actorId, id, input);
  }
}
