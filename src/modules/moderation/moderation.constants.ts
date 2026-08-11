export const ModerationTargetType = {
  Course: 'course',
  LibraryResource: 'library_resource',
  CommunityPost: 'community_post',
  CommunityComment: 'community_comment',
} as const;

export type ModerationTargetTypeValue =
  (typeof ModerationTargetType)[keyof typeof ModerationTargetType];

export const MODERATION_TARGET_TYPES = Object.values(ModerationTargetType);

export const ModerationAction = {
  Hide: 'hide',
  Reject: 'reject',
  Archive: 'archive',
  Restore: 'restore',
} as const;

export type ModerationActionValue =
  (typeof ModerationAction)[keyof typeof ModerationAction];

export const MODERATION_ACTIONS = Object.values(ModerationAction);
