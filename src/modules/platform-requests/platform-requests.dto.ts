import { Transform, Type } from 'class-transformer';
import { Equals, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const PARTNER_STATUSES = ['submitted', 'reviewing', 'contacted', 'accepted', 'rejected'] as const;
export const PARTNER_CATEGORIES = ['school', 'business', 'scholarship', 'digital'] as const;

export class CreateSupportTicketDto {
  @Transform(trimmed) @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @Transform(trimmed) @IsString() @MinLength(5) @MaxLength(10000) content!: string;
}
export class CreateInvoiceRequestDto {
  @IsUUID() orderId!: string;
  @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(180) recipientName!: string;
  @Transform(trimmed) @IsString() @Matches(/^[A-Za-z0-9-]{5,30}$/) taxCode!: string;
  @Transform(trimmed) @IsString() @MinLength(5) @MaxLength(500) billingAddress!: string;
  @Transform(trimmed) @IsEmail() @MaxLength(254) invoiceEmail!: string;
}
export class SupportReplyDto {
  @Transform(trimmed) @IsString() @MinLength(1) @MaxLength(10000) content!: string;
}
export class UpdateSupportTicketDto {
  @IsIn(SUPPORT_STATUSES) status!: typeof SUPPORT_STATUSES[number];
}
export class CreatePartnerApplicationDto {
  @IsIn(PARTNER_CATEGORIES) category!: typeof PARTNER_CATEGORIES[number];
  @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(180) organization!: string;
  @Transform(trimmed) @IsString() @Matches(/^[+()\d .-]{7,30}$/) phone!: string;
  @Transform(trimmed) @IsEmail() @MaxLength(254) email!: string;
  @Transform(trimmed) @IsString() @MinLength(10) @MaxLength(10000) content!: string;
  @Equals(true) consent!: boolean;
}
export class UpdatePartnerApplicationDto {
  @IsIn(PARTNER_STATUSES) status!: typeof PARTNER_STATUSES[number];
}
export class RequestListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
export class SupportListQueryDto extends RequestListQueryDto {
  @IsOptional() @IsIn(['support', 'invoice']) requestType?: 'support' | 'invoice';
  @IsOptional() @IsIn(SUPPORT_STATUSES) status?: typeof SUPPORT_STATUSES[number];
}
export class PartnerListQueryDto extends RequestListQueryDto {
  @IsOptional() @IsIn(PARTNER_STATUSES) status?: typeof PARTNER_STATUSES[number];
}
