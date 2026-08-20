import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobStatus } from '../../../generated/prisma/client';
import { JobsService } from './jobs.service';

describe('JobsService', () => {
  const job = {
    id: 'job-id', title: 'AI Engineer', companyName: 'EduAI', summary: 'Build AI learning products',
    description: 'Detailed role', location: 'Ho Chi Minh City', workMode: 'hybrid',
    employmentType: 'full_time', salaryMin: null, salaryMax: null, salaryCurrency: null,
    status: JobStatus.draft, publishedAt: null, closesAt: null,
    createdAt: new Date('2026-08-20'), updatedAt: new Date('2026-08-20'),
    requiredSkills: [{ name: 'TypeScript', level: 'advanced' }],
  };

  function setup() {
    const tx = {
      jobOpportunity: {
        create: jest.fn().mockResolvedValue(job), update: jest.fn().mockResolvedValue(job),
        findUnique: jest.fn().mockResolvedValue(job),
      },
      jobRequiredSkill: { deleteMany: jest.fn(), createMany: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
    };
    const prisma = {
      ...tx,
      jobOpportunity: {
        ...tx.jobOpportunity,
        findFirst: jest.fn().mockResolvedValue(job),
        findMany: jest.fn().mockResolvedValue([job]), count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn(async (input: unknown) => typeof input === 'function'
        ? (input as (client: typeof tx) => unknown)(tx)
        : Promise.all(input as Promise<unknown>[])),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return { service: new JobsService(prisma as never, audit as never), prisma, tx, audit };
  }

  it('creates a draft job and audits the admin mutation', async () => {
    const { service, tx, audit } = setup();
    await service.create('admin-id', {
      title: job.title, companyName: job.companyName, summary: job.summary,
      description: job.description, workMode: 'hybrid', employmentType: 'full_time',
      requiredSkills: [{ name: 'TypeScript', level: 'advanced' }],
    });
    expect(tx.jobOpportunity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ createdById: 'admin-id', status: JobStatus.draft }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-id' }), tx);
  });

  it('lists only published, unexpired, non-deleted jobs for students', async () => {
    const { service, prisma } = setup();
    await service.listPublic({ page: 1, pageSize: 20 });
    expect(prisma.jobOpportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: JobStatus.published, deletedAt: null }),
      skip: 0, take: 20,
    }));
  });

  it('keeps public detail hidden unless the job is published and active', async () => {
    const { service, prisma } = setup();
    prisma.jobOpportunity.findFirst.mockResolvedValue(null);
    await expect(service.getPublic('job-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects publishing a closed job', async () => {
    const { service, prisma } = setup();
    prisma.jobOpportunity.findUnique.mockResolvedValue({ ...job, status: JobStatus.closed });
    await expect(service.publish('admin-id', 'job-id')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects applications to closed or expired jobs', async () => {
    const { service, prisma } = setup();
    prisma.jobOpportunity.findFirst.mockResolvedValue(null);
    await expect(service.assertAcceptingApplications('job-id')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('paginates searchable public jobs', async () => {
    const { service, prisma } = setup();
    const result = await service.listPublic({ page: 2, pageSize: 10, search: 'AI' });
    expect(result).toEqual(expect.objectContaining({ page: 2, pageSize: 10, total: 1, totalPages: 1 }));
    expect(prisma.jobOpportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  });
});
