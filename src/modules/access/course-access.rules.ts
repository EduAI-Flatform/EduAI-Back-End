export type CourseAccessOperation = 'MANAGE' | 'PUBLIC_PREVIEW' | 'FULL_LEARNING';

export interface CourseAccessFacts {
  userDeleted: boolean;
  courseDeleted: boolean;
  isPlatformAdmin: boolean;
  isOwner: boolean;
  moderationClear: boolean;
  published: boolean;
  archived: boolean;
  isPublic: boolean;
  isPreviewResource: boolean;
  hasActiveGrant: boolean;
  hasGraceGrant: boolean;
  hasQualifyingLegacyEnrollment: boolean;
}

export interface CourseAccessDecision {
  allowed: boolean;
  mode: 'MANAGER' | 'PREVIEW' | 'LEARNER' | 'NONE';
  reason: string;
}

export function resolveCourseAccessFacts(
  operation: CourseAccessOperation,
  facts: CourseAccessFacts,
): CourseAccessDecision {
  if (facts.userDeleted || facts.courseDeleted) return { allowed: false, mode: 'NONE', reason: 'SUBJECT_NOT_FOUND' };
  if (operation === 'MANAGE') {
    return facts.isPlatformAdmin || facts.isOwner
      ? { allowed: true, mode: 'MANAGER', reason: 'MANAGEMENT_AUTHORITY' }
      : { allowed: false, mode: 'NONE', reason: 'COURSE_NOT_FOUND' };
  }
  if (!facts.moderationClear) return { allowed: false, mode: 'NONE', reason: 'COURSE_NOT_FOUND' };
  if (operation === 'PUBLIC_PREVIEW') {
    return facts.published && facts.isPublic && facts.isPreviewResource
      ? { allowed: true, mode: 'PREVIEW', reason: 'PUBLIC_PREVIEW' }
      : { allowed: false, mode: 'NONE', reason: 'COURSE_NOT_FOUND' };
  }
  if (
    (facts.published || facts.archived)
    && (facts.hasActiveGrant || facts.hasGraceGrant || facts.hasQualifyingLegacyEnrollment)
  ) {
    return { allowed: true, mode: 'LEARNER', reason: 'COURSE_ENTITLED' };
  }
  return { allowed: false, mode: 'NONE', reason: 'COURSE_ACCESS_REQUIRED' };
}
