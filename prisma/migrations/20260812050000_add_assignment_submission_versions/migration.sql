ALTER TABLE "assignments"
  ADD COLUMN "rubric_criteria" JSONB,
  ADD COLUMN "final_score_policy" TEXT NOT NULL DEFAULT 'latest';

ALTER TABLE "submissions"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "is_late" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rubric_scores" JSONB;

UPDATE "submissions" AS submission
SET "is_late" = assignment."due_date" IS NOT NULL
  AND submission."submitted_at" > assignment."due_date"
FROM "assignments" AS assignment
WHERE assignment."id" = submission."assignment_id";

ALTER TABLE "submissions"
  DROP CONSTRAINT IF EXISTS "submissions_assignment_id_user_id_key";

ALTER TABLE "submissions"
  ADD CONSTRAINT "submissions_assignment_id_user_id_version_key"
  UNIQUE ("assignment_id", "user_id", "version");

CREATE INDEX "submissions_assignment_id_user_id_version_idx"
  ON "submissions"("assignment_id", "user_id", "version");
