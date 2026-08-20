import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { PublicCareerProfileResponse } from './types/career-profile-response.types';

@ApiTags('Public profiles')
@Controller('profiles')
export class PublicProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get(':publicSlug/career')
  @ApiOkResponse({ description: 'Published career profile returned without private fields.' })
  @ApiNotFoundResponse({ description: 'Published career profile not found.' })
  getPublicCareerProfile(
    @Param('publicSlug') publicSlug: string,
  ): Promise<PublicCareerProfileResponse> {
    return this.profileService.getPublicCareerProfile(publicSlug);
  }
}
