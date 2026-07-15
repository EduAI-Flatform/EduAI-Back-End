import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateCommunityPostDto } from './create-community-post.dto';

export class UpdateCommunityPostDto extends PartialType(CreateCommunityPostDto) {
  @ApiPropertyOptional({ enum: ['active', 'hidden'], description: 'Admin-only moderation status.' })
  @IsOptional()
  @IsIn(['active', 'hidden'])
  status?: 'active' | 'hidden';
}
