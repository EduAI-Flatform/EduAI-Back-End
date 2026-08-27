import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CommerceReconciliationKind, CommerceReconciliationStatus } from '../../../../generated/prisma/client';

export class RunPaymentReconciliationDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional() @IsUUID('4') cursor?: string;
}

export class ListPaymentReviewsDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsIn(Object.values(CommerceReconciliationStatus))
  status?: CommerceReconciliationStatus;
  @IsOptional() @IsIn(Object.values(CommerceReconciliationKind))
  kind?: CommerceReconciliationKind;
}

export class ResolvePaymentReviewDto {
  @IsIn(['acknowledged', 'retry_succeeded'])
  resolution!: 'acknowledged' | 'retry_succeeded';

  @IsDateString()
  expectedUpdatedAt!: string;
}
