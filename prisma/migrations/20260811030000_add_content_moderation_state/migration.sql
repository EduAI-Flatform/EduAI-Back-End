CREATE TYPE "ModerationStatus" AS ENUM ('clear', 'hidden', 'rejected', 'archived');

ALTER TABLE "courses"
ADD COLUMN "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'clear',
ADD COLUMN "moderation_reason" TEXT,
ADD COLUMN "moderated_at" TIMESTAMP(3);

ALTER TABLE "library_resources"
ADD COLUMN "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'clear',
ADD COLUMN "moderation_reason" TEXT,
ADD COLUMN "moderated_at" TIMESTAMP(3);

ALTER TABLE "community_posts"
ADD COLUMN "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'clear',
ADD COLUMN "moderation_reason" TEXT,
ADD COLUMN "moderated_at" TIMESTAMP(3);

ALTER TABLE "community_comments"
ADD COLUMN "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'clear',
ADD COLUMN "moderation_reason" TEXT,
ADD COLUMN "moderated_at" TIMESTAMP(3);

UPDATE "community_posts"
SET
  "moderation_status" = 'hidden',
  "moderation_reason" = 'Migrated from legacy hidden moderation status.',
  "moderated_at" = "updated_at",
  "status" = 'active'
WHERE "status" = 'hidden' AND "deleted_at" IS NULL;

CREATE INDEX "courses_moderation_status_updated_at_idx"
ON "courses"("moderation_status", "updated_at");

CREATE INDEX "library_resources_moderation_status_updated_at_idx"
ON "library_resources"("moderation_status", "updated_at");

CREATE INDEX "community_posts_moderation_status_updated_at_idx"
ON "community_posts"("moderation_status", "updated_at");

CREATE INDEX "community_comments_moderation_status_updated_at_idx"
ON "community_comments"("moderation_status", "updated_at");
