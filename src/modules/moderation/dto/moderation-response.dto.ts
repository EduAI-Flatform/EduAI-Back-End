import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ModerationStatus } from '../../../../generated/prisma/client';
import { AuditLogItemResponseDto } from '../../admin/dto/audit-log-response.dto';
import { MODERATION_TARGET_TYPES } from '../moderation.constants';

class ModerationOwnerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class ModerationItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MODERATION_TARGET_TYPES })
  targetType!: string;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  content!: string | null;

  @ApiProperty({ type: ModerationOwnerResponseDto })
  owner!: ModerationOwnerResponseDto;

  @ApiProperty({ enum: ModerationStatus })
  moderationStatus!: ModerationStatus;

  @ApiPropertyOptional({ nullable: true })
  moderationReason!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  moderatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class PaginatedModerationResponseDto {
  @ApiProperty({ type: [ModerationItemResponseDto] })
  items!: ModerationItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class ModerationDetailResponseDto {
  @ApiProperty({ type: ModerationItemResponseDto })
  item!: ModerationItemResponseDto;

  @ApiProperty({ type: [AuditLogItemResponseDto] })
  history!: AuditLogItemResponseDto[];
}

export class ModerationStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MODERATION_TARGET_TYPES })
  targetType!: string;

  @ApiProperty({ enum: ModerationStatus })
  moderationStatus!: ModerationStatus;

  @ApiPropertyOptional({ nullable: true })
  moderationReason!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  moderatedAt!: Date | null;
}
