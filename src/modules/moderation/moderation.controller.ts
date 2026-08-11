import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
  ListModerationQueryDto,
  ModerateTargetDto,
  ModerationTargetParamsDto,
} from './dto/moderation.dto';
import {
  ModerationDetailResponseDto,
  ModerationItemResponseDto,
  ModerationStatusResponseDto,
  PaginatedModerationResponseDto,
} from './dto/moderation-response.dto';
import {
  ModerationDetailResponse,
  ModerationItemResponse,
  ModerationService,
  ModerationStatusResponse,
  PaginatedModerationResponse,
} from './moderation.service';

@ApiTags('Admin moderation')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Platform administrator role required.' })
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get()
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({ type: PaginatedModerationResponseDto })
  list(
    @Query() query: ListModerationQueryDto,
  ): Promise<PaginatedModerationResponse> {
    return this.moderationService.list(query);
  }

  @Get(':targetType/:targetId')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({ type: ModerationDetailResponseDto })
  @ApiNotFoundResponse({ description: 'Moderation target not found.' })
  getDetail(
    @Param() params: ModerationTargetParamsDto,
  ): Promise<ModerationDetailResponse> {
    return this.moderationService.getDetail(
      params.targetType,
      params.targetId,
    );
  }

  @Patch(':targetType/:targetId')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({ type: ModerationItemResponseDto })
  @ApiBadRequestResponse({ description: 'Unsupported moderation transition.' })
  @ApiNotFoundResponse({ description: 'Moderation target not found.' })
  moderate(
    @Param() params: ModerationTargetParamsDto,
    @Body() input: ModerateTargetDto,
    @CurrentUser('id') actorId: string,
  ): Promise<ModerationItemResponse> {
    return this.moderationService.moderate(
      actorId,
      params.targetType,
      params.targetId,
      input,
    );
  }
}

@ApiTags('Moderation')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@Controller('moderation')
@UseGuards(JwtAuthGuard)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get(':targetType/:targetId/status')
  @ApiOkResponse({ type: ModerationStatusResponseDto })
  @ApiNotFoundResponse({ description: 'Owned moderation target not found.' })
  getStatus(
    @Param() params: ModerationTargetParamsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ModerationStatusResponse> {
    return this.moderationService.getOwnerStatus(
      user,
      params.targetType,
      params.targetId,
    );
  }
}
