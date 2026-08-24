CREATE TYPE "course_access_source_type" AS ENUM (
  'course_purchase', 'membership', 'scholarship', 'tmi_reward',
  'admin', 'free_enrollment', 'legacy_enrollment'
);
CREATE TYPE "course_access_grant_status" AS ENUM ('active', 'revoked');

CREATE TABLE "membership_plan_included_courses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version_id" UUID NOT NULL,
  "course_id" UUID NOT NULL,
  "grace_days" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_plan_included_courses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_plan_included_courses_grace_check" CHECK ("grace_days" BETWEEN 0 AND 3650)
);

CREATE TABLE "course_access_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "course_id" UUID NOT NULL,
  "source_type" "course_access_source_type" NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "status" "course_access_grant_status" NOT NULL DEFAULT 'active',
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "grace_ends_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revocation_reason" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "course_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_access_grants_window_check" CHECK (
    ("ends_at" IS NULL OR "ends_at" > "starts_at")
    AND ("grace_ends_at" IS NULL OR ("ends_at" IS NOT NULL AND "grace_ends_at" >= "ends_at"))
  ),
  CONSTRAINT "course_access_grants_status_check" CHECK (
    ("status" = 'active' AND "revoked_at" IS NULL AND "revocation_reason" IS NULL)
    OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND length(btrim("revocation_reason")) > 0)
  )
);

CREATE TABLE "course_access_backfill_issues" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID NOT NULL,
  "status" VARCHAR(64) NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "course_access_backfill_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "membership_plan_included_courses_version_id_course_id_key" ON "membership_plan_included_courses"("version_id", "course_id");
CREATE INDEX "membership_plan_included_courses_course_id_version_id_idx" ON "membership_plan_included_courses"("course_id", "version_id");
CREATE UNIQUE INDEX "course_access_grants_source_key" ON "course_access_grants"("user_id", "course_id", "source_type", "source_id");
CREATE INDEX "course_access_grants_user_course_window_idx" ON "course_access_grants"("user_id", "course_id", "status", "starts_at", "ends_at", "grace_ends_at");
CREATE INDEX "course_access_grants_source_idx" ON "course_access_grants"("source_type", "source_id");
CREATE UNIQUE INDEX "course_access_backfill_issues_enrollment_id_key" ON "course_access_backfill_issues"("enrollment_id");
CREATE INDEX "course_access_backfill_issues_reason_recorded_idx" ON "course_access_backfill_issues"("reason_code", "recorded_at");

ALTER TABLE "membership_plan_included_courses" ADD CONSTRAINT "membership_plan_included_courses_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_included_courses" ADD CONSTRAINT "membership_plan_included_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_included_courses" ADD CONSTRAINT "membership_plan_included_courses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "course_access_grants" ADD CONSTRAINT "course_access_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "course_access_grants" ADD CONSTRAINT "course_access_grants_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "course_access_backfill_issues" ADD CONSTRAINT "course_access_backfill_issues_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "membership_guard_included_course_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_version_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."version_id" ELSE NEW."version_id" END;
  source_status "membership_plan_version_status";
  course_ready boolean;
BEGIN
  SELECT "status" INTO source_status FROM "membership_plan_versions" WHERE "id" = source_version_id FOR KEY SHARE;
  IF source_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'published membership course inclusions are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."version_id" IS DISTINCT FROM NEW."version_id" OR OLD."course_id" IS DISTINCT FROM NEW."course_id" OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id" OR OLD."created_at" IS DISTINCT FROM NEW."created_at") THEN
    RAISE EXCEPTION 'membership course inclusion identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "deleted_at" IS NULL AND "status" = 'published' AND "moderation_status" = 'clear'
      INTO course_ready FROM "courses" WHERE "id" = NEW."course_id" FOR KEY SHARE;
    IF course_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'membership plans may include only available moderation-clear courses' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION "course_access_guard_grant_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'course access grants are append-only' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."user_id", NEW."course_id", NEW."source_type", NEW."source_id", NEW."starts_at", NEW."ends_at", NEW."grace_ends_at", NEW."created_at")
    IS DISTINCT FROM ROW(OLD."user_id", OLD."course_id", OLD."source_type", OLD."source_id", OLD."starts_at", OLD."ends_at", OLD."grace_ends_at", OLD."created_at")
  THEN
    RAISE EXCEPTION 'course access grant facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'revoked' OR (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'revoked')) THEN
    RAISE EXCEPTION 'invalid course access grant transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "course_access_reject_issue_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'course access backfill issues are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "membership_plan_included_courses_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "membership_plan_included_courses" FOR EACH ROW EXECUTE FUNCTION "membership_guard_included_course_change"();
CREATE TRIGGER "course_access_grants_immutable" BEFORE UPDATE OR DELETE ON "course_access_grants" FOR EACH ROW EXECUTE FUNCTION "course_access_guard_grant_change"();
CREATE TRIGGER "course_access_backfill_issues_append_only" BEFORE UPDATE OR DELETE ON "course_access_backfill_issues" FOR EACH ROW EXECUTE FUNCTION "course_access_reject_issue_change"();

INSERT INTO "course_access_grants" (
  "user_id", "course_id", "source_type", "source_id", "starts_at", "created_at"
)
SELECT e."user_id", e."course_id", 'legacy_enrollment', e."id"::text,
       TIMESTAMP '2026-08-24 16:45:00', TIMESTAMP '2026-08-24 16:45:00'
FROM "enrollments" e
JOIN "users" u ON u."id" = e."user_id" AND u."deleted_at" IS NULL
JOIN "courses" c ON c."id" = e."course_id" AND c."deleted_at" IS NULL
WHERE e."status" IN ('active', 'completed')
ON CONFLICT ("user_id", "course_id", "source_type", "source_id") DO NOTHING;

INSERT INTO "course_access_grants" (
  "user_id", "course_id", "source_type", "source_id", "starts_at", "created_at"
)
SELECT sa."user_id", sa."course_id", 'scholarship', sa."id"::text,
       sa."awarded_at", sa."awarded_at"
FROM "scholarship_awards" sa
JOIN "users" u ON u."id" = sa."user_id" AND u."deleted_at" IS NULL
JOIN "courses" c ON c."id" = sa."course_id" AND c."deleted_at" IS NULL
WHERE sa."benefit_kind" = 'course_access' AND sa."revoked_at" IS NULL
ON CONFLICT ("user_id", "course_id", "source_type", "source_id") DO NOTHING;

INSERT INTO "course_access_grants" (
  "user_id", "course_id", "source_type", "source_id", "starts_at", "created_at"
)
SELECT te."user_id", (te."benefit_metadata"->>'courseId')::uuid,
       'tmi_reward', te."redemption_id"::text, te."created_at", te."created_at"
FROM "tmi_entitlements" te
JOIN "users" u ON u."id" = te."user_id" AND u."deleted_at" IS NULL
JOIN "courses" c ON c."id" = CASE
    WHEN te."benefit_metadata"->>'courseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN (te."benefit_metadata"->>'courseId')::uuid
    ELSE NULL
  END
  AND c."deleted_at" IS NULL
WHERE te."kind" = 'course_access' AND te."status" = 'active'
  AND te."benefit_metadata"->>'courseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT ("user_id", "course_id", "source_type", "source_id") DO NOTHING;

INSERT INTO "enrollments" (
  "user_id", "course_id", "status", "enrolled_at", "created_at", "updated_at"
)
SELECT DISTINCT g."user_id", g."course_id", 'active', g."starts_at", g."created_at", g."created_at"
FROM "course_access_grants" g
WHERE g."source_type" IN ('scholarship', 'tmi_reward')
ON CONFLICT ("user_id", "course_id") DO NOTHING;

INSERT INTO "learning_progress" (
  "user_id", "course_id", "lesson_id", "status", "progress_percent",
  "watched_seconds", "last_position_seconds", "max_watched_seconds",
  "document_progress_percent", "created_at", "updated_at"
)
SELECT g."user_id", g."course_id", l."id", 'not_started', 0, 0, 0, 0, 0,
       g."created_at", g."created_at"
FROM "course_access_grants" g
JOIN "lessons" l ON l."course_id" = g."course_id" AND l."deleted_at" IS NULL
WHERE g."source_type" IN ('scholarship', 'tmi_reward')
ON CONFLICT ("user_id", "lesson_id") DO NOTHING;

INSERT INTO "course_access_backfill_issues" ("enrollment_id", "status", "reason_code", "recorded_at")
SELECT e."id", left(e."status", 64),
       CASE WHEN u."deleted_at" IS NOT NULL THEN 'USER_DELETED'
            WHEN c."deleted_at" IS NOT NULL THEN 'COURSE_DELETED'
            ELSE 'INELIGIBLE_ENROLLMENT_STATUS' END,
       TIMESTAMP '2026-08-24 16:45:00'
FROM "enrollments" e
JOIN "users" u ON u."id" = e."user_id"
JOIN "courses" c ON c."id" = e."course_id"
WHERE e."status" NOT IN ('active', 'completed') OR u."deleted_at" IS NOT NULL OR c."deleted_at" IS NOT NULL
ON CONFLICT ("enrollment_id") DO NOTHING;
