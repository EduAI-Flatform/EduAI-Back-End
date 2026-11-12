CREATE TYPE "platform_support_status" AS ENUM ('open', 'in_progress', 'resolved', 'closed');
CREATE TYPE "platform_partner_category" AS ENUM ('school', 'business', 'scholarship', 'digital');
CREATE TYPE "platform_partner_status" AS ENUM ('submitted', 'reviewing', 'contacted', 'accepted', 'rejected');

CREATE TABLE "platform_support_tickets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "owner_id" UUID NOT NULL,
  "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "status" "platform_support_status" NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_support_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_support_tickets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "platform_support_replies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "ticket_id" UUID NOT NULL, "author_id" UUID NOT NULL,
  "content" TEXT NOT NULL, "is_staff" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_support_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_support_replies_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "platform_support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "platform_support_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "platform_partner_applications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "submitted_by_id" UUID,
  "category" "platform_partner_category" NOT NULL, "name" TEXT NOT NULL, "organization" TEXT NOT NULL,
  "phone" TEXT NOT NULL, "email" TEXT NOT NULL, "content" TEXT NOT NULL, "consent_at" TIMESTAMP(3) NOT NULL,
  "policy_id" UUID, "status" "platform_partner_status" NOT NULL DEFAULT 'submitted',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_partner_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_partner_applications_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "platform_support_tickets_owner_id_created_at_idx" ON "platform_support_tickets"("owner_id", "created_at");
CREATE INDEX "platform_support_tickets_status_created_at_idx" ON "platform_support_tickets"("status", "created_at");
CREATE INDEX "platform_support_replies_ticket_id_created_at_idx" ON "platform_support_replies"("ticket_id", "created_at");
CREATE INDEX "platform_support_replies_author_id_idx" ON "platform_support_replies"("author_id");
CREATE INDEX "platform_partner_applications_status_created_at_idx" ON "platform_partner_applications"("status", "created_at");
CREATE INDEX "platform_partner_applications_submitted_by_id_idx" ON "platform_partner_applications"("submitted_by_id");

ALTER TABLE "platform_support_tickets"
  ADD COLUMN "request_type" TEXT NOT NULL DEFAULT 'support',
  ADD COLUMN "order_id" UUID,
  ADD COLUMN "invoice_details" JSONB,
  ADD CONSTRAINT "platform_invoice_order_fk" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "platform_support_request_type_check" CHECK ("request_type" IN ('support', 'invoice')),
  ADD CONSTRAINT "platform_invoice_metadata_check" CHECK (("request_type" = 'invoice' AND "order_id" IS NOT NULL AND "invoice_details" IS NOT NULL) OR ("request_type" = 'support' AND "order_id" IS NULL AND "invoice_details" IS NULL));
CREATE UNIQUE INDEX "platform_support_tickets_order_id_key" ON "platform_support_tickets"("order_id");
