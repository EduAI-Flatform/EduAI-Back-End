import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MAX_AVATAR_FILE_SIZE_BYTES } from './avatar-storage.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';
import {
  AvatarUploadResponse,
  UploadedAvatarFile,
} from './types/avatar-upload.types';
import {
  DeletePortfolioResponse,
  PortfolioResponse,
} from './types/portfolio-response.types';
import { ProfileResponse } from './types/profile-response.types';
import { DeleteSkillResponse, SkillResponse } from './types/skill-response.types';

@ApiTags('Profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('me')
  @ApiOkResponse({ description: 'Current user profile returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  getCurrentProfile(
    @CurrentUser('id') userId: string,
  ): Promise<ProfileResponse | null> {
    return this.profileService.getCurrentProfile(userId);
  }

  @Put('me')
  @ApiOkResponse({ description: 'Current user profile updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid profile payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  updateCurrentProfile(
    @CurrentUser('id') userId: string,
    @Body() input: UpdateProfileDto,
  ): Promise<ProfileResponse> {
    return this.profileService.updateCurrentProfile(userId, input);
  }

  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_AVATAR_FILE_SIZE_BYTES,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiCreatedResponse({ description: 'Avatar uploaded for current user.' })
  @ApiBadRequestResponse({ description: 'Invalid avatar file.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  uploadAvatar(
    @CurrentUser('id') userId: string,
    @UploadedFile() file?: UploadedAvatarFile,
  ): Promise<AvatarUploadResponse> {
    return this.profileService.uploadAvatar(userId, file);
  }

  @Get('skills')
  @ApiOkResponse({ description: 'Current user skills returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  listSkills(@CurrentUser('id') userId: string): Promise<SkillResponse[]> {
    return this.profileService.listSkills(userId);
  }

  @Post('skills')
  @ApiCreatedResponse({ description: 'Skill added to current user profile.' })
  @ApiBadRequestResponse({ description: 'Invalid skill payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  addSkill(
    @CurrentUser('id') userId: string,
    @Body() input: CreateSkillDto,
  ): Promise<SkillResponse> {
    return this.profileService.addSkill(userId, input);
  }

  @Delete('skills/:id')
  @ApiOkResponse({ description: 'Skill removed from current user profile.' })
  @ApiBadRequestResponse({ description: 'Invalid skill id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Skill not found for current user.' })
  deleteSkill(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) skillId: string,
  ): Promise<DeleteSkillResponse> {
    return this.profileService.deleteSkill(userId, skillId);
  }

  @Get('portfolio')
  @ApiOkResponse({ description: 'Current user portfolio items returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  listPortfolio(@CurrentUser('id') userId: string): Promise<PortfolioResponse[]> {
    return this.profileService.listPortfolio(userId);
  }

  @Post('portfolio')
  @ApiCreatedResponse({ description: 'Portfolio item added to current user profile.' })
  @ApiBadRequestResponse({ description: 'Invalid portfolio payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  createPortfolio(
    @CurrentUser('id') userId: string,
    @Body() input: CreatePortfolioDto,
  ): Promise<PortfolioResponse> {
    return this.profileService.createPortfolio(userId, input);
  }

  @Put('portfolio/:id')
  @ApiOkResponse({ description: 'Portfolio item updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid portfolio id or payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Portfolio item not found for current user.' })
  updatePortfolio(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) portfolioId: string,
    @Body() input: UpdatePortfolioDto,
  ): Promise<PortfolioResponse> {
    return this.profileService.updatePortfolio(userId, portfolioId, input);
  }

  @Delete('portfolio/:id')
  @ApiOkResponse({ description: 'Portfolio item soft deleted successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid portfolio id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiNotFoundResponse({ description: 'Portfolio item not found for current user.' })
  deletePortfolio(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) portfolioId: string,
  ): Promise<DeletePortfolioResponse> {
    return this.profileService.deletePortfolio(userId, portfolioId);
  }
}
