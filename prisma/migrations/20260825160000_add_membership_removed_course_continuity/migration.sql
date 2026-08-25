ALTER TYPE "course_access_source_type" ADD VALUE IF NOT EXISTS 'membership_grace';

CREATE TABLE "membership_removed_course_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "checkout_intent_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "course_id" UUID NOT NULL,
  "course_title" VARCHAR(200) NOT NULL,
  "course_slug" VARCHAR(200) NOT NULL,
  "started_before_removal" BOOLEAN NOT NULL,
  "grace_days" INTEGER NOT NULL,
  "grace_starts_at" TIMESTAMP(3),
  "grace_ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_removed_course_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_removed_course_snapshots_grace_days_check" CHECK ("grace_days" BETWEEN 0 AND 3650),
  CONSTRAINT "membership_removed_course_snapshots_grace_window_check" CHECK (
    ("grace_starts_at" IS NULL AND "grace_ends_at" IS NULL)
    OR ("started_before_removal" AND "grace_days" > 0 AND "grace_ends_at" > "grace_starts_at")
  )
);

CREATE UNIQUE INDEX "membership_removed_course_snapshots_intent_course_key"
  ON "membership_removed_course_snapshots"("checkout_intent_id", "course_id");
CREATE INDEX "membership_removed_course_snapshots_user_id_grace_ends_at_idx"
  ON "membership_removed_course_snapshots"("user_id", "grace_ends_at");
CREATE INDEX "membership_removed_course_snapshots_course_id_created_at_idx"
  ON "membership_removed_course_snapshots"("course_id", "created_at");

ALTER TABLE "membership_removed_course_snapshots"
  ADD CONSTRAINT "membership_removed_course_snapshots_checkout_intent_id_fkey"
  FOREIGN KEY ("checkout_intent_id") REFERENCES "membership_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_removed_course_snapshots"
  ADD CONSTRAINT "membership_removed_course_snapshots_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_removed_course_snapshots"
  ADD CONSTRAINT "membership_removed_course_snapshots_course_id_fkey"
  FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "membership_removed_course_snapshots_immutable"
  BEFORE UPDATE OR DELETE ON "membership_removed_course_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
