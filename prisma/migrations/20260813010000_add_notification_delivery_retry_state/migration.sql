ALTER TYPE "notification_delivery_status" ADD VALUE IF NOT EXISTS 'processing';

ALTER TABLE "notification_deliveries"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error_code" TEXT;
