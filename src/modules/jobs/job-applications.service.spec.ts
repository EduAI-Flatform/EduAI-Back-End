import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { JobApplicationStatus, JobStatus } from '../../../generated/prisma/client';
import { JobApplicationsService } from './job-applications.service';

describe('JobApplicationsService', () => {
  const application = { id: 'app-id', status: JobApplicationStatus.submitted, coverLetter: null, submittedAt: new Date(), withdrawnAt: null, updatedAt: new Date(), job: { id: 'job-id', title: 'AI Engineer', companyName: 'EduAI', status: JobStatus.published, closesAt: null }, history: [] };
  function setup() {
    const tx = { jobOpportunity: { findFirst: jest.fn().mockResolvedValue({ id: 'job-id' }) }, jobApplication: { create: jest.fn().mockResolvedValue(application), findFirst: jest.fn().mockResolvedValue(application), findUnique: jest.fn().mockResolvedValue({ status: JobApplicationStatus.submitted, userId: 'student-id' }), update: jest.fn().mockResolvedValue(application) }, jobApplicationStatusHistory: { create: jest.fn() }, savedJob: { upsert: jest.fn().mockResolvedValue({ id: 'saved-id' }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const prisma = { ...tx, jobApplication: { ...tx.jobApplication, findMany: jest.fn().mockResolvedValue([application]), count: jest.fn().mockResolvedValue(1) }, savedJob: { ...tx.savedJob, findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) }, $transaction: jest.fn(async (input: unknown) => typeof input === 'function' ? (input as (client: typeof tx) => unknown)(tx) : Promise.all(input as Promise<unknown>[])) };
    const notifications = { createForUser: jest.fn() };
    return { service: new JobApplicationsService(prisma as never, notifications as never), prisma, tx, notifications };
  }

  it('creates one private application and initial history inside a transaction', async () => {
    const { service, tx } = setup();
    await service.apply('student-id', 'job-id', { coverLetter: 'Hello' });
    expect(tx.jobOpportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: JobStatus.published }) }));
    expect(tx.jobApplication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'student-id', jobId: 'job-id' }) }));
  });

  it('maps the unique user/job constraint to a duplicate conflict', async () => {
    const { service, tx } = setup();
    tx.jobApplication.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.apply('student-id', 'job-id', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects applications after close or deadline', async () => {
    const { service, tx } = setup(); tx.jobOpportunity.findFirst.mockResolvedValue(null);
    await expect(service.apply('student-id', 'job-id', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('withdraws only an owned non-terminal application and preserves history', async () => {
    const { service, tx } = setup(); await service.withdraw('student-id', 'app-id');
    expect(tx.jobApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'app-id', userId: 'student-id' } }));
    expect(tx.jobApplication.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ history: expect.any(Object) }) }));
  });

  it('does not expose another learner application', async () => {
    const { service, prisma } = setup(); prisma.jobApplication.findFirst.mockResolvedValue(null);
    await expect(service.getMine('other-user', 'app-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows only valid admin transitions and notifies the applicant', async () => {
    const { service, tx, notifications } = setup();
    await service.updateStatus('admin-id', 'app-id', { status: JobApplicationStatus.reviewing });
    expect(tx.jobApplication.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ history: expect.any(Object) }) }));
    expect(notifications.createForUser).toHaveBeenCalled();
  });

  it('rejects status changes after a terminal decision', async () => {
    const { service, tx } = setup();
    tx.jobApplication.findUnique.mockResolvedValue({ status: JobApplicationStatus.accepted, userId: 'student-id' });
    await expect(service.updateStatus('admin-id', 'app-id', { status: JobApplicationStatus.rejected })).rejects.toBeInstanceOf(BadRequestException);
  });
});
