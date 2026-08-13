CREATE TYPE "notification_channel" AS ENUM ('in_app', 'email');
CREATE TYPE "notification_category" AS ENUM ('system', 'assignment', 'grade', 'classroom', 'certificate');
CREATE TYPE "notification_delivery_status" AS ENUM ('pending', 'delivered', 'failed');

CREATE TABLE "notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "event_key" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "category" "notification_category" NOT NULL DEFAULT 'system',
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "is_read" BOOLEAN NOT NULL DEFAULT false,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notifications_user_id_event_key_key" UNIQUE ("user_id", "event_key")
);

CREATE INDEX "notifications_user_id_is_read_created_at_idx"
  ON "notifications"("user_id", "is_read", "created_at");
CREATE INDEX "notifications_user_id_created_at_idx"
  ON "notifications"("user_id", "created_at");

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "channel" "notification_channel" NOT NULL,
  "category" "notification_category" NOT NULL,
  "is_enabled" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_preferences_user_id_channel_category_key" UNIQUE ("user_id", "channel", "category")
);

CREATE INDEX "notification_preferences_user_id_idx"
  ON "notification_preferences"("user_id");

CREATE TABLE "notification_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" UUID NOT NULL,
  "channel" "notification_channel" NOT NULL,
  "status" "notification_delivery_status" NOT NULL DEFAULT 'pending',
  "attempted_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_notification_id_channel_key" UNIQUE ("notification_id", "channel")
);

CREATE INDEX "notification_deliveries_status_channel_created_at_idx"
  ON "notification_deliveries"("status", "channel", "created_at");
