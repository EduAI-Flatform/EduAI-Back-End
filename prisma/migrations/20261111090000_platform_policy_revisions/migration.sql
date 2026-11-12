CREATE TYPE "platform_policy_status" AS ENUM ('draft', 'approved', 'scheduled', 'cancelled');
CREATE TABLE "platform_policy_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "group" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "platform_policy_status" NOT NULL DEFAULT 'draft',
  "content" JSONB NOT NULL,
  "created_by_id" UUID NOT NULL,
  "approved_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMP(3),
  "effective_at" TIMESTAMP(3),
  CONSTRAINT "platform_policy_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_policy_group_check" CHECK ("group" IN ('branding','navigation','membership','points','partners','affiliate','courses','operations')),
  CONSTRAINT "platform_policy_version_check" CHECK ("version" > 0),
  CONSTRAINT "platform_policy_approval_check" CHECK (("status" NOT IN ('approved','scheduled')) OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL)),
  CONSTRAINT "platform_policy_schedule_check" CHECK ("status" <> 'scheduled' OR "effective_at" IS NOT NULL),
  CONSTRAINT "platform_policy_creator_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "platform_policy_approver_fk" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "platform_policy_revisions_group_version_key" ON "platform_policy_revisions"("group", "version");
CREATE INDEX "platform_policy_revisions_group_status_effective_at_idx" ON "platform_policy_revisions"("group", "status", "effective_at");
