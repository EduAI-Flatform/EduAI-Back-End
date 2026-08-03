import {
  ClassroomSessionStatus,
  CourseStatus,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { DashboardsService } from './dashboards.service';

const now = new Date('2026-07-28T10:00:00.000Z');

describe('DashboardsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aggregates the student dashboard from persisted learning data', async () => {
    const enrollment = {
      id: 'enrollment-id',
      status: 'active',
      enrolledAt: new Date('2026-07-01T00:00:00.000Z'),
      completedAt: null,
      updatedAt: new Date('2026-07-28T08:00:00.000Z'),
      course: {
        id: 'course-id',
        title: 'AI Foundations',
        slug: 'ai-foundations',
        thumbnailUrl: '/demo/courses/ai-foundations.svg',
        badge: 'Nổi bật',
        lessons: [
          {
            id: 'lesson-1',
            title: 'Introduction',
            orderIndex: 1,
            durationMinutes: 10,
          },
          {
            id: 'lesson-2',
            title: 'Models',
            orderIndex: 2,
            durationMinutes: 20,
          },
          {
            id: 'lesson-3',
            title: 'Practice',
            orderIndex: 3,
            durationMinutes: 30,
          },
        ],
        progress: [
          {
            lessonId: 'lesson-1',
            status: 'completed',
            progressPercent: 100,
            completedAt: new Date('2026-07-27T09:00:00.000Z'),
            lastAccessedAt: new Date('2026-07-27T09:00:00.000Z'),
          },
          {
            lessonId: 'lesson-2',
            status: 'in_progress',
            progressPercent: 50,
            completedAt: null,
            lastAccessedAt: new Date('2026-07-28T08:00:00.000Z'),
          },
        ],
      },
    };
    const completedProgress = [
      {
        id: 'progress-1',
        courseId: 'course-id',
        lessonId: 'lesson-1',
        completedAt: new Date('2026-07-27T09:00:00.000Z'),
        lesson: { title: 'Introduction', durationMinutes: 10 },
        course: {
          id: 'course-id',
          title: 'AI Foundations',
          slug: 'ai-foundations',
        },
      },
      {
        id: 'progress-2',
        courseId: 'completed-course-id',
        lessonId: 'completed-lesson-id',
        completedAt: new Date('2026-07-10T09:00:00.000Z'),
        lesson: { title: 'Final lesson', durationMinutes: 40 },
        course: {
          id: 'completed-course-id',
          title: 'Completed course',
          slug: 'completed-course',
        },
      },
    ];
    const quizAttempts = [
      {
        id: 'attempt-1',
        score: 8,
        maxScore: 10,
        submittedAt: new Date('2026-07-28T09:00:00.000Z'),
        quiz: {
          title: 'AI Quiz',
          courseId: 'course-id',
          course: { title: 'AI Foundations' },
        },
      },
      {
        id: 'attempt-2',
        score: 9,
        maxScore: 10,
        submittedAt: new Date('2026-07-20T09:00:00.000Z'),
        quiz: {
          title: 'Second Quiz',
          courseId: 'course-id',
          course: { title: 'AI Foundations' },
        },
      },
    ];
    const certificate = {
      id: 'certificate-id',
      certificateCode: 'CERT-DEMO',
      title: 'Completed course',
      issuedAt: new Date('2026-07-26T09:00:00.000Z'),
      verificationUrl: '/api/v1/certificates/verify/CERT-DEMO',
      qrCodeUrl: null,
      course: { id: 'completed-course-id', title: 'Completed course' },
    };
    const upcomingSession = {
      id: 'session-id',
      title: 'Live AI Workshop',
      scheduledStart: new Date('2026-07-29T12:00:00.000Z'),
      scheduledEnd: new Date('2026-07-29T13:00:00.000Z'),
      meetingUrl: 'https://meet.jit.si/demo',
      status: ClassroomSessionStatus.scheduled,
      course: {
        id: 'course-id',
        title: 'AI Foundations',
        slug: 'ai-foundations',
      },
      instructor: {
        id: 'instructor-id',
        fullName: 'Sarah Nguyen',
        avatarUrl: null,
      },
    };
    const prisma = {
      enrollment: {
        findMany: jest.fn().mockResolvedValue([enrollment]),
        count: jest.fn().mockResolvedValue(2),
      },
      learningProgress: {
        findMany: jest.fn().mockResolvedValue(completedProgress),
      },
      quizAttempt: {
        findMany: jest.fn().mockResolvedValue(quizAttempts),
      },
      classroomSession: {
        findMany: jest.fn().mockResolvedValue([upcomingSession]),
      },
      certificate: {
        findMany: jest.fn().mockResolvedValue([certificate]),
      },
    };
    const service = new DashboardsService(prisma as never);

    const result = await service.getStudentDashboard('student-id');

    expect(result.activeCourses).toEqual([
      {
        enrollmentId: enrollment.id,
        status: 'active',
        enrolledAt: enrollment.enrolledAt,
        completedAt: null,
        course: {
          id: 'course-id',
          title: 'AI Foundations',
          slug: 'ai-foundations',
          thumbnailUrl: '/demo/courses/ai-foundations.svg',
          badge: 'Nổi bật',
        },
        progress: {
          completedLessons: 1,
          totalLessons: 3,
          progressPercent: 33,
          completedMinutes: 10,
          totalMinutes: 60,
          remainingMinutes: 50,
        },
        lastAccessedAt: new Date('2026-07-28T08:00:00.000Z'),
        nextLesson: { id: 'lesson-2', title: 'Models' },
      },
    ]);
    expect(result.continueCourse).toEqual(result.activeCourses[0]);
    expect(result.upcomingSessions).toEqual([upcomingSession]);
    expect(result.weeklyCompletedMinutes).toEqual([
      { date: '2026-07-22', minutes: 0 },
      { date: '2026-07-23', minutes: 0 },
      { date: '2026-07-24', minutes: 0 },
      { date: '2026-07-25', minutes: 0 },
      { date: '2026-07-26', minutes: 0 },
      { date: '2026-07-27', minutes: 10 },
      { date: '2026-07-28', minutes: 0 },
    ]);
    expect(result.statistics).toEqual({
      completedMinutes: 50,
      completedCourses: 2,
      averageQuizScore: 85,
      completedLessons: 2,
    });
    expect(result.certificates).toEqual([
      {
        id: certificate.id,
        certificateCode: certificate.certificateCode,
        title: certificate.title,
        issuedAt: certificate.issuedAt,
        verificationUrl: certificate.verificationUrl,
        qrCodeUrl: certificate.qrCodeUrl,
        courseTitle: certificate.course.title,
      },
    ]);
    expect(result.recentActivity[0]).toEqual({
      id: 'quiz:attempt-1',
      type: 'quiz_attempt',
      title: 'AI Quiz',
      occurredAt: quizAttempts[0].submittedAt,
      courseId: 'course-id',
      courseTitle: 'AI Foundations',
      score: 80,
    });
  });

  it('returns safe empty and null aggregates when a student has no dashboard data', async () => {
    const prisma = {
      enrollment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      learningProgress: { findMany: jest.fn().mockResolvedValue([]) },
      quizAttempt: { findMany: jest.fn().mockResolvedValue([]) },
      classroomSession: { findMany: jest.fn().mockResolvedValue([]) },
      certificate: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new DashboardsService(prisma as never);

    await expect(service.getStudentDashboard('student-id')).resolves.toEqual(
      expect.objectContaining({
        activeCourses: [],
        continueCourse: null,
        upcomingSessions: [],
        statistics: {
          completedMinutes: 0,
          completedCourses: 0,
          averageQuizScore: null,
          completedLessons: 0,
        },
        certificates: [],
        recentActivity: [],
      }),
    );
  });

  it('aggregates instructor metrics and a prioritized work queue', async () => {
    const session = {
      id: 'session-id',
      title: 'Prompt Engineering Live',
      scheduledStart: new Date('2026-07-28T11:00:00.000Z'),
      scheduledEnd: new Date('2026-07-28T12:00:00.000Z'),
      meetingUrl: 'https://meet.jit.si/demo',
      status: ClassroomSessionStatus.scheduled,
      course: {
        id: 'course-id',
        title: 'AI Foundations',
        slug: 'ai-foundations',
      },
      instructor: {
        id: 'instructor-id',
        fullName: 'Sarah Nguyen',
        avatarUrl: null,
      },
    };
    const pendingSubmission = {
      id: 'submission-id',
      submittedAt: new Date('2026-07-27T09:00:00.000Z'),
      user: {
        id: 'student-id',
        fullName: 'Nguyễn Minh Anh',
        avatarUrl: null,
      },
      assignment: {
        id: 'assignment-id',
        title: 'AI Practice',
        dueDate: new Date('2026-07-28T09:00:00.000Z'),
        course: { id: 'course-id', title: 'AI Foundations' },
      },
    };
    const draftCourse = {
      id: 'draft-course-id',
      title: 'Advanced AI',
      updatedAt: new Date('2026-07-20T09:00:00.000Z'),
      _count: { lessons: 2 },
    };
    const prisma = {
      course: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockResolvedValue([draftCourse]),
      },
      enrollment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'student-1' }, { userId: 'student-2' }]),
        groupBy: jest.fn().mockResolvedValue([
          { status: 'active', _count: { _all: 3 } },
          { status: 'completed', _count: { _all: 2 } },
        ]),
      },
      submission: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([pendingSubmission]),
      },
      classroomSession: {
        findMany: jest.fn().mockResolvedValue([session]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new DashboardsService(prisma as never);
    const instructor = {
      id: 'instructor-id',
      roles: [RoleName.instructor],
    };

    const result = await service.getInstructorDashboard(instructor);

    expect(result.statistics).toEqual({
      publishedCourses: 3,
      activeStudents: 2,
      pendingSubmissions: 1,
      upcomingSessions: 1,
      todaySessions: 1,
      completionRate: 40,
    });
    expect(result.upcomingSessions).toEqual([session]);
    expect(result.workQueue).toEqual([
      {
        id: 'submission-id',
        type: 'submission',
        title: 'Chấm bài AI Practice',
        description: 'Nguyễn Minh Anh · AI Foundations',
        dueAt: new Date('2026-07-28T09:00:00.000Z'),
        priority: 'urgent',
      },
      {
        id: 'session-id',
        type: 'session',
        title: 'Prompt Engineering Live',
        description: 'AI Foundations',
        dueAt: new Date('2026-07-28T11:00:00.000Z'),
        priority: 'urgent',
      },
      {
        id: 'draft-course-id',
        type: 'draft_course',
        title: 'Hoàn thiện Advanced AI',
        description: '2 bài học đang soạn',
        dueAt: new Date('2026-07-20T09:00:00.000Z'),
        priority: 'normal',
      },
    ]);
    expect(prisma.enrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['userId'],
        select: { userId: true },
      }),
    );
    expect(prisma.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SubmissionStatus.submitted }),
        take: 3,
      }),
    );
  });

  it('lets platform admins aggregate all instructors without applying an owner id', async () => {
    const prisma = {
      course: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      enrollment: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      submission: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      classroomSession: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new DashboardsService(prisma as never);

    await service.getInstructorDashboard({
      id: 'admin-id',
      roles: [RoleName.platform_admin],
    });

    expect(prisma.course.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
      },
    });
  });
});
