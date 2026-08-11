ALTER TABLE "lessons"
ADD COLUMN "is_required" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "quizzes"
ADD COLUMN "is_required" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "assignments"
ADD COLUMN "is_required" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "lessons_course_id_is_required_deleted_at_idx"
ON "lessons"("course_id", "is_required", "deleted_at");

CREATE INDEX "quizzes_course_id_status_is_required_deleted_at_idx"
ON "quizzes"("course_id", "status", "is_required", "deleted_at");

CREATE INDEX "assignments_course_id_status_is_required_deleted_at_idx"
ON "assignments"("course_id", "status", "is_required", "deleted_at");
