import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CreateLibraryCategoryDto,
  CreateLibraryTagDto,
  UpdateLibraryCategoryDto,
  UpdateLibraryTagDto,
} from './dto/create-library-taxonomy.dto';
import { LibraryTaxonomyService } from './library-taxonomy.service';

const MANAGER_ROLES = [RoleName.instructor, RoleName.platform_admin] as const;

@ApiTags('Library taxonomy')
@Controller('library')
export class LibraryTaxonomyController {
  constructor(private readonly service: LibraryTaxonomyService) {}

  @Get('categories')
  @ApiOkResponse({ description: 'Library categories returned successfully.' })
  listCategories() {
    return this.service.listCategories();
  }

  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Library category created successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiConflictResponse({ description: 'Category slug is already in use.' })
  createCategory(@Body() input: CreateLibraryCategoryDto) {
    return this.service.createCategory(input);
  }

  @Put('categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Library category updated successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Library category not found.' })
  @ApiConflictResponse({ description: 'Category slug is already in use.' })
  updateCategory(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateLibraryCategoryDto,
  ) {
    return this.service.updateCategory(id, input);
  }

  @Delete('categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Library category deleted successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Library category not found.' })
  @ApiConflictResponse({ description: 'Category is still used by resources.' })
  async deleteCategory(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    await this.service.deleteCategory(id);
    return { success: true, message: 'Library category deleted successfully' };
  }

  @Get('tags')
  @ApiOkResponse({ description: 'Library tags returned successfully.' })
  listTags() {
    return this.service.listTags();
  }

  @Post('tags')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Library tag created successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiConflictResponse({ description: 'Tag slug is already in use.' })
  createTag(@Body() input: CreateLibraryTagDto) {
    return this.service.createTag(input);
  }

  @Put('tags/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Library tag updated successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Library tag not found.' })
  @ApiConflictResponse({ description: 'Tag slug is already in use.' })
  updateTag(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateLibraryTagDto,
  ) {
    return this.service.updateTag(id, input);
  }

  @Delete('tags/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Library tag deleted successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Library tag not found.' })
  async deleteTag(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    await this.service.deleteTag(id);
    return { success: true, message: 'Library tag deleted successfully' };
  }
}
