import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class CommunityPostAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Nguyễn Minh Anh' })
  fullName!: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl!: string | null;
}

export class CommunityPostResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ example: 'public' })
  visibility!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: CommunityPostAuthorDto })
  author!: CommunityPostAuthorDto;

  @ApiProperty({ minimum: 0 })
  reactionCount!: number;

  @ApiProperty({ minimum: 0 })
  commentCount!: number;

  @ApiProperty({
    description: 'True only when a valid optional bearer token liked this post.',
  })
  viewerHasLiked!: boolean;
}
