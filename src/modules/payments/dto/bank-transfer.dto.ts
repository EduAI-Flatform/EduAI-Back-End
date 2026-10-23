import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreatePaymentMethodDto {
  @IsOptional() @IsIn(['payos', 'vnpay', 'bank_transfer'])
  provider?: 'payos' | 'vnpay' | 'bank_transfer';
}
export class BankSupportDto {
  @IsString() @Length(8, 300) reason!: string;
}
export class BankStatementDto {
  @Matches(/^\d{6}$/) bankBin!: string;
  @Matches(/^\d{6,19}$/) accountNumber!: string;
  @Matches(/^[A-Z0-9._:-]{1,100}$/) transactionId!: string;
  @Matches(/^[1-9]\d{0,14}$/) amountMinor!: string;
  @IsString() @Length(1, 160) transferContent!: string;
  @IsDateString() occurredAt!: string;
  @Matches(/^[A-Za-z0-9._:/-]{8,160}$/) statementReference!: string;
  @Matches(/^[a-f0-9]{64}$/) statementSha256!: string;
  // Explicit operator attestation; learner files and screenshots are never accepted here.
  @IsIn(['BANK_STATEMENT_CHECKED']) source!: 'BANK_STATEMENT_CHECKED';
  @IsOptional() @IsBoolean() suspicious?: boolean;
}

export class BankApprovalDto {
  @IsOptional() @IsString() @Length(8, 300) reason?: string;
  @IsIn(['BANK_STATEMENT_CHECKED']) source!: 'BANK_STATEMENT_CHECKED';
  @Matches(/^[a-f0-9]{64}$/) statementSha256!: string;
  @Matches(/^[A-Z0-9._:-]{1,100}$/) transactionId!: string;
  @Matches(/^[1-9]\d{0,14}$/) amountMinor!: string;
  @Matches(/^\d{6,19}$/) accountNumber!: string;
  @IsString() @Length(1, 160) transferContent!: string;
}
