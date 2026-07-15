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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCommunityPostDto } from './dto/create-community-post.dto';
import { UpdateCommunityPostDto } from './dto/update-community-post.dto';
import { CommunityService } from './community.service';

@ApiTags('Community posts')
@Controller('community/posts')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  @Get()
  @ApiOkResponse({ description: 'Active public community posts returned successfully.' })
  listPosts() {
    return this.communityService.listPosts();
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Community post returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiNotFoundResponse({ description: 'Community post not found.' })
  getPost(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.communityService.getPost(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Community post created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid community post payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  createPost(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCommunityPostDto,
  ) {
    return this.communityService.createPost(user, input);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Community post updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id or payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Only admins can moderate community posts.' })
  @ApiNotFoundResponse({ description: 'Community post not found for current user.' })
  updatePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateCommunityPostDto,
  ) {
    return this.communityService.updatePost(user, id, input);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Community post deleted successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Community post not found for current user.' })
  deletePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.communityService.deletePost(user, id);
  }
}
