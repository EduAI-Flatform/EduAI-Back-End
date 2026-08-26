import { ApiProperty } from '@nestjs/swagger';
import { AuditActorKind } from '../../../../generated/prisma/client';

class AuditActorResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  fullName!: string;
}

export class AuditLogItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: AuditActorKind })
  actorKind!: AuditActorKind;

  @ApiProperty({ format: 'uuid', nullable: true })
  actorId!: string | null;

  @ApiProperty({ example: 'COURSE_PUBLISHED' })
  action!: string;

  @ApiProperty({ example: 'course' })
  targetType!: string;

  @ApiProperty({ example: '6d30cb72-0f5a-43ca-bc70-269c6934b468' })
  targetId!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  metadataJson!: object;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: Date;

  @ApiProperty({ type: AuditActorResponseDto, nullable: true })
  actor!: AuditActorResponseDto | null;
}

export class PaginatedAuditLogResponseDto {
  @ApiProperty({ type: [AuditLogItemResponseDto] })
  items!: AuditLogItemResponseDto[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  totalPages!: number;
}
