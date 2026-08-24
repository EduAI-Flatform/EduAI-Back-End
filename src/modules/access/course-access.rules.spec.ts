import { resolveCourseAccessFacts } from './course-access.rules';

const course = {
  userDeleted: false, courseDeleted: false, isPlatformAdmin: false,
  isOwner: false, moderationClear: true, published: true, archived: false,
  isPublic: true, isPreviewResource: false, hasActiveGrant: false,
  hasGraceGrant: false, hasQualifyingLegacyEnrollment: false,
};

describe('course access precedence', () => {
  it('denies deleted identities before administrator or owner authority', () => {
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, userDeleted: true, isPlatformAdmin: true }))
      .toMatchObject({ allowed: false, reason: 'SUBJECT_NOT_FOUND' });
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, courseDeleted: true, isOwner: true }))
      .toMatchObject({ allowed: false, reason: 'SUBJECT_NOT_FOUND' });
  });

  it('keeps administrator and owner management authority separate from learner grants', () => {
    expect(resolveCourseAccessFacts('MANAGE', { ...course, isPlatformAdmin: true })).toMatchObject({ allowed: true, mode: 'MANAGER' });
    expect(resolveCourseAccessFacts('MANAGE', { ...course, isOwner: true })).toMatchObject({ allowed: true, mode: 'MANAGER' });
  });

  it('hides moderated content from learners even when a grant exists', () => {
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, moderationClear: false, hasActiveGrant: true }))
      .toMatchObject({ allowed: false, reason: 'COURSE_NOT_FOUND' });
  });

  it('allows only explicitly marked public preview resources without a grant', () => {
    expect(resolveCourseAccessFacts('PUBLIC_PREVIEW', { ...course, isPreviewResource: true }))
      .toMatchObject({ allowed: true, mode: 'PREVIEW' });
    expect(resolveCourseAccessFacts('PUBLIC_PREVIEW', course)).toMatchObject({ allowed: false });
  });

  it('allows private or archived clear courses to active, grace, or legacy learner access', () => {
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, isPublic: false, hasActiveGrant: true }))
      .toMatchObject({ allowed: true, mode: 'LEARNER' });
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, published: false, archived: true, hasGraceGrant: true }))
      .toMatchObject({ allowed: true, mode: 'LEARNER' });
    expect(resolveCourseAccessFacts('FULL_LEARNING', { ...course, hasQualifyingLegacyEnrollment: true }))
      .toMatchObject({ allowed: true, mode: 'LEARNER' });
  });

  it('denies learner access without a qualifying additive or legacy source', () => {
    expect(resolveCourseAccessFacts('FULL_LEARNING', course))
      .toEqual({ allowed: false, mode: 'NONE', reason: 'COURSE_ACCESS_REQUIRED' });
  });

  it('does not expose a draft course through a learner grant', () => {
    expect(resolveCourseAccessFacts('FULL_LEARNING', {
      ...course,
      published: false,
      hasActiveGrant: true,
    })).toEqual({ allowed: false, mode: 'NONE', reason: 'COURSE_ACCESS_REQUIRED' });
  });
});
