import { ApiProperty } from '@nestjs/swagger';

export class AiLearningPathMilestoneResponseDto {
  @ApiProperty() courseId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() priority!: number;
}

export class AiLearningPathOutputResponseDto {
  @ApiProperty({ example: 'v1' }) schemaVersion!: string;
  @ApiProperty({ type: AiLearningPathMilestoneResponseDto, isArray: true }) milestones!: AiLearningPathMilestoneResponseDto[];
}

export class AiLearningPathResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: AiLearningPathOutputResponseDto }) path!: AiLearningPathOutputResponseDto;
}
