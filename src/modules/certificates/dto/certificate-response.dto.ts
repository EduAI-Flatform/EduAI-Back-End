import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CertificateListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'CERT-1234' })
  certificateCode!: string;

  @ApiProperty({ example: 'AI Foundations' })
  title!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  verificationUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  qrCodeUrl!: string | null;

  @ApiProperty({ example: 'AI Foundations' })
  courseTitle!: string;
}

export class CertificateVerificationDto {
  @ApiProperty({ example: 'CERT-1234' })
  certificateCode!: string;

  @ApiProperty({ example: 'AI Foundations' })
  title!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  verificationUrl!: string | null;

  @ApiProperty({ example: 'AI Foundations' })
  courseTitle!: string;

  @ApiProperty({ example: 'Nguyễn Minh Anh' })
  recipientName!: string;
}
