import { ApiProperty } from '@nestjs/swagger';

class AdminUserMetricsDto {
  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  active!: number;

  @ApiProperty({ minimum: 0 })
  inactive!: number;

  @ApiProperty({ minimum: 0 })
  suspended!: number;
}

class AdminRoleMetricsDto {
  @ApiProperty({ minimum: 0, description: 'Student role assignments.' })
  student!: number;

  @ApiProperty({ minimum: 0, description: 'Instructor role assignments.' })
  instructor!: number;

  @ApiProperty({ minimum: 0, description: 'Platform administrator role assignments.' })
  platformAdmin!: number;
}

class AdminCourseMetricsDto {
  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  draft!: number;

  @ApiProperty({ minimum: 0 })
  published!: number;

  @ApiProperty({ minimum: 0 })
  archived!: number;
}

class AdminEnrollmentMetricsDto {
  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  active!: number;

  @ApiProperty({ minimum: 0 })
  completed!: number;

  @ApiProperty({ minimum: 0, description: 'Enrollments with another status.' })
  other!: number;
}

class AdminCertificateMetricsDto {
  @ApiProperty({ minimum: 0 })
  issued!: number;
}

class AdminAiUsageMetricsDto {
  @ApiProperty({ minimum: 0 })
  conversations!: number;

  @ApiProperty({ minimum: 0 })
  messages!: number;

  @ApiProperty({ minimum: 0 })
  generatedQuizzes!: number;

  @ApiProperty({ minimum: 0 })
  flashcards!: number;

  @ApiProperty({ minimum: 0 })
  embeddings!: number;
}

class AdminClassroomMetricsDto {
  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  scheduled!: number;

  @ApiProperty({ minimum: 0 })
  live!: number;

  @ApiProperty({ minimum: 0 })
  ended!: number;

  @ApiProperty({ minimum: 0 })
  cancelled!: number;
}

class AdminCommunityMetricsDto {
  @ApiProperty({ minimum: 0 })
  posts!: number;

  @ApiProperty({ minimum: 0 })
  comments!: number;

  @ApiProperty({ minimum: 0 })
  reactions!: number;
}

class AdminLibraryMetricsDto {
  @ApiProperty({ minimum: 0 })
  resources!: number;

  @ApiProperty({ minimum: 0 })
  categories!: number;

  @ApiProperty({ minimum: 0 })
  tags!: number;

  @ApiProperty({ minimum: 0 })
  savedResources!: number;
}

export class AdminOverviewResponseDto {
  @ApiProperty({ type: AdminUserMetricsDto })
  users!: AdminUserMetricsDto;

  @ApiProperty({ type: AdminRoleMetricsDto })
  roles!: AdminRoleMetricsDto;

  @ApiProperty({ type: AdminCourseMetricsDto })
  courses!: AdminCourseMetricsDto;

  @ApiProperty({ type: AdminEnrollmentMetricsDto })
  enrollments!: AdminEnrollmentMetricsDto;

  @ApiProperty({ type: AdminCertificateMetricsDto })
  certificates!: AdminCertificateMetricsDto;

  @ApiProperty({ type: AdminAiUsageMetricsDto })
  aiUsage!: AdminAiUsageMetricsDto;

  @ApiProperty({ type: AdminClassroomMetricsDto })
  classrooms!: AdminClassroomMetricsDto;

  @ApiProperty({ type: AdminCommunityMetricsDto })
  community!: AdminCommunityMetricsDto;

  @ApiProperty({ type: AdminLibraryMetricsDto })
  library!: AdminLibraryMetricsDto;
}
