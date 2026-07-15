import {
  Body,
  Controller,
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
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateLibraryResourceDto } from './dto/create-library-resource.dto';
import { LibraryR2StorageService, MAX_LIBRARY_FILE_SIZE_BYTES } from './library-r2-storage.service';
import { LibraryResourceResponse, LibraryResourceService } from './library-resource.service';
import { UploadedLibraryFile } from './types/library-upload.types';

@ApiTags('Library resources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('library/resources')
export class LibraryResourceController {
  constructor(private readonly service: LibraryResourceService) {}

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
