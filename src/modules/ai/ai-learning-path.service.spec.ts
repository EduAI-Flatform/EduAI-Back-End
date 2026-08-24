import { BadGatewayException } from '@nestjs/common';
import { CourseVisibility, RoleName } from '../../../generated/prisma/client';
import { AiLearningPathService } from './ai-learning-path.service';

const student = { id: 'student-id', roles: [RoleName.student] } as never;

function createService(content = JSON.stringify({ schemaVersion: 'v1', milestones: [{ courseId: 'course-1', reason: 'Matches the learner goal', priority: 1 }] })) {
  const prisma = {
    learningProfile: { findUnique: jest.fn().mockResolvedValue({ learningGoal: 'Learn AI', currentLevel: 'beginner', weeklyAvailabilityHours: 4, skillGaps: [] }) },
    course: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'course-1',
          title: 'Public course',
          slug: 'public-course',
          description: 'Safe metadata',
          thumbnailUrl: null,
          level: 'beginner',
          visibility: CourseVisibility.public,
          enrollments: [],
          progress: [],
          quizzes: [{ _count: { attempts: 1 }, attempts: [{ id: 'attempt-1' }] }],
          assignments: [{ _count: { submissions: 1 }, submissions: [{ id: 'submission-1' }] }],
        },
      ]),
    },
    aiLearningPath: { findFirst: jest.fn().mockResolvedValue({ version: 2 }), create: jest.fn().mockResolvedValue({ id: 'path-1', version: 3 }) },
  };
  const quota = { assertLearningPathAllowed: jest.fn() };
  const provider = { complete: jest.fn().mockResolvedValue({ content }), getModel: jest.fn().mockReturnValue('mock') };
  const courseAccess = { decide: jest.fn().mockResolvedValue({ allowed: true }) };
  return { service: new AiLearningPathService(prisma as never, quota as never, provider as never, courseAccess as never), prisma, quota, provider, courseAccess };
}

describe('AiLearningPathService', () => {
  it('persists a validated new version using only accessible-course metadata', async () => {
    const { service, prisma, quota } = createService();
    await expect(service.regenerate(student)).resolves.toMatchObject({ id: 'path-1', version: 3 });
    expect(quota.assertLearningPathAllowed).toHaveBeenCalledWith('student-id');
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'published' }),
      select: expect.objectContaining({
        quizzes: expect.objectContaining({
          select: expect.objectContaining({ attempts: expect.objectContaining({ take: 1 }) }),
        }),
        assignments: expect.objectContaining({
          select: expect.objectContaining({ submissions: expect.objectContaining({ take: 1 }) }),
        }),
      }),
    }));
    expect(prisma.aiLearningPath.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 3 }) }));
  });

  it('uses the learner\'s quiz and assignment completion summaries without exposing content', async () => {
    const { service, provider } = createService();

    await service.regenerate(student);

    const prompt = provider.complete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('"quizSummary":{"published":1,"attempted":1,"passed":1}');
    expect(prompt).toContain('"assignmentSummary":{"published":1,"submitted":1,"graded":1}');
    expect(prompt).not.toContain('answersJson');
    expect(prompt).not.toContain('content');
  });

  it('uses only Gemini-supported structured-output schema keywords', async () => {
    const { service, provider } = createService();

    await service.regenerate(student);

    const responseSchema = provider.complete.mock.calls[0][0].responseSchema as {
      properties: { schemaVersion: Record<string, unknown> };
    };
    expect(responseSchema.properties.schemaVersion).toEqual({
      type: 'string',
      enum: ['v1'],
    });
    expect(JSON.stringify(responseSchema)).not.toContain('"const"');
  });

  it('rejects provider paths that reference inaccessible courses before persistence', async () => {
    const { service, prisma } = createService(JSON.stringify({ schemaVersion: 'v1', milestones: [{ courseId: 'private-course', reason: 'No', priority: 1 }] }));
    await expect(service.regenerate(student)).rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.aiLearningPath.create).not.toHaveBeenCalled();
  });

  it('returns the latest learner-owned path with accessible course progress', async () => {
    const { service, prisma } = createService();
    prisma.aiLearningPath.findFirst.mockResolvedValue({
      id: 'path-1',
      version: 3,
      outputJson: {
        schemaVersion: 'v1',
        milestones: [
          { courseId: 'course-1', reason: 'Build foundations', priority: 1 },
          { courseId: 'unavailable-course', reason: 'Continue later', priority: 2 },
        ],
      },
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });

    await expect(service.getCurrent(student)).resolves.toEqual({
      id: 'path-1',
      version: 3,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      path: {
        schemaVersion: 'v1',
        milestones: [
          {
            courseId: 'course-1',
            reason: 'Build foundations',
            priority: 1,
            available: true,
            course: {
              id: 'course-1',
              title: 'Public course',
              slug: 'public-course',
              thumbnailUrl: null,
              level: 'beginner',
              progressPercent: 0,
              enrollmentStatus: null,
            },
          },
          {
            courseId: 'unavailable-course',
            reason: 'Continue later',
            priority: 2,
            available: false,
            course: null,
          },
        ],
      },
    });
    expect(prisma.aiLearningPath.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'student-id' },
      orderBy: { version: 'desc' },
    }));
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ['course-1', 'unavailable-course'] },
        moderationStatus: 'clear',
      }),
    }));
  });

  it('returns null when the learner has not generated a path', async () => {
    const { service, prisma } = createService();
    prisma.aiLearningPath.findFirst.mockResolvedValue(null);

    await expect(service.getCurrent(student)).resolves.toBeNull();
    expect(prisma.course.findMany).not.toHaveBeenCalled();
  });
});
