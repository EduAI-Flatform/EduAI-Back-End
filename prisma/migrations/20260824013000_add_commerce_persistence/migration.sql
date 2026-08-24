-- CreateEnum
CREATE TYPE "commerce_product_type" AS ENUM ('course');

-- CreateEnum
CREATE TYPE "commerce_product_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "commerce_cart_status" AS ENUM ('active', 'converted', 'abandoned');

-- CreateEnum
CREATE TYPE "commerce_order_status" AS ENUM ('pending_payment', 'confirmed', 'cancelled', 'expired', 'late_payment_review', 'late_payment_refunded');

-- CreateEnum
CREATE TYPE "commerce_fulfillment_status" AS ENUM ('not_started', 'processing', 'fulfilled', 'failed');

-- CreateEnum
CREATE TYPE "commerce_benefit_type" AS ENUM ('voucher', 'scholarship');

-- CreateEnum
CREATE TYPE "commerce_reservation_status" AS ENUM ('reserved', 'consumed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "commerce_payment_status" AS ENUM ('created', 'pending', 'paid', 'failed', 'cancelled', 'expired', 'late_paid');

-- CreateEnum
CREATE TYPE "commerce_settlement_kind" AS ENUM ('provider_collection', 'no_payment_required');

-- CreateEnum
CREATE TYPE "commerce_settlement_disposition" AS ENUM ('matched', 'duplicate_collection', 'late_collection', 'internal');

-- CreateEnum
CREATE TYPE "commerce_reconciliation_kind" AS ENUM ('duplicate_collection', 'late_payment');

-- CreateEnum
CREATE TYPE "commerce_reconciliation_status" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "commerce_reconciliation_resolution" AS ENUM ('accept', 'refund');

-- CreateEnum
CREATE TYPE "commerce_refund_status" AS ENUM ('requested', 'recorded', 'rejected');

-- CreateEnum
CREATE TYPE "commerce_lifecycle_entity_type" AS ENUM ('order', 'payment', 'fulfillment', 'reservation', 'reconciliation', 'refund');

-- CreateEnum
CREATE TYPE "commerce_actor_kind" AS ENUM ('user', 'system', 'provider');

-- CreateEnum
CREATE TYPE "commerce_idempotency_status" AS ENUM ('in_progress', 'completed', 'failed');

-- CreateTable
CREATE TABLE "commerce_products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "commerce_product_type" NOT NULL DEFAULT 'course',
    "course_id" UUID,
    "seller_id" UUID NOT NULL,
    "status" "commerce_product_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "commerce_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "buyer_id" UUID NOT NULL,
    "status" "commerce_cart_status" NOT NULL DEFAULT 'active',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "converted_at" TIMESTAMP(3),
    "abandoned_at" TIMESTAMP(3),

    CONSTRAINT "commerce_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_cart_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_cart_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" VARCHAR(40) NOT NULL,
    "cart_id" UUID,
    "buyer_id" UUID NOT NULL,
    "status" "commerce_order_status" NOT NULL DEFAULT 'pending_payment',
    "fulfillment_status" "commerce_fulfillment_status" NOT NULL DEFAULT 'not_started',
    "status_operation_id" UUID,
    "fulfillment_operation_id" UUID,
    "subtotal_amount_minor" BIGINT NOT NULL,
    "discount_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "payable_amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "pricing_policy_version" VARCHAR(40) NOT NULL,
    "confirmed_settlement_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "commerce_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_type" "commerce_product_type" NOT NULL,
    "product_reference_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "display_title" VARCHAR(240) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_list_price_amount_minor" BIGINT NOT NULL,
    "subtotal_amount_minor" BIGINT NOT NULL,
    "discount_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "final_amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_line_benefits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_line_id" UUID NOT NULL,
    "benefit_type" "commerce_benefit_type" NOT NULL,
    "source_id" UUID NOT NULL,
    "policy_version" VARCHAR(40) NOT NULL,
    "source_version" VARCHAR(80),
    "allocated_discount_amount_minor" BIGINT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_line_benefits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_promotion_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "buyer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "benefit_type" "commerce_benefit_type" NOT NULL,
    "voucher_id" UUID,
    "scholarship_award_id" UUID,
    "status" "commerce_reservation_status" NOT NULL DEFAULT 'reserved',
    "status_operation_id" UUID,
    "reserved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),

    CONSTRAINT "commerce_promotion_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payment_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "local_request_identity" UUID NOT NULL,
    "provider_payment_identity" VARCHAR(128),
    "status" "commerce_payment_status" NOT NULL DEFAULT 'created',
    "status_operation_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "provider_status_checked_at" TIMESTAMP(3),
    "provider_cancellation_requested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "commerce_payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_attempt_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_identity" VARCHAR(128) NOT NULL,
    "provider_payment_identity" VARCHAR(128),
    "provider_settlement_reference" VARCHAR(128),
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "next_status" "commerce_payment_status" NOT NULL,
    "provider_occurred_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "payment_attempt_id" UUID,
    "payment_event_id" UUID,
    "kind" "commerce_settlement_kind" NOT NULL,
    "disposition" "commerce_settlement_disposition" NOT NULL,
    "provider" VARCHAR(32),
    "provider_settlement_reference" VARCHAR(128),
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "settled_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_reconciliation_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "kind" "commerce_reconciliation_kind" NOT NULL,
    "status" "commerce_reconciliation_status" NOT NULL DEFAULT 'open',
    "status_operation_id" UUID,
    "resolution" "commerce_reconciliation_resolution",
    "resolved_by_id" UUID,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "commerce_reconciliation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "reconciliation_case_id" UUID,
    "status" "commerce_refund_status" NOT NULL DEFAULT 'requested',
    "status_operation_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "provider" VARCHAR(32),
    "external_reference" VARCHAR(128),
    "requested_by_id" UUID NOT NULL,
    "recorded_by_id" UUID,
    "reason_code" VARCHAR(80) NOT NULL,
    "rejection_reason_code" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),

    CONSTRAINT "commerce_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_refund_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "refund_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_refund_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_lifecycle_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" "commerce_lifecycle_entity_type" NOT NULL,
    "entity_id" UUID NOT NULL,
    "previous_status" VARCHAR(40) NOT NULL,
    "next_status" VARCHAR(40) NOT NULL,
    "actor_kind" "commerce_actor_kind" NOT NULL,
    "actor_id" UUID,
    "operation_id" UUID NOT NULL,
    "reason_code" VARCHAR(80),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(80) NOT NULL,
    "key_hash" VARCHAR(128) NOT NULL,
    "key_hash_version" INTEGER NOT NULL,
    "request_hash" VARCHAR(128) NOT NULL,
    "request_canonicalization_version" INTEGER NOT NULL,
    "status" "commerce_idempotency_status" NOT NULL DEFAULT 'in_progress',
    "resource_type" VARCHAR(80),
    "resource_id" UUID,
    "locked_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "commerce_idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_products_course_id_key" ON "commerce_products"("course_id");

-- CreateIndex
CREATE INDEX "commerce_products_seller_id_status_idx" ON "commerce_products"("seller_id", "status");

-- CreateIndex
CREATE INDEX "commerce_products_status_updated_at_idx" ON "commerce_products"("status", "updated_at");

-- CreateIndex
CREATE INDEX "commerce_products_archived_at_idx" ON "commerce_products"("archived_at");

-- CreateIndex
CREATE INDEX "commerce_carts_buyer_id_status_idx" ON "commerce_carts"("buyer_id", "status");

-- CreateIndex
CREATE INDEX "commerce_carts_status_updated_at_idx" ON "commerce_carts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "commerce_cart_lines_product_id_idx" ON "commerce_cart_lines"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_cart_lines_cart_id_product_id_key" ON "commerce_cart_lines"("cart_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_order_number_key" ON "commerce_orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_cart_id_key" ON "commerce_orders"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_confirmed_settlement_id_key" ON "commerce_orders"("confirmed_settlement_id");

-- CreateIndex
CREATE INDEX "commerce_orders_buyer_id_created_at_idx" ON "commerce_orders"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "commerce_orders_buyer_id_status_created_at_idx" ON "commerce_orders"("buyer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "commerce_orders_status_created_at_idx" ON "commerce_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "commerce_orders_fulfillment_status_updated_at_idx" ON "commerce_orders"("fulfillment_status", "updated_at");

-- CreateIndex
CREATE INDEX "commerce_orders_archived_at_idx" ON "commerce_orders"("archived_at");

-- CreateIndex
CREATE INDEX "commerce_order_lines_seller_id_created_at_idx" ON "commerce_order_lines"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "commerce_order_lines_product_type_product_reference_id_idx" ON "commerce_order_lines"("product_type", "product_reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_order_lines_order_id_product_id_key" ON "commerce_order_lines"("order_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_order_line_benefits_reservation_id_key" ON "commerce_order_line_benefits"("reservation_id");

-- CreateIndex
CREATE INDEX "commerce_order_line_benefits_benefit_type_source_id_idx" ON "commerce_order_line_benefits"("benefit_type", "source_id");

-- CreateIndex
CREATE INDEX "commerce_promotion_reservations_order_id_status_idx" ON "commerce_promotion_reservations"("order_id", "status");

-- CreateIndex
CREATE INDEX "commerce_promotion_reservations_order_line_id_idx" ON "commerce_promotion_reservations"("order_line_id");

-- CreateIndex
CREATE INDEX "commerce_promotion_reservations_voucher_id_status_idx" ON "commerce_promotion_reservations"("voucher_id", "status");

-- CreateIndex
CREATE INDEX "commerce_promotion_reservations_buyer_id_voucher_id_status_idx" ON "commerce_promotion_reservations"("buyer_id", "voucher_id", "status");

-- CreateIndex
CREATE INDEX "commerce_promotion_reservations_scholarship_award_id_status_idx" ON "commerce_promotion_reservations"("scholarship_award_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payment_attempts_local_request_identity_key" ON "commerce_payment_attempts"("local_request_identity");

-- CreateIndex
CREATE INDEX "commerce_payment_attempts_order_id_status_idx" ON "commerce_payment_attempts"("order_id", "status");

-- CreateIndex
CREATE INDEX "commerce_payment_attempts_status_updated_at_idx" ON "commerce_payment_attempts"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payment_attempts_provider_provider_payment_identit_key" ON "commerce_payment_attempts"("provider", "provider_payment_identity");

-- CreateIndex
CREATE INDEX "commerce_payment_events_payment_attempt_id_received_at_idx" ON "commerce_payment_events"("payment_attempt_id", "received_at");

-- CreateIndex
CREATE INDEX "commerce_payment_events_provider_provider_payment_identity_idx" ON "commerce_payment_events"("provider", "provider_payment_identity");

-- CreateIndex
CREATE INDEX "commerce_payment_events_provider_provider_settlement_refere_idx" ON "commerce_payment_events"("provider", "provider_settlement_reference");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payment_events_provider_provider_event_identity_key" ON "commerce_payment_events"("provider", "provider_event_identity");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_settlements_payment_event_id_key" ON "commerce_settlements"("payment_event_id");

-- CreateIndex
CREATE INDEX "commerce_settlements_order_id_recorded_at_idx" ON "commerce_settlements"("order_id", "recorded_at");

-- CreateIndex
CREATE INDEX "commerce_settlements_payment_attempt_id_idx" ON "commerce_settlements"("payment_attempt_id");

-- CreateIndex
CREATE INDEX "commerce_settlements_disposition_recorded_at_idx" ON "commerce_settlements"("disposition", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_settlements_provider_provider_settlement_reference_key" ON "commerce_settlements"("provider", "provider_settlement_reference");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_reconciliation_cases_settlement_id_key" ON "commerce_reconciliation_cases"("settlement_id");

-- CreateIndex
CREATE INDEX "commerce_reconciliation_cases_status_opened_at_idx" ON "commerce_reconciliation_cases"("status", "opened_at");

-- CreateIndex
CREATE INDEX "commerce_reconciliation_cases_order_id_status_idx" ON "commerce_reconciliation_cases"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_refunds_reconciliation_case_id_key" ON "commerce_refunds"("reconciliation_case_id");

-- CreateIndex
CREATE INDEX "commerce_refunds_order_id_status_created_at_idx" ON "commerce_refunds"("order_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "commerce_refunds_settlement_id_status_idx" ON "commerce_refunds"("settlement_id", "status");

-- CreateIndex
CREATE INDEX "commerce_refunds_requested_by_id_created_at_idx" ON "commerce_refunds"("requested_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_refunds_provider_external_reference_key" ON "commerce_refunds"("provider", "external_reference");

-- CreateIndex
CREATE INDEX "commerce_refund_allocations_order_line_id_idx" ON "commerce_refund_allocations"("order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_refund_allocations_refund_id_order_line_id_key" ON "commerce_refund_allocations"("refund_id", "order_line_id");

-- CreateIndex
CREATE INDEX "commerce_lifecycle_events_entity_type_entity_id_occurred_at_idx" ON "commerce_lifecycle_events"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "commerce_lifecycle_events_actor_id_occurred_at_idx" ON "commerce_lifecycle_events"("actor_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_lifecycle_events_entity_type_entity_id_operation_i_key" ON "commerce_lifecycle_events"("entity_type", "entity_id", "operation_id");

-- CreateIndex
CREATE INDEX "commerce_idempotency_records_status_locked_until_idx" ON "commerce_idempotency_records"("status", "locked_until");

-- CreateIndex
CREATE INDEX "commerce_idempotency_records_resource_type_resource_id_idx" ON "commerce_idempotency_records"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_idempotency_records_actor_id_operation_key_hash_ve_key" ON "commerce_idempotency_records"("actor_id", "operation", "key_hash_version", "key_hash");

-- AddForeignKey
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_carts" ADD CONSTRAINT "commerce_carts_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_cart_lines" ADD CONSTRAINT "commerce_cart_lines_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "commerce_carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_cart_lines" ADD CONSTRAINT "commerce_cart_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commerce_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "commerce_carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_confirmed_settlement_id_fkey" FOREIGN KEY ("confirmed_settlement_id") REFERENCES "commerce_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_lines" ADD CONSTRAINT "commerce_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_lines" ADD CONSTRAINT "commerce_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commerce_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_lines" ADD CONSTRAINT "commerce_order_lines_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_line_benefits" ADD CONSTRAINT "commerce_order_line_benefits_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_line_benefits" ADD CONSTRAINT "commerce_order_line_benefits_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "commerce_promotion_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_promotion_reservations" ADD CONSTRAINT "commerce_promotion_reservations_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_promotion_reservations" ADD CONSTRAINT "commerce_promotion_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_promotion_reservations" ADD CONSTRAINT "commerce_promotion_reservations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_promotion_reservations" ADD CONSTRAINT "commerce_promotion_reservations_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_promotion_reservations" ADD CONSTRAINT "commerce_promotion_reservations_scholarship_award_id_fkey" FOREIGN KEY ("scholarship_award_id") REFERENCES "scholarship_awards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payment_attempts" ADD CONSTRAINT "commerce_payment_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payment_events" ADD CONSTRAINT "commerce_payment_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "commerce_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_settlements" ADD CONSTRAINT "commerce_settlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_settlements" ADD CONSTRAINT "commerce_settlements_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "commerce_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_settlements" ADD CONSTRAINT "commerce_settlements_payment_event_id_fkey" FOREIGN KEY ("payment_event_id") REFERENCES "commerce_payment_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_reconciliation_cases" ADD CONSTRAINT "commerce_reconciliation_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_reconciliation_cases" ADD CONSTRAINT "commerce_reconciliation_cases_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "commerce_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_reconciliation_cases" ADD CONSTRAINT "commerce_reconciliation_cases_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "commerce_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_reconciliation_case_id_fkey" FOREIGN KEY ("reconciliation_case_id") REFERENCES "commerce_reconciliation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refund_allocations" ADD CONSTRAINT "commerce_refund_allocations_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "commerce_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refund_allocations" ADD CONSTRAINT "commerce_refund_allocations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_lifecycle_events" ADD CONSTRAINT "commerce_lifecycle_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_idempotency_records" ADD CONSTRAINT "commerce_idempotency_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Commerce-only invariants below are intentionally absent from the Prisma
-- datamodel because they require PostgreSQL checks, partial indexes, and
-- transition/constraint triggers. No existing table is altered by this
-- migration.

ALTER TABLE "commerce_products"
  ADD CONSTRAINT "commerce_products_supported_source_check"
    CHECK ("type" = 'course' AND "course_id" IS NOT NULL),
  ADD CONSTRAINT "commerce_products_archive_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));

ALTER TABLE "commerce_carts"
  ADD CONSTRAINT "commerce_carts_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_carts_status_timestamp_check" CHECK (
    ("status" = 'active' AND "converted_at" IS NULL AND "abandoned_at" IS NULL)
    OR ("status" = 'converted' AND "converted_at" IS NOT NULL AND "abandoned_at" IS NULL)
    OR ("status" = 'abandoned' AND "converted_at" IS NULL AND "abandoned_at" IS NOT NULL)
  );

ALTER TABLE "commerce_cart_lines"
  ADD CONSTRAINT "commerce_cart_lines_quantity_check" CHECK ("quantity" = 1);

ALTER TABLE "commerce_orders"
  ADD CONSTRAINT "commerce_orders_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_orders_totals_check" CHECK (
    "subtotal_amount_minor" >= 0
    AND "discount_amount_minor" >= 0
    AND "discount_amount_minor" <= "subtotal_amount_minor"
    AND "payable_amount_minor" = "subtotal_amount_minor" - "discount_amount_minor"
  ),
  ADD CONSTRAINT "commerce_orders_status_timestamp_check" CHECK (
    NOT ("cancelled_at" IS NOT NULL AND "expired_at" IS NOT NULL)
    AND (
      ("status" = 'pending_payment' AND "confirmed_at" IS NULL AND "cancelled_at" IS NULL AND "expired_at" IS NULL)
      OR ("status" = 'confirmed' AND "confirmed_at" IS NOT NULL AND "confirmed_settlement_id" IS NOT NULL AND "cancelled_at" IS NULL AND "expired_at" IS NULL)
      OR ("status" = 'cancelled' AND "confirmed_at" IS NULL AND "cancelled_at" IS NOT NULL AND "expired_at" IS NULL)
      OR ("status" = 'expired' AND "confirmed_at" IS NULL AND "cancelled_at" IS NULL AND "expired_at" IS NOT NULL)
      OR ("status" IN ('late_payment_review', 'late_payment_refunded') AND "confirmed_at" IS NULL AND ("cancelled_at" IS NOT NULL OR "expired_at" IS NOT NULL))
    )
  ),
  ADD CONSTRAINT "commerce_orders_fulfillment_check" CHECK (
    "fulfillment_status" = 'not_started' OR "status" = 'confirmed'
  );

ALTER TABLE "commerce_order_lines"
  ADD CONSTRAINT "commerce_order_lines_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_order_lines_quantity_check" CHECK ("quantity" = 1),
  ADD CONSTRAINT "commerce_order_lines_totals_check" CHECK (
    "unit_list_price_amount_minor" >= 0
    AND "subtotal_amount_minor" = "unit_list_price_amount_minor" * "quantity"
    AND "discount_amount_minor" >= 0
    AND "discount_amount_minor" <= "subtotal_amount_minor"
    AND "final_amount_minor" = "subtotal_amount_minor" - "discount_amount_minor"
  );

ALTER TABLE "commerce_order_line_benefits"
  ADD CONSTRAINT "commerce_order_line_benefits_amount_check"
    CHECK ("allocated_discount_amount_minor" >= 0);

ALTER TABLE "commerce_promotion_reservations"
  ADD CONSTRAINT "commerce_reservations_source_check" CHECK (
    ("benefit_type" = 'voucher' AND "voucher_id" IS NOT NULL AND "scholarship_award_id" IS NULL)
    OR ("benefit_type" = 'scholarship' AND "voucher_id" IS NULL AND "scholarship_award_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "commerce_reservations_expiry_check" CHECK ("expires_at" > "reserved_at"),
  ADD CONSTRAINT "commerce_reservations_status_timestamp_check" CHECK (
    ("status" = 'reserved' AND "consumed_at" IS NULL AND "released_at" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'consumed' AND "consumed_at" IS NOT NULL AND "released_at" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'released' AND "consumed_at" IS NULL AND "released_at" IS NOT NULL AND "expired_at" IS NULL)
    OR ("status" = 'expired' AND "consumed_at" IS NULL AND "released_at" IS NULL AND "expired_at" IS NOT NULL)
  );

ALTER TABLE "commerce_payment_attempts"
  ADD CONSTRAINT "commerce_payment_attempts_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_payment_attempts_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "commerce_payment_attempts_status_timestamp_check" CHECK (
    ("status" IN ('created', 'pending') AND "paid_at" IS NULL AND "closed_at" IS NULL)
    OR ("status" IN ('paid', 'late_paid') AND "paid_at" IS NOT NULL)
    OR ("status" IN ('failed', 'cancelled', 'expired') AND "paid_at" IS NULL AND "closed_at" IS NOT NULL)
  );

ALTER TABLE "commerce_payment_events"
  ADD CONSTRAINT "commerce_payment_events_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_payment_events_amount_check" CHECK ("amount_minor" >= 0);

ALTER TABLE "commerce_settlements"
  ADD CONSTRAINT "commerce_settlements_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_settlements_shape_check" CHECK (
    (
      "kind" = 'provider_collection'
      AND "disposition" IN ('matched', 'duplicate_collection', 'late_collection')
      AND "payment_attempt_id" IS NOT NULL
      AND "payment_event_id" IS NOT NULL
      AND "provider" IS NOT NULL
      AND "provider_settlement_reference" IS NOT NULL
      AND "amount_minor" > 0
    )
    OR (
      "kind" = 'no_payment_required'
      AND "disposition" = 'internal'
      AND "payment_attempt_id" IS NULL
      AND "payment_event_id" IS NULL
      AND "provider" IS NULL
      AND "provider_settlement_reference" IS NULL
      AND "amount_minor" = 0
    )
  );

ALTER TABLE "commerce_reconciliation_cases"
  ADD CONSTRAINT "commerce_reconciliation_status_check" CHECK (
    ("status" = 'open' AND "resolution" IS NULL AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'resolved' AND "resolution" IS NOT NULL AND "resolved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL)
  );

ALTER TABLE "commerce_refunds"
  ADD CONSTRAINT "commerce_refunds_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_refunds_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "commerce_refunds_status_check" CHECK (
    ("status" = 'requested' AND "external_reference" IS NULL AND "recorded_by_id" IS NULL AND "recorded_at" IS NULL AND "rejected_at" IS NULL)
    OR ("status" = 'recorded' AND "provider" IS NOT NULL AND "external_reference" IS NOT NULL AND "recorded_by_id" IS NOT NULL AND "recorded_at" IS NOT NULL AND "rejected_at" IS NULL)
    OR ("status" = 'rejected' AND "external_reference" IS NULL AND "recorded_by_id" IS NULL AND "recorded_at" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_reason_code" IS NOT NULL)
  );

ALTER TABLE "commerce_refund_allocations"
  ADD CONSTRAINT "commerce_refund_allocations_currency_check" CHECK ("currency" = 'VND'),
  ADD CONSTRAINT "commerce_refund_allocations_amount_check" CHECK ("amount_minor" > 0);

ALTER TABLE "commerce_lifecycle_events"
  ADD CONSTRAINT "commerce_lifecycle_events_actor_check" CHECK (
    ("actor_kind" = 'user' AND "actor_id" IS NOT NULL)
    OR ("actor_kind" IN ('system', 'provider') AND "actor_id" IS NULL)
  );

ALTER TABLE "commerce_idempotency_records"
  ADD CONSTRAINT "commerce_idempotency_versions_check" CHECK (
    "key_hash_version" > 0 AND "request_canonicalization_version" > 0
  ),
  ADD CONSTRAINT "commerce_idempotency_hashes_check" CHECK (
    length("key_hash") >= 32 AND length("request_hash") >= 32
  ),
  ADD CONSTRAINT "commerce_idempotency_status_check" CHECK (
    ("status" = 'in_progress' AND "completed_at" IS NULL AND "failed_at" IS NULL)
    OR ("status" = 'completed' AND "completed_at" IS NOT NULL AND "failed_at" IS NULL AND "resource_type" IS NOT NULL AND "resource_id" IS NOT NULL)
    OR ("status" = 'failed' AND "completed_at" IS NULL AND "failed_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "commerce_carts_one_active_per_buyer_idx"
  ON "commerce_carts"("buyer_id") WHERE "status" = 'active';

CREATE UNIQUE INDEX "commerce_payment_attempts_one_open_per_order_idx"
  ON "commerce_payment_attempts"("order_id")
  WHERE "status" IN ('created', 'pending');

CREATE UNIQUE INDEX "commerce_settlements_one_internal_per_order_idx"
  ON "commerce_settlements"("order_id")
  WHERE "kind" = 'no_payment_required';

CREATE UNIQUE INDEX "commerce_settlements_one_matched_per_order_idx"
  ON "commerce_settlements"("order_id")
  WHERE "disposition" = 'matched';

CREATE UNIQUE INDEX "commerce_reservations_one_voucher_per_order_idx"
  ON "commerce_promotion_reservations"("order_id", "voucher_id")
  WHERE "voucher_id" IS NOT NULL AND "status" IN ('reserved', 'consumed');

CREATE UNIQUE INDEX "commerce_reservations_one_scholarship_award_idx"
  ON "commerce_promotion_reservations"("scholarship_award_id")
  WHERE "scholarship_award_id" IS NOT NULL AND "status" IN ('reserved', 'consumed');

ALTER INDEX "commerce_payment_attempts_provider_provider_payment_identit_key"
  RENAME TO "commerce_payment_attempts_provider_payment_identity_key";
ALTER INDEX "commerce_payment_events_provider_provider_event_identity_key"
  RENAME TO "commerce_payment_events_provider_event_identity_key";
ALTER INDEX "commerce_settlements_provider_provider_settlement_reference_key"
  RENAME TO "commerce_settlements_provider_reference_key";
ALTER INDEX "commerce_refunds_provider_external_reference_key"
  RENAME TO "commerce_refunds_provider_reference_key";

CREATE FUNCTION "commerce_reject_immutable_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable commerce record % cannot be changed', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION "commerce_reject_financial_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce record % must be archived or transitioned, not deleted', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION "commerce_guard_initial_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_status text := to_jsonb(NEW)->>'status';
  new_fulfillment_status text := to_jsonb(NEW)->>'fulfillment_status';
  initial_status_operation text := to_jsonb(NEW)->>'status_operation_id';
  initial_fulfillment_operation text := to_jsonb(NEW)->>'fulfillment_operation_id';
BEGIN
  IF TG_TABLE_NAME = 'commerce_products' THEN
    IF new_status <> 'draft' THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_carts' THEN
    IF new_status <> 'active' THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_orders' THEN
    IF new_status <> 'pending_payment' OR new_fulfillment_status <> 'not_started'
       OR initial_status_operation IS NOT NULL OR initial_fulfillment_operation IS NOT NULL THEN
      RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'commerce_promotion_reservations' THEN
    IF new_status <> 'reserved' OR initial_status_operation IS NOT NULL THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_payment_attempts' THEN
    IF new_status <> 'created' OR initial_status_operation IS NOT NULL THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_reconciliation_cases' THEN
    IF new_status <> 'open' OR initial_status_operation IS NOT NULL THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_refunds' THEN
    IF new_status <> 'requested' OR initial_status_operation IS NOT NULL THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'commerce_idempotency_records' THEN
    IF new_status <> 'in_progress' THEN RAISE EXCEPTION '% must be created in its initial state', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_products_guard_initial_state" BEFORE INSERT ON "commerce_products"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_carts_guard_initial_state" BEFORE INSERT ON "commerce_carts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_orders_guard_initial_state" BEFORE INSERT ON "commerce_orders"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_reservations_guard_initial_state" BEFORE INSERT ON "commerce_promotion_reservations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_payment_attempts_guard_initial_state" BEFORE INSERT ON "commerce_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_reconciliation_cases_guard_initial_state" BEFORE INSERT ON "commerce_reconciliation_cases"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_refunds_guard_initial_state" BEFORE INSERT ON "commerce_refunds"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();
CREATE TRIGGER "commerce_idempotency_records_guard_initial_state" BEFORE INSERT ON "commerce_idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_initial_state"();

CREATE TRIGGER "commerce_order_lines_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
CREATE TRIGGER "commerce_order_line_benefits_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_order_line_benefits"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
CREATE TRIGGER "commerce_payment_events_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_payment_events"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
CREATE TRIGGER "commerce_settlements_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_settlements"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
CREATE TRIGGER "commerce_refund_allocations_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_refund_allocations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();
CREATE TRIGGER "commerce_lifecycle_events_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();

CREATE TRIGGER "commerce_products_no_delete"
  BEFORE DELETE ON "commerce_products"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();

CREATE FUNCTION "commerce_validate_product_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  course_instructor uuid;
BEGIN
  SELECT "instructor_id" INTO course_instructor FROM "courses" WHERE "id" = NEW."course_id";
  IF course_instructor IS DISTINCT FROM NEW."seller_id" THEN
    RAISE EXCEPTION 'commerce product seller must own the source course' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_products_validate_source"
  BEFORE INSERT ON "commerce_products"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_product_source"();

CREATE FUNCTION "commerce_validate_order_ownership"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cart_buyer uuid;
  cart_currency varchar(3);
  cart_status "commerce_cart_status";
BEGIN
  IF NEW."cart_id" IS NULL THEN RETURN NEW; END IF;
  SELECT "buyer_id", "currency", "status" INTO cart_buyer, cart_currency, cart_status
    FROM "commerce_carts" WHERE "id" = NEW."cart_id";
  IF cart_buyer IS DISTINCT FROM NEW."buyer_id" OR cart_currency IS DISTINCT FROM NEW."currency"
     OR cart_status <> 'active' THEN
    RAISE EXCEPTION 'order must own an active cart with matching buyer and currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_orders_validate_ownership"
  BEFORE INSERT ON "commerce_orders"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_order_ownership"();
CREATE TRIGGER "commerce_carts_no_delete"
  BEFORE DELETE ON "commerce_carts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_orders_no_delete"
  BEFORE DELETE ON "commerce_orders"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_reservations_no_delete"
  BEFORE DELETE ON "commerce_promotion_reservations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_payment_attempts_no_delete"
  BEFORE DELETE ON "commerce_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_reconciliation_cases_no_delete"
  BEFORE DELETE ON "commerce_reconciliation_cases"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_refunds_no_delete"
  BEFORE DELETE ON "commerce_refunds"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();
CREATE TRIGGER "commerce_idempotency_records_no_delete"
  BEFORE DELETE ON "commerce_idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_financial_delete"();

CREATE FUNCTION "commerce_guard_product_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."type", NEW."course_id", NEW."seller_id", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."type", OLD."course_id", OLD."seller_id", OLD."created_at") THEN
    RAISE EXCEPTION 'commerce product source facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status" = 'draft' AND NEW."status" IN ('active', 'archived'))
       OR (OLD."status" = 'active' AND NEW."status" = 'archived')
     ) THEN
    RAISE EXCEPTION 'invalid commerce product status transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS DISTINCT FROM OLD."archived_at" THEN
    RAISE EXCEPTION 'commerce product archive timestamp is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_products_guard_update"
  BEFORE UPDATE ON "commerce_products"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_product_update"();

CREATE FUNCTION "commerce_guard_cart_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."buyer_id", NEW."currency", NEW."created_at")
     IS DISTINCT FROM ROW(OLD."buyer_id", OLD."currency", OLD."created_at") THEN
    RAISE EXCEPTION 'commerce cart ownership facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'active' AND NEW."status" IN ('converted', 'abandoned')) THEN
    RAISE EXCEPTION 'invalid commerce cart status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_carts_guard_update"
  BEFORE UPDATE ON "commerce_carts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_cart_update"();

CREATE FUNCTION "commerce_validate_converted_cart"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'converted' AND NOT EXISTS (
    SELECT 1 FROM "commerce_orders"
      WHERE "cart_id" = NEW."id" AND "buyer_id" = NEW."buyer_id" AND "currency" = NEW."currency"
  ) THEN
    RAISE EXCEPTION 'converted cart requires its matching order' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_carts_validate_conversion"
  AFTER UPDATE ON "commerce_carts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_converted_cart"();

CREATE FUNCTION "commerce_guard_cart_line_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_cart_id uuid := COALESCE(NEW."cart_id", OLD."cart_id");
  cart_status "commerce_cart_status";
  product_status "commerce_product_status";
BEGIN
  SELECT "status" INTO cart_status FROM "commerce_carts" WHERE "id" = target_cart_id;
  IF cart_status <> 'active' THEN
    RAISE EXCEPTION 'only an active cart may change lines' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "status" INTO product_status FROM "commerce_products" WHERE "id" = NEW."product_id";
    IF product_status <> 'active' THEN
      RAISE EXCEPTION 'only an active product may be placed in a cart' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "commerce_cart_lines_guard_change"
  BEFORE INSERT OR UPDATE OR DELETE ON "commerce_cart_lines"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_cart_line_change"();

CREATE FUNCTION "commerce_guard_order_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_number", NEW."cart_id", NEW."buyer_id", NEW."subtotal_amount_minor",
         NEW."discount_amount_minor", NEW."payable_amount_minor", NEW."currency",
         NEW."pricing_policy_version", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."order_number", OLD."cart_id", OLD."buyer_id", OLD."subtotal_amount_minor",
         OLD."discount_amount_minor", OLD."payable_amount_minor", OLD."currency",
         OLD."pricing_policy_version", OLD."created_at") THEN
    RAISE EXCEPTION 'commerce order financial facts are immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status" = 'pending_payment' AND NEW."status" IN ('confirmed', 'cancelled', 'expired'))
       OR (OLD."status" IN ('cancelled', 'expired') AND NEW."status" = 'late_payment_review')
       OR (OLD."status" = 'late_payment_review' AND NEW."status" IN ('confirmed', 'late_payment_refunded'))
     ) THEN
    RAISE EXCEPTION 'invalid commerce order status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status_operation_id" IS NULL OR NEW."status_operation_id" IS NOT DISTINCT FROM OLD."status_operation_id" THEN
      RAISE EXCEPTION 'order transition requires a fresh status operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status_operation_id" IS DISTINCT FROM OLD."status_operation_id" THEN
    RAISE EXCEPTION 'order status operation identity changes only with status' USING ERRCODE = '23514';
  END IF;

  IF NEW."fulfillment_status" IS DISTINCT FROM OLD."fulfillment_status"
     AND NOT (
       (OLD."fulfillment_status" = 'not_started' AND NEW."fulfillment_status" = 'processing')
       OR (OLD."fulfillment_status" = 'processing' AND NEW."fulfillment_status" IN ('fulfilled', 'failed'))
       OR (OLD."fulfillment_status" = 'failed' AND NEW."fulfillment_status" = 'processing')
     ) THEN
    RAISE EXCEPTION 'invalid commerce fulfillment transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."fulfillment_status" IS DISTINCT FROM OLD."fulfillment_status" THEN
    IF NEW."fulfillment_operation_id" IS NULL
       OR NEW."fulfillment_operation_id" IS NOT DISTINCT FROM OLD."fulfillment_operation_id" THEN
      RAISE EXCEPTION 'fulfillment transition requires a fresh operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."fulfillment_operation_id" IS DISTINCT FROM OLD."fulfillment_operation_id" THEN
    RAISE EXCEPTION 'fulfillment operation identity changes only with status' USING ERRCODE = '23514';
  END IF;

  IF OLD."confirmed_settlement_id" IS NOT NULL
     AND NEW."confirmed_settlement_id" IS DISTINCT FROM OLD."confirmed_settlement_id" THEN
    RAISE EXCEPTION 'confirmed settlement is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."confirmed_settlement_id" IS NOT NULL AND NEW."status" <> 'confirmed' THEN
    RAISE EXCEPTION 'only a confirmed order may reference its confirming settlement' USING ERRCODE = '23514';
  END IF;
  IF NEW."confirmed_settlement_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "commerce_settlements" settlement
      LEFT JOIN "commerce_payment_attempts" attempt ON attempt."id" = settlement."payment_attempt_id"
      WHERE settlement."id" = NEW."confirmed_settlement_id"
        AND settlement."order_id" = NEW."id"
        AND settlement."amount_minor" = NEW."payable_amount_minor"
        AND settlement."currency" = NEW."currency"
        AND (
          (settlement."disposition" = 'internal' AND settlement."kind" = 'no_payment_required')
          OR (settlement."disposition" = 'matched' AND attempt."status" = 'paid')
          OR (settlement."disposition" = 'late_collection' AND attempt."status" = 'late_paid')
        )
  ) THEN
    RAISE EXCEPTION 'confirming settlement must belong to the order and be confirmable' USING ERRCODE = '23514';
  END IF;
  IF (OLD."confirmed_at" IS NOT NULL AND NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at")
     OR (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
     OR (OLD."expired_at" IS NOT NULL AND NEW."expired_at" IS DISTINCT FROM OLD."expired_at") THEN
    RAISE EXCEPTION 'order terminal timestamps are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS DISTINCT FROM OLD."archived_at" THEN
    RAISE EXCEPTION 'commerce order archive timestamp is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_orders_guard_update"
  BEFORE UPDATE ON "commerce_orders"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_order_update"();

CREATE FUNCTION "commerce_guard_reservation_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."buyer_id", NEW."order_id", NEW."order_line_id", NEW."benefit_type",
         NEW."voucher_id", NEW."scholarship_award_id", NEW."reserved_at", NEW."expires_at")
     IS DISTINCT FROM
     ROW(OLD."buyer_id", OLD."order_id", OLD."order_line_id", OLD."benefit_type",
         OLD."voucher_id", OLD."scholarship_award_id", OLD."reserved_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'promotion reservation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'reserved' AND NEW."status" IN ('consumed', 'released', 'expired')) THEN
    RAISE EXCEPTION 'invalid promotion reservation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status_operation_id" IS NULL OR NEW."status_operation_id" IS NOT DISTINCT FROM OLD."status_operation_id" THEN
      RAISE EXCEPTION 'reservation transition requires a fresh operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status_operation_id" IS DISTINCT FROM OLD."status_operation_id" THEN
    RAISE EXCEPTION 'reservation operation identity changes only with status' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'consumed'
     AND NOT EXISTS (SELECT 1 FROM "commerce_orders" WHERE "id" = NEW."order_id" AND "status" = 'confirmed') THEN
    RAISE EXCEPTION 'only a confirmed order may consume a promotion reservation' USING ERRCODE = '23514';
  END IF;
  IF (OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at")
     OR (OLD."released_at" IS NOT NULL AND NEW."released_at" IS DISTINCT FROM OLD."released_at")
     OR (OLD."expired_at" IS NOT NULL AND NEW."expired_at" IS DISTINCT FROM OLD."expired_at") THEN
    RAISE EXCEPTION 'reservation terminal timestamps are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_reservations_guard_update"
  BEFORE UPDATE ON "commerce_promotion_reservations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_reservation_update"();

CREATE FUNCTION "commerce_guard_payment_attempt_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."provider", NEW."local_request_identity", NEW."amount_minor",
         NEW."currency", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."order_id", OLD."provider", OLD."local_request_identity", OLD."amount_minor",
         OLD."currency", OLD."created_at") THEN
    RAISE EXCEPTION 'payment attempt request facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."provider_payment_identity" IS NOT NULL
     AND NEW."provider_payment_identity" IS DISTINCT FROM OLD."provider_payment_identity" THEN
    RAISE EXCEPTION 'provider payment identity is immutable once assigned' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status" = 'created' AND NEW."status" IN ('pending', 'failed'))
       OR (OLD."status" = 'pending' AND NEW."status" IN ('paid', 'failed', 'cancelled', 'expired'))
       OR (OLD."status" IN ('cancelled', 'expired') AND NEW."status" = 'late_paid')
     ) THEN
    RAISE EXCEPTION 'invalid payment attempt status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status_operation_id" IS NULL OR NEW."status_operation_id" IS NOT DISTINCT FROM OLD."status_operation_id" THEN
      RAISE EXCEPTION 'payment transition requires a fresh operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status_operation_id" IS DISTINCT FROM OLD."status_operation_id" THEN
    RAISE EXCEPTION 'payment operation identity changes only with status' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('cancelled', 'expired')
     AND NEW."provider_status_checked_at" IS NULL
     AND NEW."provider_cancellation_requested_at" IS NULL THEN
    RAISE EXCEPTION 'closing a payment attempt requires a provider check or cancellation request'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at")
     OR (OLD."closed_at" IS NOT NULL AND NEW."closed_at" IS DISTINCT FROM OLD."closed_at")
     OR (OLD."provider_cancellation_requested_at" IS NOT NULL
         AND NEW."provider_cancellation_requested_at" IS DISTINCT FROM OLD."provider_cancellation_requested_at") THEN
    RAISE EXCEPTION 'payment terminal evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_payment_attempts_guard_update"
  BEFORE UPDATE ON "commerce_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_payment_attempt_update"();

CREATE FUNCTION "commerce_guard_reconciliation_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."settlement_id", NEW."kind", NEW."opened_at")
     IS DISTINCT FROM ROW(OLD."order_id", OLD."settlement_id", OLD."kind", OLD."opened_at") THEN
    RAISE EXCEPTION 'reconciliation source facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'open' AND NEW."status" = 'resolved') THEN
    RAISE EXCEPTION 'invalid reconciliation status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status_operation_id" IS NULL OR NEW."status_operation_id" IS NOT DISTINCT FROM OLD."status_operation_id" THEN
      RAISE EXCEPTION 'reconciliation transition requires a fresh operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status_operation_id" IS DISTINCT FROM OLD."status_operation_id" THEN
    RAISE EXCEPTION 'reconciliation operation identity changes only with status' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'resolved'
     AND ROW(NEW."resolution", NEW."resolved_by_id", NEW."resolved_at")
         IS DISTINCT FROM ROW(OLD."resolution", OLD."resolved_by_id", OLD."resolved_at") THEN
    RAISE EXCEPTION 'resolved reconciliation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_reconciliation_cases_guard_update"
  BEFORE UPDATE ON "commerce_reconciliation_cases"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_reconciliation_update"();

CREATE FUNCTION "commerce_guard_refund_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."settlement_id", NEW."reconciliation_case_id", NEW."amount_minor",
         NEW."currency", NEW."requested_by_id", NEW."reason_code", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."order_id", OLD."settlement_id", OLD."reconciliation_case_id", OLD."amount_minor",
         OLD."currency", OLD."requested_by_id", OLD."reason_code", OLD."created_at") THEN
    RAISE EXCEPTION 'refund request facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'requested' AND NEW."status" IN ('recorded', 'rejected')) THEN
    RAISE EXCEPTION 'invalid refund status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status_operation_id" IS NULL OR NEW."status_operation_id" IS NOT DISTINCT FROM OLD."status_operation_id" THEN
      RAISE EXCEPTION 'refund transition requires a fresh operation identity' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status_operation_id" IS DISTINCT FROM OLD."status_operation_id" THEN
    RAISE EXCEPTION 'refund operation identity changes only with status' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('recorded', 'rejected')
     AND ROW(NEW."provider", NEW."external_reference", NEW."recorded_by_id",
             NEW."rejection_reason_code", NEW."recorded_at", NEW."rejected_at")
         IS DISTINCT FROM
         ROW(OLD."provider", OLD."external_reference", OLD."recorded_by_id",
             OLD."rejection_reason_code", OLD."recorded_at", OLD."rejected_at") THEN
    RAISE EXCEPTION 'terminal refund evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_refunds_guard_update"
  BEFORE UPDATE ON "commerce_refunds"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_refund_update"();

CREATE FUNCTION "commerce_guard_idempotency_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."actor_id", NEW."operation", NEW."key_hash", NEW."key_hash_version",
         NEW."request_hash", NEW."request_canonicalization_version", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."actor_id", OLD."operation", OLD."key_hash", OLD."key_hash_version",
         OLD."request_hash", OLD."request_canonicalization_version", OLD."created_at") THEN
    RAISE EXCEPTION 'idempotency request identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'in_progress' AND NEW."status" IN ('completed', 'failed')) THEN
    RAISE EXCEPTION 'invalid idempotency status transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('completed', 'failed')
     AND ROW(NEW."resource_type", NEW."resource_id", NEW."locked_until", NEW."completed_at", NEW."failed_at")
         IS DISTINCT FROM
         ROW(OLD."resource_type", OLD."resource_id", OLD."locked_until", OLD."completed_at", OLD."failed_at") THEN
    RAISE EXCEPTION 'terminal idempotency result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_idempotency_records_guard_update"
  BEFORE UPDATE ON "commerce_idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_idempotency_update"();

CREATE FUNCTION "commerce_validate_order_line_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_row "commerce_orders"%ROWTYPE;
  product_row "commerce_products"%ROWTYPE;
  course_title text;
  course_price integer;
  course_currency varchar(3);
BEGIN
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = NEW."order_id";
  SELECT * INTO product_row FROM "commerce_products" WHERE "id" = NEW."product_id";
  IF order_row."id" IS NULL OR product_row."id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."currency" <> order_row."currency"
     OR NEW."product_type" <> product_row."type"
     OR NEW."product_reference_id" IS DISTINCT FROM product_row."course_id"
     OR NEW."seller_id" <> product_row."seller_id" THEN
    RAISE EXCEPTION 'order line snapshot does not match order/product authority' USING ERRCODE = '23514';
  END IF;
  SELECT "title", COALESCE("price_amount_minor", 0), COALESCE("price_currency", 'VND')
    INTO course_title, course_price, course_currency
    FROM "courses" WHERE "id" = product_row."course_id";
  IF product_row."status" <> 'active' OR course_title IS NULL
     OR NEW."display_title" <> course_title
     OR NEW."unit_list_price_amount_minor" <> course_price
     OR NEW."currency" <> course_currency THEN
    RAISE EXCEPTION 'order line must snapshot the active course title and current price' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_order_lines_validate_source"
  BEFORE INSERT ON "commerce_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_order_line_source"();

CREATE FUNCTION "commerce_validate_reservation_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_buyer uuid;
  line_order uuid;
  line_product_reference uuid;
BEGIN
  SELECT "buyer_id" INTO order_buyer FROM "commerce_orders" WHERE "id" = NEW."order_id";
  SELECT "order_id", "product_reference_id" INTO line_order, line_product_reference
    FROM "commerce_order_lines" WHERE "id" = NEW."order_line_id";
  IF order_buyer IS DISTINCT FROM NEW."buyer_id" OR line_order IS DISTINCT FROM NEW."order_id" THEN
    RAISE EXCEPTION 'reservation ownership does not match its order line' USING ERRCODE = '23514';
  END IF;
  IF NEW."voucher_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "vouchers"
       WHERE "id" = NEW."voucher_id" AND "status" = 'active' AND "currency" = 'VND'
         AND "starts_at" <= NEW."reserved_at" AND "ends_at" > NEW."reserved_at"
     ) THEN
    RAISE EXCEPTION 'reservation voucher is not currently monetary-eligible' USING ERRCODE = '23514';
  END IF;
  IF NEW."scholarship_award_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "scholarship_awards"
       WHERE "id" = NEW."scholarship_award_id" AND "user_id" = NEW."buyer_id"
         AND "course_id" = line_product_reference AND "benefit_kind" <> 'course_access'
         AND "revoked_at" IS NULL AND COALESCE("currency", 'VND') = 'VND'
     ) THEN
    RAISE EXCEPTION 'reservation scholarship award is not monetary-eligible for buyer and course' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_reservations_validate_source"
  BEFORE INSERT ON "commerce_promotion_reservations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_reservation_source"();

CREATE FUNCTION "commerce_validate_benefit_reservation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reservation_row "commerce_promotion_reservations"%ROWTYPE;
  source_identity uuid;
BEGIN
  SELECT * INTO reservation_row FROM "commerce_promotion_reservations" WHERE "id" = NEW."reservation_id";
  source_identity := COALESCE(reservation_row."voucher_id", reservation_row."scholarship_award_id");
  IF reservation_row."order_line_id" IS DISTINCT FROM NEW."order_line_id"
     OR reservation_row."benefit_type" IS DISTINCT FROM NEW."benefit_type"
     OR source_identity IS DISTINCT FROM NEW."source_id" THEN
    RAISE EXCEPTION 'benefit snapshot must match its reservation source and order line' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_order_line_benefits_validate_reservation"
  BEFORE INSERT ON "commerce_order_line_benefits"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_benefit_reservation"();

CREATE FUNCTION "commerce_validate_payment_attempt"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_row "commerce_orders"%ROWTYPE;
BEGIN
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = NEW."order_id";
  IF NEW."amount_minor" <> order_row."payable_amount_minor"
     OR NEW."currency" <> order_row."currency"
     OR order_row."payable_amount_minor" <= 0 THEN
    RAISE EXCEPTION 'payment attempt must match a positive authoritative order total' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_payment_attempts_validate_order"
  BEFORE INSERT ON "commerce_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_payment_attempt"();

CREATE FUNCTION "commerce_validate_payment_event"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_row "commerce_payment_attempts"%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM "commerce_payment_attempts" WHERE "id" = NEW."payment_attempt_id";
  IF NEW."provider" <> attempt_row."provider"
     OR NEW."amount_minor" <> attempt_row."amount_minor"
     OR NEW."currency" <> attempt_row."currency"
     OR (attempt_row."provider_payment_identity" IS NOT NULL
         AND NEW."provider_payment_identity" IS DISTINCT FROM attempt_row."provider_payment_identity") THEN
    RAISE EXCEPTION 'payment event does not match its local attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_payment_events_validate_attempt"
  BEFORE INSERT ON "commerce_payment_events"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_payment_event"();

CREATE FUNCTION "commerce_validate_settlement"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_row "commerce_orders"%ROWTYPE;
  attempt_order uuid;
  event_attempt uuid;
  event_provider varchar(32);
  event_reference varchar(128);
  event_next_status "commerce_payment_status";
BEGIN
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = NEW."order_id";
  IF NEW."amount_minor" <> order_row."payable_amount_minor" OR NEW."currency" <> order_row."currency" THEN
    RAISE EXCEPTION 'settlement must match authoritative order total' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'no_payment_required' THEN
    IF order_row."payable_amount_minor" <> 0 OR NEW."disposition" <> 'internal'
       OR NEW."payment_attempt_id" IS NOT NULL OR NEW."payment_event_id" IS NOT NULL
       OR NEW."provider" IS NOT NULL OR NEW."provider_settlement_reference" IS NOT NULL THEN
      RAISE EXCEPTION 'invalid internal zero-payable settlement' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "order_id" INTO attempt_order FROM "commerce_payment_attempts" WHERE "id" = NEW."payment_attempt_id";
    SELECT "payment_attempt_id", "provider", "provider_settlement_reference", "next_status"
      INTO event_attempt, event_provider, event_reference, event_next_status
      FROM "commerce_payment_events" WHERE "id" = NEW."payment_event_id";
    IF attempt_order IS DISTINCT FROM NEW."order_id" OR event_attempt IS DISTINCT FROM NEW."payment_attempt_id"
       OR event_provider IS DISTINCT FROM NEW."provider"
       OR event_reference IS DISTINCT FROM NEW."provider_settlement_reference"
       OR event_next_status NOT IN ('paid', 'late_paid') THEN
      RAISE EXCEPTION 'provider settlement does not match its event, attempt, and order' USING ERRCODE = '23514';
    END IF;
    IF (NEW."disposition" = 'matched' AND order_row."status" <> 'pending_payment')
       OR (NEW."disposition" = 'late_collection' AND order_row."status" NOT IN ('cancelled', 'expired', 'late_payment_review')) THEN
      RAISE EXCEPTION 'settlement disposition does not match current order state' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_settlements_validate_source"
  BEFORE INSERT ON "commerce_settlements"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_settlement"();

CREATE FUNCTION "commerce_validate_reconciliation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_order uuid;
  settlement_disposition "commerce_settlement_disposition";
BEGIN
  SELECT "order_id", "disposition" INTO settlement_order, settlement_disposition
    FROM "commerce_settlements" WHERE "id" = NEW."settlement_id";
  IF settlement_order IS DISTINCT FROM NEW."order_id"
     OR (NEW."kind" = 'duplicate_collection' AND settlement_disposition <> 'duplicate_collection')
     OR (NEW."kind" = 'late_payment' AND settlement_disposition <> 'late_collection') THEN
    RAISE EXCEPTION 'reconciliation case does not match settlement disposition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_reconciliation_cases_validate_source"
  BEFORE INSERT ON "commerce_reconciliation_cases"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_reconciliation"();

CREATE FUNCTION "commerce_validate_refund_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_row "commerce_settlements"%ROWTYPE;
BEGIN
  SELECT * INTO settlement_row FROM "commerce_settlements" WHERE "id" = NEW."settlement_id";
  IF settlement_row."order_id" IS DISTINCT FROM NEW."order_id"
     OR settlement_row."currency" IS DISTINCT FROM NEW."currency"
     OR settlement_row."kind" <> 'provider_collection'
     OR NEW."provider" IS DISTINCT FROM settlement_row."provider"
     OR NEW."amount_minor" > settlement_row."amount_minor" THEN
    RAISE EXCEPTION 'refund must target a matching provider settlement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_refunds_validate_source"
  BEFORE INSERT ON "commerce_refunds"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_refund_source"();

CREATE FUNCTION "commerce_validate_refund_allocation_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  refund_order uuid;
  refund_currency varchar(3);
  line_order uuid;
  line_currency varchar(3);
  line_total bigint;
BEGIN
  SELECT "order_id", "currency" INTO refund_order, refund_currency
    FROM "commerce_refunds" WHERE "id" = NEW."refund_id";
  SELECT "order_id", "currency", "final_amount_minor" INTO line_order, line_currency, line_total
    FROM "commerce_order_lines" WHERE "id" = NEW."order_line_id";
  IF line_order IS DISTINCT FROM refund_order OR NEW."currency" IS DISTINCT FROM refund_currency
     OR NEW."currency" IS DISTINCT FROM line_currency OR NEW."amount_minor" > line_total THEN
    RAISE EXCEPTION 'refund allocation must target a line in the same order and currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_refund_allocations_validate_source"
  BEFORE INSERT ON "commerce_refund_allocations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_refund_allocation_source"();

CREATE FUNCTION "commerce_validate_order_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  order_row "commerce_orders"%ROWTYPE;
  line_subtotal bigint;
  line_discount bigint;
  line_final bigint;
  line_count bigint;
  benefit_discount bigint;
BEGIN
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    target_order_id := NEW."id";
  ELSE
    target_order_id := NEW."order_id";
  END IF;
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = target_order_id;
  IF order_row."id" IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum("subtotal_amount_minor"), 0), COALESCE(sum("discount_amount_minor"), 0),
         COALESCE(sum("final_amount_minor"), 0), count(*)
    INTO line_subtotal, line_discount, line_final, line_count
    FROM "commerce_order_lines" WHERE "order_id" = target_order_id;
  IF line_count = 0 OR line_subtotal <> order_row."subtotal_amount_minor"
     OR line_discount <> order_row."discount_amount_minor"
     OR line_final <> order_row."payable_amount_minor" THEN
    RAISE EXCEPTION 'order totals do not equal immutable line snapshots' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'commerce_order_lines' THEN
    SELECT COALESCE(sum("allocated_discount_amount_minor"), 0) INTO benefit_discount
      FROM "commerce_order_line_benefits" WHERE "order_line_id" = NEW."id";
    IF benefit_discount <> NEW."discount_amount_minor" THEN
      RAISE EXCEPTION 'line benefit allocations do not equal line discount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_orders_validate_totals"
  AFTER INSERT OR UPDATE ON "commerce_orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_order_totals"();
CREATE CONSTRAINT TRIGGER "commerce_order_lines_validate_totals"
  AFTER INSERT ON "commerce_order_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_order_totals"();

CREATE FUNCTION "commerce_validate_benefit_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected bigint;
  actual bigint;
BEGIN
  SELECT "discount_amount_minor" INTO expected FROM "commerce_order_lines" WHERE "id" = NEW."order_line_id";
  SELECT COALESCE(sum("allocated_discount_amount_minor"), 0) INTO actual
    FROM "commerce_order_line_benefits" WHERE "order_line_id" = NEW."order_line_id";
  IF actual <> expected THEN
    RAISE EXCEPTION 'line benefit allocations do not equal line discount' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_order_line_benefits_validate_totals"
  AFTER INSERT ON "commerce_order_line_benefits"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_benefit_totals"();

CREATE FUNCTION "commerce_validate_refund_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_refund_id uuid;
  expected bigint;
  actual bigint;
BEGIN
  IF TG_TABLE_NAME = 'commerce_refunds' THEN
    target_refund_id := NEW."id";
  ELSE
    target_refund_id := NEW."refund_id";
  END IF;
  SELECT "amount_minor" INTO expected FROM "commerce_refunds" WHERE "id" = target_refund_id;
  SELECT COALESCE(sum("amount_minor"), 0) INTO actual
    FROM "commerce_refund_allocations" WHERE "refund_id" = target_refund_id;
  IF expected IS NOT NULL AND actual <> expected THEN
    RAISE EXCEPTION 'refund allocations do not equal requested amount' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_refunds_validate_totals"
  AFTER INSERT OR UPDATE ON "commerce_refunds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_refund_totals"();
CREATE CONSTRAINT TRIGGER "commerce_refund_allocations_validate_totals"
  AFTER INSERT ON "commerce_refund_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_refund_totals"();

CREATE FUNCTION "commerce_validate_recorded_refund_bounds"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_total bigint;
  recorded_total bigint;
  allocation_row record;
  line_total bigint;
  line_refunded bigint;
BEGIN
  IF NEW."status" <> 'recorded' THEN RETURN NULL; END IF;
  SELECT "amount_minor" INTO settlement_total FROM "commerce_settlements"
    WHERE "id" = NEW."settlement_id" FOR UPDATE;
  SELECT COALESCE(sum("amount_minor"), 0) INTO recorded_total FROM "commerce_refunds"
    WHERE "settlement_id" = NEW."settlement_id" AND "status" = 'recorded';
  IF recorded_total > settlement_total THEN
    RAISE EXCEPTION 'recorded refunds exceed settled amount' USING ERRCODE = '23514';
  END IF;
  FOR allocation_row IN
    SELECT "order_line_id" FROM "commerce_refund_allocations" WHERE "refund_id" = NEW."id"
  LOOP
    SELECT "final_amount_minor" INTO line_total FROM "commerce_order_lines"
      WHERE "id" = allocation_row."order_line_id";
    SELECT COALESCE(sum(a."amount_minor"), 0) INTO line_refunded
      FROM "commerce_refund_allocations" a
      JOIN "commerce_refunds" r ON r."id" = a."refund_id"
      WHERE a."order_line_id" = allocation_row."order_line_id" AND r."status" = 'recorded';
    IF line_refunded > line_total THEN
      RAISE EXCEPTION 'recorded refunds exceed order line settled total' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_refunds_validate_recorded_bounds"
  AFTER INSERT OR UPDATE ON "commerce_refunds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_recorded_refund_bounds"();

CREATE FUNCTION "commerce_validate_paid_attempt_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('paid', 'late_paid') AND NOT EXISTS (
    SELECT 1
      FROM "commerce_payment_events" event
      JOIN "commerce_settlements" settlement ON settlement."payment_event_id" = event."id"
      WHERE event."payment_attempt_id" = NEW."id"
        AND settlement."payment_attempt_id" = NEW."id"
        AND event."next_status" = NEW."status"
  ) THEN
    RAISE EXCEPTION 'paid payment attempt requires immutable event and settlement evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_payment_attempts_validate_paid_evidence"
  AFTER INSERT OR UPDATE ON "commerce_payment_attempts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_paid_attempt_evidence"();

CREATE FUNCTION "commerce_validate_reconciliation_resolution"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'resolved' THEN RETURN NULL; END IF;
  IF NEW."resolution" = 'refund' AND NOT EXISTS (
    SELECT 1 FROM "commerce_refunds"
      WHERE "reconciliation_case_id" = NEW."id" AND "status" = 'recorded'
  ) THEN
    RAISE EXCEPTION 'refund resolution requires its recorded external refund' USING ERRCODE = '23514';
  END IF;
  IF NEW."resolution" = 'accept' AND NOT EXISTS (
    SELECT 1 FROM "commerce_orders"
      WHERE "id" = NEW."order_id" AND "status" = 'confirmed'
        AND "confirmed_settlement_id" = NEW."settlement_id"
  ) THEN
    RAISE EXCEPTION 'accept resolution requires the late settlement to confirm its order' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_reconciliation_cases_validate_resolution"
  AFTER INSERT OR UPDATE ON "commerce_reconciliation_cases"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_reconciliation_resolution"();

CREATE FUNCTION "commerce_validate_lifecycle_event"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entity_exists boolean;
  current_operation_id uuid;
  current_status text;
BEGIN
  CASE NEW."entity_type"
    WHEN 'order' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_orders" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "status_operation_id", "status"::text INTO current_operation_id, current_status
        FROM "commerce_orders" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_order_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_order_status"; END IF;
    WHEN 'fulfillment' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_orders" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "fulfillment_operation_id", "fulfillment_status"::text INTO current_operation_id, current_status
        FROM "commerce_orders" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_fulfillment_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_fulfillment_status"; END IF;
    WHEN 'payment' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_payment_attempts" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "status_operation_id", "status"::text INTO current_operation_id, current_status
        FROM "commerce_payment_attempts" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_payment_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_payment_status"; END IF;
    WHEN 'reservation' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_promotion_reservations" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "status_operation_id", "status"::text INTO current_operation_id, current_status
        FROM "commerce_promotion_reservations" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_reservation_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_reservation_status"; END IF;
    WHEN 'reconciliation' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_reconciliation_cases" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "status_operation_id", "status"::text INTO current_operation_id, current_status
        FROM "commerce_reconciliation_cases" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_reconciliation_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_reconciliation_status"; END IF;
    WHEN 'refund' THEN
      SELECT EXISTS (SELECT 1 FROM "commerce_refunds" WHERE "id" = NEW."entity_id") INTO entity_exists;
      SELECT "status_operation_id", "status"::text INTO current_operation_id, current_status
        FROM "commerce_refunds" WHERE "id" = NEW."entity_id";
      PERFORM NEW."next_status"::"commerce_refund_status";
      IF NEW."previous_status" IS NOT NULL THEN PERFORM NEW."previous_status"::"commerce_refund_status"; END IF;
  END CASE;
  IF NOT entity_exists THEN
    RAISE EXCEPTION 'lifecycle event must identify an existing entity' USING ERRCODE = '23514';
  END IF;
  IF current_operation_id IS DISTINCT FROM NEW."operation_id" OR current_status IS DISTINCT FROM NEW."next_status" THEN
    RAISE EXCEPTION 'lifecycle event must bind the entity current transition operation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_lifecycle_events_validate_entity"
  AFTER INSERT ON "commerce_lifecycle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_validate_lifecycle_event"();

CREATE FUNCTION "commerce_require_order_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT EXISTS (
    SELECT 1 FROM "commerce_lifecycle_events"
      WHERE "entity_type" = 'order' AND "entity_id" = NEW."id"
        AND "previous_status" = OLD."status"::text AND "next_status" = NEW."status"::text
        AND "operation_id" = NEW."status_operation_id"
  ) THEN
    RAISE EXCEPTION 'order transition requires append-only lifecycle evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW."fulfillment_status" IS DISTINCT FROM OLD."fulfillment_status" AND NOT EXISTS (
    SELECT 1 FROM "commerce_lifecycle_events"
      WHERE "entity_type" = 'fulfillment' AND "entity_id" = NEW."id"
        AND "previous_status" = OLD."fulfillment_status"::text
        AND "next_status" = NEW."fulfillment_status"::text
        AND "operation_id" = NEW."fulfillment_operation_id"
  ) THEN
    RAISE EXCEPTION 'fulfillment transition requires append-only lifecycle evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'confirmed' AND EXISTS (
    SELECT 1
      FROM "commerce_order_line_benefits" benefit
      JOIN "commerce_order_lines" line ON line."id" = benefit."order_line_id"
      WHERE line."order_id" = NEW."id" AND NOT EXISTS (
        SELECT 1 FROM "commerce_promotion_reservations" reservation
          WHERE reservation."order_line_id" = benefit."order_line_id"
            AND reservation."benefit_type" = benefit."benefit_type"
            AND COALESCE(reservation."voucher_id", reservation."scholarship_award_id") = benefit."source_id"
            AND reservation."status" = 'consumed'
      )
  ) THEN
    RAISE EXCEPTION 'confirmed order requires every monetary benefit reservation consumed' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_orders_require_lifecycle"
  AFTER UPDATE ON "commerce_orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_require_order_lifecycle"();

CREATE FUNCTION "commerce_require_status_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  event_type "commerce_lifecycle_entity_type";
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN RETURN NULL; END IF;
  event_type := CASE TG_TABLE_NAME
    WHEN 'commerce_payment_attempts' THEN 'payment'::"commerce_lifecycle_entity_type"
    WHEN 'commerce_promotion_reservations' THEN 'reservation'::"commerce_lifecycle_entity_type"
    WHEN 'commerce_reconciliation_cases' THEN 'reconciliation'::"commerce_lifecycle_entity_type"
    WHEN 'commerce_refunds' THEN 'refund'::"commerce_lifecycle_entity_type"
  END;
  IF NOT EXISTS (
    SELECT 1 FROM "commerce_lifecycle_events"
      WHERE "entity_type" = event_type AND "entity_id" = NEW."id"
        AND "previous_status" = OLD."status"::text AND "next_status" = NEW."status"::text
        AND "operation_id" = NEW."status_operation_id"
  ) THEN
    RAISE EXCEPTION '% transition requires append-only lifecycle evidence', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commerce_payment_attempts_require_lifecycle"
  AFTER UPDATE ON "commerce_payment_attempts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_require_status_lifecycle"();
CREATE CONSTRAINT TRIGGER "commerce_reservations_require_lifecycle"
  AFTER UPDATE ON "commerce_promotion_reservations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_require_status_lifecycle"();
CREATE CONSTRAINT TRIGGER "commerce_reconciliation_cases_require_lifecycle"
  AFTER UPDATE ON "commerce_reconciliation_cases"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_require_status_lifecycle"();
CREATE CONSTRAINT TRIGGER "commerce_refunds_require_lifecycle"
  AFTER UPDATE ON "commerce_refunds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "commerce_require_status_lifecycle"();
