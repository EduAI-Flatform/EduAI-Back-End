import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const learningStepTypes = ['LESSON', 'ASSIGNMENT', 'QUIZ'] as const;
const learningStepStatuses = [
  'LOCKED',
  'AVAILABLE',
  'IN_PROGRESS',
  'COMPLETED',
] as const;

export class LearningStepResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: learningStepTypes })
  type!: (typeof learningStepTypes)[number];

  @ApiProperty()
  title!: string;

  @ApiProperty({ minimum: 0 })
  position!: number;

  @ApiProperty({
    description: 'Whether this step participates in course completion.',
  })
  isRequired!: boolean;

  @ApiProperty()
  completed!: boolean;

  @ApiProperty()
  inProgress!: boolean;

  @ApiProperty({ enum: learningStepStatuses })
  status!: (typeof learningStepStatuses)[number];

  @ApiProperty({ nullable: true })
  lockedReason!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  lessonId?: string | null;

  @ApiPropertyOptional()
  isPreview?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  progressPercent?: number;

  @ApiPropertyOptional({ minimum: 0 })
  watchedSeconds?: number;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  durationSeconds?: number | null;

  @ApiPropertyOptional({ minimum: 0 })
  lastPositionSeconds?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  documentProgressPercent?: number;
}

export class LearningPathResponseDto {
  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ type: LearningStepResponseDto, isArray: true })
  steps!: LearningStepResponseDto[];

  @ApiProperty({ type: LearningStepResponseDto, nullable: true })
  currentStep!: LearningStepResponseDto | null;

  @ApiProperty({ type: LearningStepResponseDto, nullable: true })
  nextStep!: LearningStepResponseDto | null;

  @ApiProperty({ type: String, format: 'uuid', isArray: true })
  completedLessonIds!: string[];

  @ApiProperty({ minimum: 0 })
  completedSteps!: number;

  @ApiProperty({ minimum: 0 })
  totalSteps!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  progressPercent!: number;

  @ApiProperty({
    description: 'Server-derived completion across required learning items.',
  })
  completed!: boolean;
}
