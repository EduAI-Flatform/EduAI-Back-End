-- CreateEnum
CREATE TYPE "ClassroomSessionStatus" AS ENUM ('scheduled', 'live', 'ended', 'cancelled');

-- CreateTable
CREATE TABLE "classroom_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "instructor_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'jitsi',
    "meeting_url" TEXT,
    "room_name" TEXT NOT NULL,
    "scheduled_start" TIMESTAMP(3) NOT NULL,
    "scheduled_end" TIMESTAMP(3) NOT NULL,
    "actual_start" TIMESTAMP(3),
    "actual_end" TIMESTAMP(3),
    "status" "ClassroomSessionStatus" NOT NULL DEFAULT 'scheduled',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "classroom_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classroom_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_recordings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "recording_url" TEXT NOT NULL,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classroom_sessions_course_id_idx" ON "classroom_sessions"("course_id");
CREATE INDEX "classroom_sessions_instructor_id_idx" ON "classroom_sessions"("instructor_id");
CREATE INDEX "classroom_sessions_status_idx" ON "classroom_sessions"("status");
CREATE INDEX "classroom_sessions_scheduled_start_idx" ON "classroom_sessions"("scheduled_start");
CREATE INDEX "classroom_sessions_deleted_at_idx" ON "classroom_sessions"("deleted_at");
CREATE UNIQUE INDEX "classroom_attendance_session_id_user_id_key" ON "classroom_attendance"("session_id", "user_id");
CREATE INDEX "classroom_attendance_user_id_idx" ON "classroom_attendance"("user_id");
CREATE INDEX "classroom_recordings_session_id_idx" ON "classroom_recordings"("session_id");

-- AddForeignKey
ALTER TABLE "classroom_sessions" ADD CONSTRAINT "classroom_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "classroom_sessions" ADD CONSTRAINT "classroom_sessions_instructor_id_fkey" FOREIGN KEY ("instructor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "classroom_attendance" ADD CONSTRAINT "classroom_attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "classroom_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "classroom_attendance" ADD CONSTRAINT "classroom_attendance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "classroom_recordings" ADD CONSTRAINT "classroom_recordings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "classroom_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
