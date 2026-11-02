-- PAYW-04 sandbox contract. A PayOS collection is NOT itself wallet credit.
-- Source-only migration: do not apply to production without explicit approval.
CREATE TABLE "buyer_wallet_payos_topups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "buyer_id" UUID NOT NULL,
  "wallet_link_id" UUID,
  "request_key_hash" VARCHAR(64) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
  "payos_order_code" BIGINT NOT NULL,
  "payos_payment_link_id" VARCHAR(128),
  "receiving_account_hash" VARCHAR(64) NOT NULL,
  "collection_reference" VARCHAR(128),
  "partner_credit_event_id" VARCHAR(160),
  "status" VARCHAR(24) NOT NULL DEFAULT 'CREATED',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "payos_verified_at" TIMESTAMP(3),
  "credited_at" TIMESTAMP(3),
  CONSTRAINT "buyer_wallet_payos_topups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_wallet_payos_topups_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "buyer_wallet_payos_topups_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "buyer_wallet_payos_topups_payos_order_code_check" CHECK ("payos_order_code" > 0 AND "payos_order_code" <= 9007199254740991),
  CONSTRAINT "buyer_wallet_payos_topups_account_hash_check" CHECK ("receiving_account_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "buyer_wallet_payos_topups_status_check" CHECK ("status" IN ('CREATED', 'PENDING_PAYOS', 'PAYOS_VERIFIED', 'PENDING_PARTNER', 'CREDITED', 'CANCELLED', 'REVIEW')),
  CONSTRAINT "buyer_wallet_payos_topups_link_check" CHECK ("status" NOT IN ('PENDING_PAYOS', 'PAYOS_VERIFIED', 'PENDING_PARTNER', 'CREDITED') OR "payos_payment_link_id" IS NOT NULL),
  CONSTRAINT "buyer_wallet_payos_topups_collection_check" CHECK ("status" NOT IN ('PAYOS_VERIFIED', 'PENDING_PARTNER', 'CREDITED') OR "collection_reference" IS NOT NULL),
  CONSTRAINT "buyer_wallet_payos_topups_verified_time_check" CHECK ("status" NOT IN ('PAYOS_VERIFIED', 'PENDING_PARTNER', 'CREDITED') OR "payos_verified_at" IS NOT NULL),
  CONSTRAINT "buyer_wallet_payos_topups_credit_check" CHECK (
    ("status" = 'CREDITED' AND "partner_credit_event_id" IS NOT NULL AND "credited_at" IS NOT NULL)
    OR ("status" <> 'CREDITED' AND "partner_credit_event_id" IS NULL AND "credited_at" IS NULL)
  )
);
CREATE UNIQUE INDEX "buyer_wallet_payos_topups_buyer_id_request_key_hash_key"
  ON "buyer_wallet_payos_topups"("buyer_id", "request_key_hash");
CREATE UNIQUE INDEX "buyer_wallet_payos_topups_payos_order_code_key"
  ON "buyer_wallet_payos_topups"("payos_order_code");
CREATE UNIQUE INDEX "buyer_wallet_payos_topups_payos_payment_link_id_key"
  ON "buyer_wallet_payos_topups"("payos_payment_link_id");
CREATE UNIQUE INDEX "buyer_wallet_payos_topups_collection_reference_key"
  ON "buyer_wallet_payos_topups"("collection_reference");
CREATE UNIQUE INDEX "buyer_wallet_payos_topups_partner_credit_event_id_key"
  ON "buyer_wallet_payos_topups"("partner_credit_event_id");
CREATE INDEX "buyer_wallet_payos_topups_buyer_id_created_at_idx" ON "buyer_wallet_payos_topups"("buyer_id", "created_at");
CREATE INDEX "buyer_wallet_payos_topups_status_created_at_idx" ON "buyer_wallet_payos_topups"("status", "created_at");
ALTER TABLE "buyer_wallet_payos_topups"
  ADD CONSTRAINT "buyer_wallet_payos_topups_buyer_id_fkey"
  FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "buyer_wallet_payos_topups"
  ADD CONSTRAINT "buyer_wallet_payos_topups_wallet_link_id_fkey"
  FOREIGN KEY ("wallet_link_id") REFERENCES "buyer_wallet_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutable merchant order/money facts and strictly forward transitions.
CREATE FUNCTION buyer_wallet_topup_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet topup audit is append-only';
  END IF;
  IF NEW."buyer_id" IS DISTINCT FROM OLD."buyer_id" OR
     NEW."wallet_link_id" IS DISTINCT FROM OLD."wallet_link_id" OR
     NEW."request_key_hash" IS DISTINCT FROM OLD."request_key_hash" OR
     NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."payos_order_code" IS DISTINCT FROM OLD."payos_order_code" OR
     NEW."receiving_account_hash" IS DISTINCT FROM OLD."receiving_account_hash" OR
     NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR
     (OLD."payos_payment_link_id" IS NOT NULL AND NEW."payos_payment_link_id" IS DISTINCT FROM OLD."payos_payment_link_id") OR
     (OLD."collection_reference" IS NOT NULL AND NEW."collection_reference" IS DISTINCT FROM OLD."collection_reference") OR
     (OLD."partner_credit_event_id" IS NOT NULL AND NEW."partner_credit_event_id" IS DISTINCT FROM OLD."partner_credit_event_id") THEN
    RAISE EXCEPTION 'wallet topup immutable identity cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'CREATED' AND NEW."status" IN ('PENDING_PAYOS', 'CANCELLED')) OR
    (OLD."status" = 'PENDING_PAYOS' AND NEW."status" IN ('PAYOS_VERIFIED', 'CANCELLED', 'REVIEW')) OR
    (OLD."status" = 'PAYOS_VERIFIED' AND NEW."status" IN ('PENDING_PARTNER', 'CREDITED', 'REVIEW')) OR
    (OLD."status" = 'PENDING_PARTNER' AND NEW."status" IN ('CREDITED', 'REVIEW')) OR
    (OLD."status" = 'CANCELLED' AND NEW."status" = 'REVIEW')
  ) THEN
    RAISE EXCEPTION 'wallet topup status cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER buyer_wallet_payos_topup_transition_guard
  BEFORE UPDATE OR DELETE ON "buyer_wallet_payos_topups"
  FOR EACH ROW EXECUTE FUNCTION buyer_wallet_topup_guard();
