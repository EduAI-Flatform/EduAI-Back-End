CREATE TYPE "certificate_status" AS ENUM ('active', 'revoked');

ALTER TABLE "certificates"
  ADD COLUMN "status" "certificate_status" NOT NULL DEFAULT 'active',
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "revocation_reason" TEXT;

ALTER TABLE "certificates"
  DROP CONSTRAINT IF EXISTS "certificates_user_id_course_id_key";

CREATE UNIQUE INDEX "certificates_user_id_course_id_active_key"
  ON "certificates"("user_id", "course_id")
  WHERE "status" = 'active';

CREATE INDEX "certificates_user_id_course_id_status_idx"
  ON "certificates"("user_id", "course_id", "status");
