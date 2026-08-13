CREATE TYPE "notification_email_purpose" AS ENUM ('transactional', 'optional');

ALTER TABLE "notification_deliveries"
  ADD COLUMN "email_purpose" "notification_email_purpose";

UPDATE "notification_deliveries"
SET "email_purpose" = 'optional'
WHERE "channel" = 'email';

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_email_purpose_channel_check"
  CHECK (
    ("channel" = 'email' AND "email_purpose" IS NOT NULL)
    OR ("channel" <> 'email' AND "email_purpose" IS NULL)
  );
