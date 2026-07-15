import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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
import { CreateLibraryResourceDto } from './dto/create-library-resource.dto';
import { ListLibraryResourcesQueryDto } from './dto/list-library-resources-query.dto';
import { LibraryR2StorageService, MAX_LIBRARY_FILE_SIZE_BYTES } from './library-r2-storage.service';
import {
  LibraryResourceResponse,
  LibraryFavoriteActionResponse,
  LibraryResourceService,
  PaginatedLibraryResourceResponse,
} from './library-resource.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UploadedLibraryFile } from './types/library-upload.types';

@ApiTags('Library resources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('library/resources')
export class LibraryResourceController {
  constructor(private readonly service: LibraryResourceService) {}

  @Get()
  @ApiOkResponse({ description: 'Library resources returned successfully.' })
  listResources(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLibraryResourcesQueryDto,
  ): Promise<PaginatedLibraryResourceResponse> {
    return this.service.listResources(user.id, user.roles, query);
  }

  @Get('favorites')
  @ApiOkResponse({ description: 'Current user favorites returned successfully.' })
  listFavorites(@CurrentUser() user: AuthenticatedUser): Promise<LibraryResourceResponse[]> {
    return this.service.listFavorites(user.id, user.roles);
  }

  @Post(':id/favorite')
  @ApiOkResponse({ description: 'Resource added to favorites.' })
  @ApiNotFoundResponse({ description: 'Library resource not found or not visible.' })
  favoriteResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) resourceId: string,
  ): Promise<LibraryFavoriteActionResponse> {
    return this.service.favoriteResource(user.id, user.roles, resourceId);
  }

  @Delete(':id/favorite')
  @ApiOkResponse({ description: 'Resource removed from favorites.' })
  @ApiNotFoundResponse({ description: 'Library resource not found or not visible.' })
  unfavoriteResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) resourceId: string,
  ): Promise<LibraryFavoriteActionResponse> {
    return this.service.unfavoriteResource(user.id, user.roles, resourceId);
  }

  @Post()
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_LIBRARY_FILE_SIZE_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'title', 'categoryId', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string' },
        description: { type: 'string' },
        categoryId: { type: 'string', format: 'uuid' },
        type: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'video', 'image'] },
        visibility: { type: 'string', enum: ['public', 'private'] },
        tagIds: { type: 'string', example: '["uuid"]' },
      },
    },
  })
  @ApiCreatedResponse({ description: 'Library resource uploaded successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid resource or file.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Library category not found.' })
  createResource(
    @CurrentUser('id') ownerId: string,
    @Body() input: CreateLibraryResourceDto,
    @UploadedFile() file?: UploadedLibraryFile,
  ): Promise<LibraryResourceResponse> {
    return this.service.createResource(ownerId, input, file);
  }
}
