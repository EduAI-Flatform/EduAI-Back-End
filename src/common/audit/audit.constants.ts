export const AuditAction = {
  AuthLogin: 'AUTH_LOGIN',
  UserRoleChanged: 'USER_ROLE_CHANGED',
  UserStatusChanged: 'USER_STATUS_CHANGED',
  CoursePublished: 'COURSE_PUBLISHED',
  AssignmentPublished: 'ASSIGNMENT_PUBLISHED',
  SubmissionGraded: 'SUBMISSION_GRADED',
  CertificateIssued: 'CERTIFICATE_ISSUED',
  CertificateRevoked: 'CERTIFICATE_REVOKED',
  CommunityPostModerated: 'COMMUNITY_POST_MODERATED',
  CommunityPostRemoved: 'COMMUNITY_POST_REMOVED',
  CommunityCommentRemoved: 'COMMUNITY_COMMENT_REMOVED',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
