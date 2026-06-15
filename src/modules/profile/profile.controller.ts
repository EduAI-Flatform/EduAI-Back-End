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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';
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
}
