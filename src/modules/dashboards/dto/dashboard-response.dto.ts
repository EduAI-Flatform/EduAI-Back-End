import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClassroomSessionStatus } from '../../../../generated/prisma/client';

class DashboardCourseSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  badge!: string | null;
}

class DashboardProgressDto {
  @ApiProperty({ minimum: 0 })
  completedLessons!: number;

  @ApiProperty({ minimum: 0 })
  totalLessons!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  progressPercent!: number;

  @ApiProperty({ minimum: 0 })
  completedMinutes!: number;

  @ApiProperty({ minimum: 0 })
  totalMinutes!: number;

  @ApiProperty({ minimum: 0 })
  remainingMinutes!: number;
}

class DashboardNextLessonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;
}

class DashboardActiveCourseDto {
  @ApiProperty({ format: 'uuid' })
  enrollmentId!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  enrolledAt!: Date;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  completedAt!: Date | null;

  @ApiProperty({ type: DashboardCourseSummaryDto })
  course!: DashboardCourseSummaryDto;

  @ApiProperty({ type: DashboardProgressDto })
  progress!: DashboardProgressDto;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  lastAccessedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: DashboardNextLessonDto })
  nextLesson!: DashboardNextLessonDto | null;
}

class DashboardSessionCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  slug!: string;
}

class DashboardSessionInstructorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl!: string | null;
}

export class DashboardSessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ format: 'date-time' })
  scheduledStart!: Date;

  @ApiProperty({ format: 'date-time' })
  scheduledEnd!: Date;

  @ApiPropertyOptional({ nullable: true })
  meetingUrl!: string | null;

  @ApiProperty({ enum: ClassroomSessionStatus })
  status!: ClassroomSessionStatus;

  @ApiProperty({ type: DashboardSessionCourseDto })
  course!: DashboardSessionCourseDto;

  @ApiProperty({ type: DashboardSessionInstructorDto })
  instructor!: DashboardSessionInstructorDto;
}

class WeeklyCompletedMinutesDto {
  @ApiProperty({ example: '2026-07-28' })
  date!: string;

  @ApiProperty({ minimum: 0 })
  minutes!: number;
}

class StudentDashboardStatisticsDto {
  @ApiProperty({ minimum: 0 })
  completedMinutes!: number;

  @ApiProperty({ minimum: 0 })
  completedCourses!: number;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 100 })
  averageQuizScore!: number | null;

  @ApiProperty({ minimum: 0 })
  completedLessons!: number;
}

class DashboardCertificateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  certificateCode!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  verificationUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  qrCodeUrl!: string | null;

  @ApiProperty()
  courseTitle!: string;
}

class DashboardActivityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: ['lesson_completed', 'quiz_attempt', 'certificate_issued'],
  })
  type!: 'lesson_completed' | 'quiz_attempt' | 'certificate_issued';

  @ApiProperty()
  title!: string;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: Date;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty()
  courseTitle!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 100 })
  score!: number | null;
}

export class StudentDashboardResponseDto {
  @ApiProperty({ type: DashboardActiveCourseDto, isArray: true })
  activeCourses!: DashboardActiveCourseDto[];

  @ApiPropertyOptional({ nullable: true, type: DashboardActiveCourseDto })
  continueCourse!: DashboardActiveCourseDto | null;

  @ApiProperty({ type: DashboardSessionDto, isArray: true })
  upcomingSessions!: DashboardSessionDto[];

  @ApiProperty({ type: WeeklyCompletedMinutesDto, isArray: true })
  weeklyCompletedMinutes!: WeeklyCompletedMinutesDto[];

  @ApiProperty({ type: StudentDashboardStatisticsDto })
  statistics!: StudentDashboardStatisticsDto;

  @ApiProperty({ type: DashboardCertificateDto, isArray: true })
  certificates!: DashboardCertificateDto[];

  @ApiProperty({ type: DashboardActivityDto, isArray: true })
  recentActivity!: DashboardActivityDto[];
}

class InstructorDashboardStatisticsDto {
  @ApiProperty({ minimum: 0 })
  publishedCourses!: number;

  @ApiProperty({ minimum: 0 })
  activeStudents!: number;

  @ApiProperty({ minimum: 0 })
  pendingSubmissions!: number;

  @ApiProperty({ minimum: 0 })
  upcomingSessions!: number;

  @ApiProperty({ minimum: 0 })
  todaySessions!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  completionRate!: number;
}

class InstructorWorkQueueItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['submission', 'session', 'draft_course'] })
  type!: 'submission' | 'session' | 'draft_course';

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ format: 'date-time' })
  dueAt!: Date;

  @ApiProperty({ enum: ['urgent', 'normal'] })
  priority!: 'urgent' | 'normal';
}

export class InstructorDashboardResponseDto {
  @ApiProperty({ type: InstructorDashboardStatisticsDto })
  statistics!: InstructorDashboardStatisticsDto;

  @ApiProperty({ type: DashboardSessionDto, isArray: true })
  upcomingSessions!: DashboardSessionDto[];

  @ApiProperty({ type: InstructorWorkQueueItemDto, isArray: true })
  workQueue!: InstructorWorkQueueItemDto[];
}
