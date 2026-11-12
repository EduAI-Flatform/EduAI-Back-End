import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const LEGACY_INVENTORY_SOURCES = ['orders', 'subscriptions', 'course_grants', 'service_grants'] as const;
export const LEGACY_SOURCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class LegacyMembershipInventoryQuery {
  @ApiProperty({ enum: LEGACY_INVENTORY_SOURCES })
  @IsIn(LEGACY_INVENTORY_SOURCES)
  source!: typeof LEGACY_INVENTORY_SOURCES[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({ description: 'Last item UUID from the same source. Pagination is page-local, not a frozen global migration snapshot.' })
  @IsOptional() @Matches(LEGACY_SOURCE_UUID)
  after?: string;
}
