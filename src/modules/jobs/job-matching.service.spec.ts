import { BadRequestException } from '@nestjs/common';
import { CourseStatus, CourseVisibility, JobStatus, ModerationStatus } from '../../../generated/prisma/client';
import { JobMatchingService } from './job-matching.service';

describe('JobMatchingService', () => {
  const activeJob = {
    id: 'job-id', title: 'Backend Engineer', companyName: 'EduAI',
    requiredSkills: [{ name: ' TypeScript ', level: 'advanced' }, { name: 'NestJS', level: null }],
  };
  const prisma = {
    jobOpportunity: { findFirst: jest.fn() },
    userSkill: { findMany: jest.fn() },
    course: { findMany: jest.fn() },
    jobApplication: { findMany: jest.fn(), update: jest.fn() },
  };
  let service: JobMatchingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new JobMatchingService(prisma as never);
    prisma.jobOpportunity.findFirst.mockResolvedValue(activeJob);
    prisma.userSkill.findMany.mockResolvedValue([{ name: 'typescript', level: 'advanced' }]);
    prisma.course.findMany.mockResolvedValue([{ id: 'course-id', title: 'NestJS Foundations', slug: 'nestjs-foundations', description: 'Build APIs', thumbnailUrl: null, level: 'beginner', categorySlug: 'backend' }]);
  });

  it('returns a reproducible score and explains missing skills', async () => {
    const first = await service.match('student-id', 'job-id');
    const second = await service.match('student-id', 'job-id');

    expect(first).toEqual(second);
    expect(first.fitScore).toBe(50);
    expect(first.matchedSkills).toEqual([{ name: 'TypeScript', requiredLevel: 'advanced', learnerLevel: 'advanced' }]);
    expect(first.missingSkills).toEqual([{ name: 'NestJS', requiredLevel: null, learnerLevel: null, reason: 'missing' }]);
    expect(first.explanation).toContain('1 of 2');
    expect(first.courseRecommendations).toEqual([{ id: 'course-id', title: 'NestJS Foundations', slug: 'nestjs-foundations', thumbnailUrl: null, level: 'beginner', matchedMissingSkills: ['NestJS'] }]);
  });

  it('explains a known proficiency gap without counting it as a match', async () => {
    prisma.jobOpportunity.findFirst.mockResolvedValue({ ...activeJob, requiredSkills: [{ name: 'TypeScript', level: 'advanced' }] });
    prisma.userSkill.findMany.mockResolvedValue([{ name: 'TypeScript', level: 'intermediate' }]);
    prisma.course.findMany.mockResolvedValue([]);

    await expect(service.match('student-id', 'job-id')).resolves.toMatchObject({
      fitScore: 0,
      matchedSkills: [],
      missingSkills: [{ name: 'TypeScript', requiredLevel: 'advanced', learnerLevel: 'intermediate', reason: 'level_gap' }],
    });
  });

  it('chooses a satisfying proficiency deterministically when legacy duplicate skills exist', async () => {
    prisma.jobOpportunity.findFirst.mockResolvedValue({ ...activeJob, requiredSkills: [{ name: 'TypeScript', level: 'advanced' }] });
    prisma.userSkill.findMany.mockResolvedValue([{ name: 'TypeScript', level: 'beginner' }, { name: 'typescript', level: 'advanced' }]);
    await expect(service.match('student-id', 'job-id')).resolves.toMatchObject({ fitScore: 100, matchedSkills: [{ learnerLevel: 'advanced' }] });
  });

  it('recommends only accessible published courses and never touches applications', async () => {
    await service.match('student-id', 'job-id');

    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: CourseStatus.published, visibility: CourseVisibility.public, moderationStatus: ModerationStatus.clear, deletedAt: null }),
    }));
    expect(prisma.jobApplication.findMany).not.toHaveBeenCalled();
    expect(prisma.jobApplication.update).not.toHaveBeenCalled();
  });

  it('returns a perfect deterministic score when the job has no required skills', async () => {
    prisma.jobOpportunity.findFirst.mockResolvedValue({ ...activeJob, requiredSkills: [] });
    await expect(service.match('student-id', 'job-id')).resolves.toMatchObject({ fitScore: 100, matchedSkills: [], missingSkills: [], courseRecommendations: [] });
    expect(prisma.course.findMany).not.toHaveBeenCalled();
  });

  it('rejects jobs that are not actively published', async () => {
    prisma.jobOpportunity.findFirst.mockResolvedValue(null);
    await expect(service.match('student-id', 'job-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.jobOpportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: JobStatus.published, deletedAt: null }) }));
  });
});
