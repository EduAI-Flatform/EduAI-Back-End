import { ApiProperty } from '@nestjs/swagger';

export class AiLearningPathMilestoneResponseDto {
  @ApiProperty() courseId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() priority!: number;
}

export class AiLearningPathCourseResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ nullable: true }) thumbnailUrl!: string | null;
  @ApiProperty() level!: string;
  @ApiProperty() progressPercent!: number;
  @ApiProperty({ nullable: true }) enrollmentStatus!: string | null;
}

export class AiLearningPathOutputResponseDto {
  @ApiProperty({ example: 'v1' }) schemaVersion!: string;
  @ApiProperty({ type: AiLearningPathMilestoneResponseDto, isArray: true }) milestones!: AiLearningPathMilestoneResponseDto[];
}

export class CurrentAiLearningPathMilestoneResponseDto extends AiLearningPathMilestoneResponseDto {
  @ApiProperty() available!: boolean;
  @ApiProperty({ nullable: true, type: () => AiLearningPathCourseResponseDto }) course!: AiLearningPathCourseResponseDto | null;
}

export class CurrentAiLearningPathOutputResponseDto {
  @ApiProperty({ example: 'v1' }) schemaVersion!: string;
  @ApiProperty({ type: CurrentAiLearningPathMilestoneResponseDto, isArray: true }) milestones!: CurrentAiLearningPathMilestoneResponseDto[];
}

export class AiLearningPathResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: AiLearningPathOutputResponseDto }) path!: AiLearningPathOutputResponseDto;
}

export class CurrentAiLearningPathResponseDto extends AiLearningPathResponseDto {
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: CurrentAiLearningPathOutputResponseDto }) declare path: CurrentAiLearningPathOutputResponseDto;
}
