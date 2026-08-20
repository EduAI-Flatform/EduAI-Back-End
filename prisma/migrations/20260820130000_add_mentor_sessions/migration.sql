CREATE TABLE "mentor_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "booking_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'jitsi', "room_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mentor_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mentor_sessions_booking_id_key" ON "mentor_sessions"("booking_id");
CREATE UNIQUE INDEX "mentor_sessions_room_name_key" ON "mentor_sessions"("room_name");
ALTER TABLE "mentor_sessions" ADD CONSTRAINT "mentor_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "mentor_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mentor_session_attendance" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "session_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "left_at" TIMESTAMP(3), "duration_seconds" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mentor_session_attendance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mentor_session_attendance_session_id_user_id_key" ON "mentor_session_attendance"("session_id", "user_id");
CREATE INDEX "mentor_session_attendance_user_id_idx" ON "mentor_session_attendance"("user_id");
ALTER TABLE "mentor_session_attendance" ADD CONSTRAINT "mentor_session_attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "mentor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mentor_session_attendance" ADD CONSTRAINT "mentor_session_attendance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
