import { IsString, Matches } from 'class-validator';

/** Decimal VND string; never accept a floating-point balance from the browser. */
export class GdsCreateTopupDto {
  @IsString()
  @Matches(/^[1-9]\d{0,8}$/)
  amountMinor!: string;
}
