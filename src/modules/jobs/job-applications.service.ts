import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { JobApplicationStatus, JobStatus, NotificationCategory, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApplyToJobDto, ListJobApplicationsQueryDto, UpdateJobApplicationStatusDto } from './dto/job-application.dto';

const jobSummarySelect = { id: true, title: true, companyName: true, status: true, closesAt: true } satisfies Prisma.JobOpportunitySelect;
const historySelect = { fromStatus: true, toStatus: true, createdAt: true } satisfies Prisma.JobApplicationStatusHistorySelect;
const applicationSelect = { id: true, coverLetter: true, status: true, submittedAt: true, withdrawnAt: true, updatedAt: true, job: { select: jobSummarySelect }, history: { select: historySelect, orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.JobApplicationSelect;
const adminApplicationSelect = { ...applicationSelect, user: { select: { fullName: true, email: true } } } satisfies Prisma.JobApplicationSelect;
const savedJobSelect = {
  createdAt: true,
  job: {
    select: {
      id: true, title: true, companyName: true, summary: true, location: true,
      workMode: true, employmentType: true, publishedAt: true, closesAt: true,
      requiredSkills: {
        select: { name: true, level: true },
        orderBy: { name: 'asc' as const },
      },
    },
  },
} satisfies Prisma.SavedJobSelect;
type ApplicationResponse = Prisma.JobApplicationGetPayload<{ select: typeof applicationSelect }>;
type AdminApplicationResponse = Prisma.JobApplicationGetPayload<{ select: typeof adminApplicationSelect }>;
type SavedJobResponse = Prisma.SavedJobGetPayload<{ select: typeof savedJobSelect }>;
export interface JobApplicationPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

const transitions: Record<JobApplicationStatus, JobApplicationStatus[]> = {
  submitted: [JobApplicationStatus.reviewing, JobApplicationStatus.shortlisted, JobApplicationStatus.rejected, JobApplicationStatus.withdrawn],
  reviewing: [JobApplicationStatus.shortlisted, JobApplicationStatus.accepted, JobApplicationStatus.rejected, JobApplicationStatus.withdrawn],
  shortlisted: [JobApplicationStatus.accepted, JobApplicationStatus.rejected, JobApplicationStatus.withdrawn],
  accepted: [], rejected: [], withdrawn: [],
};

@Injectable()
export class JobApplicationsService {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  async save(userId: string, jobId: string): Promise<{ saved: true }> {
    await this.assertActiveJob(this.prisma, jobId);
    await this.prisma.savedJob.upsert({ where: { userId_jobId: { userId, jobId } }, create: { userId, jobId }, update: {}, select: { id: true } });
    return { saved: true };
  }

  async unsave(userId: string, jobId: string): Promise<{ saved: false }> {
    await this.prisma.savedJob.deleteMany({ where: { userId, jobId } });
    return { saved: false };
  }

  async listSaved(userId: string, query: ListJobApplicationsQueryDto): Promise<JobApplicationPage<SavedJobResponse>> {
    const where: Prisma.SavedJobWhereInput = { userId, job: { status: JobStatus.published, deletedAt: null, OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] } };
    const [total, items] = await this.prisma.$transaction([this.prisma.savedJob.count({ where }), this.prisma.savedJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: savedJobSelect })]);
    return this.toPage(items, total, query);
  }

  async apply(userId: string, jobId: string, input: ApplyToJobDto): Promise<ApplicationResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertActiveJob(tx, jobId);
        return tx.jobApplication.create({ data: { userId, jobId, coverLetter: input.coverLetter, history: { create: { fromStatus: null, toStatus: JobApplicationStatus.submitted, changedById: userId } } }, select: applicationSelect });
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('You have already applied to this job');
      throw error;
    }
  }

  async listMine(userId: string, query: ListJobApplicationsQueryDto): Promise<JobApplicationPage<ApplicationResponse>> {
    const where = { userId, ...(query.status ? { status: query.status } : {}) };
    const [total, items] = await this.prisma.$transaction([this.prisma.jobApplication.count({ where }), this.prisma.jobApplication.findMany({ where, orderBy: { submittedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: applicationSelect })]);
    return this.toPage(items, total, query);
  }

  async getMine(userId: string, id: string): Promise<ApplicationResponse> {
    const application = await this.prisma.jobApplication.findFirst({ where: { id, userId }, select: applicationSelect });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  async withdraw(userId: string, id: string): Promise<ApplicationResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.jobApplication.findFirst({ where: { id, userId }, select: { status: true } });
      if (!current) throw new NotFoundException('Application not found');
      this.assertTransition(current.status, JobApplicationStatus.withdrawn);
      return tx.jobApplication.update({ where: { id }, data: { status: JobApplicationStatus.withdrawn, withdrawnAt: new Date(), history: { create: { fromStatus: current.status, toStatus: JobApplicationStatus.withdrawn, changedById: userId } } }, select: applicationSelect });
    });
  }

  async listAdmin(query: ListJobApplicationsQueryDto): Promise<JobApplicationPage<AdminApplicationResponse>> {
    const where = query.status ? { status: query.status } : {};
    const [total, items] = await this.prisma.$transaction([this.prisma.jobApplication.count({ where }), this.prisma.jobApplication.findMany({ where, orderBy: { submittedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: adminApplicationSelect })]);
    return this.toPage(items, total, query);
  }

  async updateStatus(actorId: string, id: string, input: UpdateJobApplicationStatusDto): Promise<AdminApplicationResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.jobApplication.findUnique({ where: { id }, select: { status: true, userId: true } });
      if (!current) throw new NotFoundException('Application not found');
      this.assertTransition(current.status, input.status);
      const application = await tx.jobApplication.update({ where: { id }, data: { status: input.status, history: { create: { fromStatus: current.status, toStatus: input.status, changedById: actorId } } }, select: adminApplicationSelect });
      return { application, userId: current.userId };
    });
    try {
      await this.notifications.createForUser({ userId: result.userId, eventKey: `job-application:${id}:${input.status}`, type: 'JOB_APPLICATION_STATUS', category: NotificationCategory.system, title: 'Cập nhật hồ sơ ứng tuyển', body: `Hồ sơ của bạn đã chuyển sang trạng thái ${input.status}.`, link: '/dashboard/job-applications' });
    } catch {
      // Status history is authoritative; notification delivery is best-effort after commit.
    }
    return result.application;
  }

  private assertTransition(from: JobApplicationStatus, to: JobApplicationStatus): void {
    if (!transitions[from].includes(to)) throw new BadRequestException(`Invalid application transition from ${from} to ${to}`);
  }

  private async assertActiveJob(client: Pick<Prisma.TransactionClient, 'jobOpportunity'> | PrismaService, jobId: string): Promise<void> {
    const job = await client.jobOpportunity.findFirst({ where: { id: jobId, status: JobStatus.published, deletedAt: null, OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] }, select: { id: true } });
    if (!job) throw new BadRequestException('Job is not accepting applications');
  }

  private toPage<T>(items: T[], total: number, query: ListJobApplicationsQueryDto): JobApplicationPage<T> { return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) }; }
}
