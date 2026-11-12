ALTER TABLE "platform_support_tickets"
ADD COLUMN "attachment_data" BYTEA,
ADD COLUMN "attachment_size" INTEGER;
ALTER TABLE "platform_support_tickets" ADD CONSTRAINT "platform_support_image_consistent" CHECK (
  (attachment_data IS NULL AND attachment_size IS NULL) OR
  (attachment_data IS NOT NULL AND attachment_size IS NOT NULL AND attachment_size > 0 AND attachment_size <= 12582912 AND octet_length(attachment_data) = attachment_size)
);
