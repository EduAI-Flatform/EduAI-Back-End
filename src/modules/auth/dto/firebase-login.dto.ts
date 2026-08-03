import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { RoleName } from '../../../../generated/prisma/client';

export type FirebaseAuthMode = 'login' | 'register';

export class FirebaseLoginDto {
  @ApiProperty({
    description: 'Firebase ID token returned by the Firebase client SDK.',
    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsString()
  @MinLength(1)
  idToken!: string;

  @ApiProperty({
    enum: [RoleName.student, RoleName.instructor],
    required: false,
    description:
      'Requested role for a new Firebase user. Existing user roles are preserved.',
  })
  @IsOptional()
  @IsIn([RoleName.student, RoleName.instructor])
  role?: Extract<RoleName, 'student' | 'instructor'>;

  @ApiProperty({
    enum: ['login', 'register'],
    required: false,
    description:
      'Authentication intent. Register rejects an already existing account.',
  })
  @IsOptional()
  @IsIn(['login', 'register'])
  mode?: FirebaseAuthMode;
}
