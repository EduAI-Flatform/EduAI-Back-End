-- PAYW-04E isolated-UAT source migration ONLY. Never apply to production
-- while PAYW financial/legal/release gates are still open.
-- A signed webhook is a durable hint, not proof of settled funds. The worker
-- separately queries PayOS before entering the verified journal transaction.
CREATE TABLE "gds_internal_payos_inbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "topup_id" UUID NOT NULL,
  "provider_event_identity" VARCHAR(160) NOT NULL,
  "payos_order_code" BIGINT NOT NULL,
  "payment_link_id" VARCHAR(128) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "receiving_account" VARCHAR(32) NOT NULL,
  "receiving_account_hash" VARCHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "signature_verified_at" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "review_reason" VARCHAR(128),
  "processed_at" TIMESTAMP(3),
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gds_internal_payos_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gds_internal_payos_inbox_topup_fkey" FOREIGN KEY ("topup_id")
    REFERENCES "gds_internal_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gds_internal_payos_inbox_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "gds_internal_payos_inbox_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "gds_internal_payos_inbox_hash_check" CHECK ("receiving_account_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "gds_internal_payos_inbox_account_check" CHECK ("receiving_account" ~ '^[0-9]{6,32}$'),
  CONSTRAINT "gds_internal_payos_inbox_status_check" CHECK ("status" IN ('RECEIVED','PROCESSED','REVIEW')),
  CONSTRAINT "gds_internal_payos_inbox_attempt_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "gds_internal_payos_inbox_terminal_check" CHECK (
    ("status" = 'PROCESSED' AND "processed_at" IS NOT NULL AND "review_reason" IS NULL) OR
    ("status" = 'REVIEW' AND "review_reason" IS NOT NULL AND "processed_at" IS NULL) OR
    ("status" = 'RECEIVED' AND "processed_at" IS NULL AND "review_reason" IS NULL)
  )
);
CREATE UNIQUE INDEX "gds_internal_payos_inbox_provider_event_identity_key"
  ON "gds_internal_payos_inbox"("provider_event_identity");
CREATE INDEX "gds_internal_payos_inbox_status_next_attempt_at_idx"
  ON "gds_internal_payos_inbox"("status", "next_attempt_at");
CREATE INDEX "gds_internal_payos_inbox_topup_id_received_at_idx"
  ON "gds_internal_payos_inbox"("topup_id", "received_at");

CREATE FUNCTION gds_internal_payos_inbox_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GDS PayOS inbox cannot be deleted'; END IF;
  IF NEW."topup_id" IS DISTINCT FROM OLD."topup_id" OR
     NEW."provider_event_identity" IS DISTINCT FROM OLD."provider_event_identity" OR
     NEW."payos_order_code" IS DISTINCT FROM OLD."payos_order_code" OR
     NEW."payment_link_id" IS DISTINCT FROM OLD."payment_link_id" OR
     NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."receiving_account" IS DISTINCT FROM OLD."receiving_account" OR
     NEW."receiving_account_hash" IS DISTINCT FROM OLD."receiving_account_hash" OR
     NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" OR
     NEW."signature_verified_at" IS DISTINCT FROM OLD."signature_verified_at" OR
     NEW."received_at" IS DISTINCT FROM OLD."received_at" OR
     OLD."status" <> 'RECEIVED' OR
     NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION 'GDS PayOS inbox signed facts/terminal status are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_payos_inbox_immutable
  BEFORE UPDATE OR DELETE ON "gds_internal_payos_inbox"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_payos_inbox_guard();
