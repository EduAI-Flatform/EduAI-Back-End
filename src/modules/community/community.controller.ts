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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../../common/security/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCommunityPostDto } from './dto/create-community-post.dto';
import { CreateCommunityCommentDto } from './dto/create-community-comment.dto';
import { UpdateCommunityPostDto } from './dto/update-community-post.dto';
import { CommunityPostResponseDto } from './dto/community-post-response.dto';
import { CommunityService } from './community.service';

@ApiTags('Community posts')
@Controller('community')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  @Get('posts')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Active public community posts returned successfully.',
    type: CommunityPostResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({ description: 'Supplied access token is invalid.' })
  listPosts(@CurrentUser() user: AuthenticatedUser | undefined) {
    return this.communityService.listPosts(user);
  }

  @Get('posts/:id')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Community post returned successfully.',
    type: CommunityPostResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiUnauthorizedResponse({ description: 'Supplied access token is invalid.' })
  @ApiNotFoundResponse({ description: 'Community post not found.' })
  getPost(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.communityService.getPost(user, id);
  }

  @Post('posts')
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

  @Put('posts/:id')
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

  @Delete('posts/:id')
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

  @Get('posts/:postId/comments')
  @Public()
  @ApiOkResponse({ description: 'Active comments and replies returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiNotFoundResponse({ description: 'Community post not found.' })
  listComments(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
  ) {
    return this.communityService.listComments(postId);
  }

  @Post('posts/:postId/comments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Community comment created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid comment or parent id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Community post or parent comment not found.' })
  createComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: CreateCommunityCommentDto,
  ) {
    return this.communityService.createComment(user, postId, input);
  }

  @Delete('comments/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Community comment deleted successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid comment id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Community comment not found for current user.' })
  deleteComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.communityService.deleteComment(user, id);
  }

  @Post('posts/:id/reactions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Community post liked successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Community post not found.' })
  @ApiConflictResponse({ description: 'Community post is already liked by the current user.' })
  likePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.communityService.likePost(user, id);
  }

  @Delete('posts/:id/reactions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Community post unliked successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid post id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Community post not found.' })
  unlikePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.communityService.unlikePost(user, id);
  }
}
