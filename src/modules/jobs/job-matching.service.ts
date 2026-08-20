import { BadRequestException, Injectable } from '@nestjs/common';
import { CourseLevel, CourseStatus, CourseVisibility, JobStatus, ModerationStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const jobMatchSelect = {
  id: true,
  title: true,
  companyName: true,
  requiredSkills: { select: { name: true, level: true }, orderBy: { name: 'asc' as const } },
} satisfies Prisma.JobOpportunitySelect;

const courseRecommendationSelect = {
  id: true,
  title: true,
  slug: true,
  description: true,
  thumbnailUrl: true,
  level: true,
  categorySlug: true,
} satisfies Prisma.CourseSelect;

export interface MatchedJobSkill {
  name: string;
  requiredLevel: string | null;
  learnerLevel: string | null;
}

export interface MissingJobSkill {
  name: string;
  requiredLevel: string | null;
  learnerLevel: string | null;
  reason: 'missing' | 'level_gap';
}

export interface JobCourseRecommendation {
  id: string;
  title: string;
  slug: string;
  thumbnailUrl: string | null;
  level: CourseLevel;
  matchedMissingSkills: string[];
}

export interface JobMatchResponse {
  job: { id: string; title: string; companyName: string };
  fitScore: number;
  matchedSkills: MatchedJobSkill[];
  missingSkills: MissingJobSkill[];
  explanation: string;
  courseRecommendations: JobCourseRecommendation[];
}

@Injectable()
export class JobMatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async match(userId: string, jobId: string): Promise<JobMatchResponse> {
    const job = await this.prisma.jobOpportunity.findFirst({
      where: { id: jobId, status: JobStatus.published, deletedAt: null, OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] },
      select: jobMatchSelect,
    });
    if (!job) throw new BadRequestException('Job is not available for matching');

    const learnerSkills = await this.prisma.userSkill.findMany({
      where: { userId },
      select: { name: true, level: true },
      orderBy: { name: 'asc' },
    });
    const learnerByName = new Map<string, typeof learnerSkills>();
    for (const skill of learnerSkills) {
      const key = this.normalize(skill.name);
      learnerByName.set(key, [...(learnerByName.get(key) ?? []), skill].sort((left, right) => this.compareLevels(right.level, left.level)));
    }
    const matchedSkills: MatchedJobSkill[] = [];
    const missingSkills: MissingJobSkill[] = [];

    for (const required of job.requiredSkills) {
      const candidates = learnerByName.get(this.normalize(required.name)) ?? [];
      const learner = candidates.find((candidate) => this.meetsRequiredLevel(candidate.level, required.level));
      if (learner) {
        matchedSkills.push({ name: required.name.trim(), requiredLevel: required.level, learnerLevel: learner.level });
      } else {
        missingSkills.push({ name: required.name.trim(), requiredLevel: required.level, learnerLevel: candidates[0]?.level ?? null, reason: candidates.length ? 'level_gap' : 'missing' });
      }
    }

    const requiredCount = job.requiredSkills.length;
    const fitScore = requiredCount === 0 ? 100 : Math.round((matchedSkills.length / requiredCount) * 100);
    const courseRecommendations = await this.recommendCourses(missingSkills);
    return {
      job: { id: job.id, title: job.title, companyName: job.companyName },
      fitScore,
      matchedSkills,
      missingSkills,
      explanation: requiredCount === 0
        ? 'This job has no required skills, so the deterministic baseline score is 100.'
        : `${matchedSkills.length} of ${requiredCount} required skills match your stored skill profile.`,
      courseRecommendations,
    };
  }

  private async recommendCourses(missingSkills: MissingJobSkill[]): Promise<JobCourseRecommendation[]> {
    if (!missingSkills.length) return [];
    const courses = await this.prisma.course.findMany({
      where: {
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.clear,
        deletedAt: null,
        OR: missingSkills.flatMap((skill) => [
          { title: { contains: skill.name, mode: 'insensitive' as const } },
          { description: { contains: skill.name, mode: 'insensitive' as const } },
          { categorySlug: { contains: skill.name, mode: 'insensitive' as const } },
        ]),
      },
      select: courseRecommendationSelect,
      orderBy: { title: 'asc' },
      take: 50,
    });

    return courses.map((course) => {
      const searchable = this.normalize([course.title, course.description, course.categorySlug].filter(Boolean).join(' '));
      const matchedMissingSkills = missingSkills.filter((skill) => searchable.includes(this.normalize(skill.name))).map((skill) => skill.name);
      return { id: course.id, title: course.title, slug: course.slug, thumbnailUrl: course.thumbnailUrl, level: course.level, matchedMissingSkills };
    }).filter((course) => course.matchedMissingSkills.length > 0).sort((left, right) => {
      const scoreDifference = right.matchedMissingSkills.length - left.matchedMissingSkills.length;
      if (scoreDifference) return scoreDifference;
      const leftTitle = this.normalize(left.title);
      const rightTitle = this.normalize(right.title);
      return leftTitle < rightTitle ? -1 : leftTitle > rightTitle ? 1 : 0;
    }).slice(0, 5);
  }

  private meetsRequiredLevel(learnerLevel: string | null, requiredLevel: string | null): boolean {
    if (!requiredLevel) return true;
    if (!learnerLevel) return false;
    const ranks: Record<string, number> = { foundation: 1, foundational: 1, beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
    const learner = this.normalize(learnerLevel);
    const required = this.normalize(requiredLevel);
    if (ranks[learner] && ranks[required]) return ranks[learner] >= ranks[required];
    return learner === required;
  }

  private compareLevels(left: string | null, right: string | null): number {
    const ranks: Record<string, number> = { foundation: 1, foundational: 1, beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
    const leftValue = left ? this.normalize(left) : '';
    const rightValue = right ? this.normalize(right) : '';
    const rankDifference = (ranks[leftValue] ?? 0) - (ranks[rightValue] ?? 0);
    if (rankDifference) return rankDifference;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  }
}
