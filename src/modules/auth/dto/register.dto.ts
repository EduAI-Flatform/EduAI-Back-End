import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleName } from '../../../../generated/prisma/client';

type RegistrationRole = Extract<RoleName, 'student' | 'instructor'>;

export class RegisterDto {
  @ApiProperty({ example: 'student@example.com' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Str0ngPassword!123', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Student User' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;

  @ApiPropertyOptional({
    enum: [RoleName.student, RoleName.instructor],
    example: RoleName.student,
    description: 'Requested account role. Defaults to student.',
  })
  @IsOptional()
  @IsIn([RoleName.student, RoleName.instructor])
  role?: RegistrationRole;
}
