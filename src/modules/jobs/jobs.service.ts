import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JobStatus, Prisma } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateJobDto, JobRequiredSkillDto } from './dto/create-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs-query.dto';
import { UpdateJobDto } from './dto/update-job.dto';

const jobSelect = {
  id: true, title: true, companyName: true, summary: true, description: true,
  location: true, workMode: true, employmentType: true, salaryMin: true,
  salaryMax: true, salaryCurrency: true, status: true, publishedAt: true,
  closesAt: true, createdAt: true, updatedAt: true,
  requiredSkills: { select: { name: true, level: true }, orderBy: { name: 'asc' as const } },
} satisfies Prisma.JobOpportunitySelect;

const publicJobListSelect = {
  id: true, title: true, companyName: true, summary: true, location: true,
  workMode: true, employmentType: true, salaryMin: true, salaryMax: true,
  salaryCurrency: true, publishedAt: true, closesAt: true,
  requiredSkills: { select: { name: true, level: true }, orderBy: { name: 'asc' as const } },
} satisfies Prisma.JobOpportunitySelect;

type JobRecord = Prisma.JobOpportunityGetPayload<{ select: typeof jobSelect }>;
type PublicJobListRecord = Prisma.JobOpportunityGetPayload<{ select: typeof publicJobListSelect }>;
export type JobResponse = JobRecord;
export type PublicJobListItem = PublicJobListRecord;
export type PublicJobDetail = Omit<JobRecord, 'status' | 'createdAt' | 'updatedAt'>;
export interface JobPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async create(actorId: string, input: CreateJobDto): Promise<JobResponse> {
    this.assertInput(input);
    const skills = this.normalizeSkills(input.requiredSkills);
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.jobOpportunity.create({
        data: {
          createdById: actorId, title: input.title, companyName: input.companyName,
          summary: input.summary, description: input.description, location: input.location,
          workMode: input.workMode, employmentType: input.employmentType,
          salaryMin: input.salaryMin, salaryMax: input.salaryMax,
          salaryCurrency: input.salaryCurrency,
          closesAt: input.closesAt ? new Date(input.closesAt) : input.closesAt,
          status: JobStatus.draft,
          requiredSkills: { create: skills },
        },
        select: jobSelect,
      });
      await this.audit.record({ actorId, action: AuditAction.JobCreated, target: { type: 'job', id: job.id }, metadata: { status: job.status } }, tx);
      return job;
    });
  }

  async update(actorId: string, id: string, input: UpdateJobDto): Promise<JobResponse> {
    const current = await this.prisma.jobOpportunity.findUnique({ where: { id }, select: { id: true, status: true, deletedAt: true } });
    if (!current || current.deletedAt) throw new NotFoundException('Job not found');
    if (current.status === JobStatus.closed) throw new BadRequestException('Closed jobs cannot be edited');
    this.assertInput(input);
    const { requiredSkills, closesAt, ...fields } = input;
    return this.prisma.$transaction(async (tx) => {
      if (requiredSkills !== undefined) {
        const skills = this.normalizeSkills(requiredSkills);
        await tx.jobRequiredSkill.deleteMany({ where: { jobId: id } });
        if (skills.length) await tx.jobRequiredSkill.createMany({ data: skills.map((skill) => ({ jobId: id, ...skill })) });
      }
      const job = await tx.jobOpportunity.update({
        where: { id },
        data: { ...fields, ...(closesAt !== undefined ? { closesAt: closesAt ? new Date(closesAt) : null } : {}) },
        select: jobSelect,
      });
      await this.audit.record({ actorId, action: AuditAction.JobUpdated, target: { type: 'job', id }, metadata: { status: job.status } }, tx);
      return job;
    });
  }

  listAdmin(query: ListJobsQueryDto): Promise<JobPage<JobResponse>> {
    const where: Prisma.JobOpportunityWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...this.searchWhere(query),
    };
    return this.page(where, query, jobSelect);
  }

  async getAdmin(id: string): Promise<JobResponse> {
    const job = await this.prisma.jobOpportunity.findFirst({ where: { id, deletedAt: null }, select: jobSelect });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  listPublic(query: ListJobsQueryDto): Promise<JobPage<PublicJobListItem>> {
    return this.page(this.activeWhere(query), query, publicJobListSelect);
  }

  async getPublic(id: string): Promise<PublicJobDetail> {
    const job = await this.prisma.jobOpportunity.findFirst({ where: { id, ...this.activeWhere({ page: 1, pageSize: 1 }) }, select: jobSelect });
    if (!job) throw new NotFoundException('Job not found');
    const { status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...response } = job;
    return response;
  }

  async publish(actorId: string, id: string): Promise<JobResponse> {
    const current = await this.prisma.jobOpportunity.findUnique({ where: { id }, select: { status: true, closesAt: true, deletedAt: true } });
    if (!current || current.deletedAt) throw new NotFoundException('Job not found');
    if (current.status !== JobStatus.draft) throw new BadRequestException('Only draft jobs can be published');
    if (current.closesAt && current.closesAt <= new Date()) throw new BadRequestException('Closing date must be in the future');
    return this.transition(actorId, id, JobStatus.published, AuditAction.JobPublished, { publishedAt: new Date() });
  }

  async close(actorId: string, id: string): Promise<JobResponse> {
    const current = await this.prisma.jobOpportunity.findUnique({ where: { id }, select: { status: true, deletedAt: true } });
    if (!current || current.deletedAt) throw new NotFoundException('Job not found');
    if (current.status !== JobStatus.published) throw new BadRequestException('Only published jobs can be closed');
    return this.transition(actorId, id, JobStatus.closed, AuditAction.JobClosed);
  }

  async remove(actorId: string, id: string): Promise<{ deleted: true }> {
    const current = await this.prisma.jobOpportunity.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!current) throw new NotFoundException('Job not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.jobOpportunity.update({ where: { id }, data: { deletedAt: new Date() }, select: { id: true } });
      await this.audit.record({ actorId, action: AuditAction.JobDeleted, target: { type: 'job', id } }, tx);
    });
    return { deleted: true };
  }

  async assertAcceptingApplications(id: string): Promise<void> {
    const job = await this.prisma.jobOpportunity.findFirst({ where: { id, ...this.activeWhere({ page: 1, pageSize: 1 }) }, select: { id: true } });
    if (!job) throw new BadRequestException('Job is not accepting applications');
  }

  private async transition(actorId: string, id: string, status: JobStatus, action: (typeof AuditAction)[keyof typeof AuditAction], extra: { publishedAt?: Date } = {}): Promise<JobResponse> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.jobOpportunity.update({ where: { id }, data: { status, ...extra }, select: jobSelect });
      await this.audit.record({ actorId, action, target: { type: 'job', id }, metadata: { status } }, tx);
      return job;
    });
  }

  private activeWhere(query: Pick<ListJobsQueryDto, 'page' | 'pageSize' | 'search' | 'location' | 'workMode' | 'employmentType'>): Prisma.JobOpportunityWhereInput {
    return { status: JobStatus.published, deletedAt: null, OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }], ...this.searchWhere(query) };
  }

  private searchWhere(query: Pick<ListJobsQueryDto, 'search' | 'location' | 'workMode' | 'employmentType'>): Prisma.JobOpportunityWhereInput {
    return {
      ...(query.search ? { AND: [{ OR: [
        { title: { contains: query.search, mode: 'insensitive' } },
        { companyName: { contains: query.search, mode: 'insensitive' } },
        { summary: { contains: query.search, mode: 'insensitive' } },
        { requiredSkills: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
      ] }] } : {}),
      ...(query.location ? { location: { contains: query.location, mode: 'insensitive' } } : {}),
      ...(query.workMode ? { workMode: query.workMode } : {}),
      ...(query.employmentType ? { employmentType: query.employmentType } : {}),
    };
  }

  private async page<TSelect extends Prisma.JobOpportunitySelect, TRecord = Prisma.JobOpportunityGetPayload<{ select: TSelect }>>(where: Prisma.JobOpportunityWhereInput, query: ListJobsQueryDto, select: TSelect): Promise<JobPage<TRecord>> {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.jobOpportunity.count({ where }),
      this.prisma.jobOpportunity.findMany({ where, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select }),
    ]);
    return { items: items as TRecord[], page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  private normalizeSkills(skills: JobRequiredSkillDto[]): JobRequiredSkillDto[] {
    const seen = new Set<string>();
    return skills.map((skill) => ({ name: skill.name.trim(), level: skill.level?.trim() || null })).map((skill) => {
      const key = skill.name.toLocaleLowerCase();
      if (!key || seen.has(key)) throw new BadRequestException('Required skills must have unique non-empty names');
      seen.add(key);
      return skill;
    });
  }

  private assertInput(input: Partial<CreateJobDto>): void {
    if (input.salaryMin != null && input.salaryMax != null && input.salaryMin > input.salaryMax) throw new BadRequestException('Minimum salary cannot exceed maximum salary');
    if ((input.salaryMin != null || input.salaryMax != null) && !input.salaryCurrency) throw new BadRequestException('Salary currency is required when salary is provided');
  }
}
