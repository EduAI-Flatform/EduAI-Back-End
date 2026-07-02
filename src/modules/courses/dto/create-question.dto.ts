import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Prisma, QuestionType } from '../../../../generated/prisma/client';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateQuestionDto {
  @ApiProperty({ enum: QuestionType, example: QuestionType.multiple_choice })
  @IsEnum(QuestionType)
  type!: QuestionType;

  @ApiProperty({ example: 'AI là gì?' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  questionText!: string;

  @ApiPropertyOptional({ type: 'array', items: { type: 'string' } })
  @IsOptional()
  @IsArray()
  optionsJson?: Prisma.InputJsonArray;

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
  correctAnswerJson!: Prisma.InputJsonValue;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  explanation?: string | null;

  @ApiProperty({ example: 1, minimum: 0.01, maximum: 100 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  points!: number;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  orderIndex!: number;
}
