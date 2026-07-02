import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Prisma } from '../../../../generated/prisma/client';

export class QuizAnswerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  questionId!: string;

  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: {} },
      { type: 'object', additionalProperties: true },
    ],
  })
  @IsDefined()
  answer!: Prisma.InputJsonValue;
}

export class SubmitQuizAttemptDto {
  @ApiProperty({ type: [QuizAnswerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];
}
