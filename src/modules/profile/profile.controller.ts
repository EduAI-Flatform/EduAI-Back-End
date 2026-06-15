import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';
import { ProfileResponse } from './types/profile-response.types';

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
}
