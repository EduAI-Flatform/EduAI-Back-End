BEGIN;

-- Preserve the signed QR identity; settlement evidence is separate and append-only.
-- Historical no-inbox journal records keep null settlement bindings.
ALTER TABLE "gds_internal_topups" ADD COLUMN "settlement_receiving_account_hash" VARCHAR(64);
ALTER TABLE "gds_internal_topups" ADD CONSTRAINT "gds_internal_topups_settlement_hash_check"
  CHECK ("settlement_receiving_account_hash" IS NULL OR "settlement_receiving_account_hash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "gds_internal_payos_inbox" ALTER COLUMN "receiving_account" TYPE VARCHAR(128);
ALTER TABLE "gds_internal_payos_inbox" ADD COLUMN "virtual_receiving_account_hash" VARCHAR(64);
ALTER TABLE "gds_internal_payos_inbox" ADD CONSTRAINT "gds_internal_payos_inbox_virtual_hash_check"
  CHECK ("virtual_receiving_account_hash" IS NULL OR "virtual_receiving_account_hash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "gds_internal_payos_inbox" DROP CONSTRAINT "gds_internal_payos_inbox_account_check";
ALTER TABLE "gds_internal_payos_inbox" ADD CONSTRAINT "gds_internal_payos_inbox_account_check"
  CHECK ("receiving_account" ~ '^[A-Za-z0-9_-]{1,128}$');

CREATE TABLE "gds_internal_payos_reconciliations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "topup_id" UUID NOT NULL UNIQUE REFERENCES "gds_internal_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "inbox_id" UUID NOT NULL UNIQUE REFERENCES "gds_internal_payos_inbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "provider_event_identity" VARCHAR(160) NOT NULL UNIQUE,
  "payos_order_code" BIGINT NOT NULL,
  "payment_link_id" VARCHAR(128) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "qr_receiving_account_hash" VARCHAR(64) NOT NULL,
  "settlement_receiving_account_hash" VARCHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "signature_verified_at" TIMESTAMP(3) NOT NULL,
  "provider_reconciled_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gds_internal_payos_reconciliations_hash_check" CHECK (
    "qr_receiving_account_hash" ~ '^[a-f0-9]{64}$' AND "qr_receiving_account_hash" <> repeat('0',64) AND
    "settlement_receiving_account_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "gds_internal_payos_reconciliations_amount_check" CHECK ("amount_minor" > 0 AND "amount_minor" <= 9007199254740991),
  CONSTRAINT "gds_internal_payos_reconciliations_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "gds_internal_payos_reconciliations_time_check" CHECK ("provider_reconciled_at" >= "signature_verified_at")
);

CREATE FUNCTION gds_internal_payos_reconciliation_guard() RETURNS TRIGGER AS $$
DECLARE source_topup RECORD; source_inbox RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'GDS PayOS reconciliation proof is immutable'; END IF;
  SELECT * INTO source_topup FROM "gds_internal_topups" WHERE "id"=NEW."topup_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GDS PayOS reconciliation topup missing'; END IF;
  SELECT * INTO source_inbox FROM "gds_internal_payos_inbox" WHERE "id"=NEW."inbox_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GDS PayOS reconciliation inbox missing'; END IF;
  IF source_topup."status" NOT IN ('PENDING_PAYOS','PAYOS_VERIFIED') OR
     NOT (source_inbox."status"='RECEIVED' OR (source_inbox."status"='REVIEW' AND
       source_inbox."review_reason"='SIGNED_IDENTITY_OR_TERMINAL_CONFLICT')) OR
     source_inbox."topup_id" IS DISTINCT FROM NEW."topup_id" OR
     source_inbox."provider_event_identity" IS DISTINCT FROM NEW."provider_event_identity" OR
     source_inbox."payos_order_code" IS DISTINCT FROM NEW."payos_order_code" OR
     source_topup."payos_order_code" IS DISTINCT FROM NEW."payos_order_code" OR
     source_inbox."payment_link_id" IS DISTINCT FROM NEW."payment_link_id" OR
     source_topup."payment_link_id" IS DISTINCT FROM NEW."payment_link_id" OR
     source_inbox."amount_minor" IS DISTINCT FROM NEW."amount_minor" OR
     source_topup."amount_minor" IS DISTINCT FROM NEW."amount_minor" OR
     source_inbox."currency" IS DISTINCT FROM NEW."currency" OR
     source_topup."currency" IS DISTINCT FROM NEW."currency" OR
     source_topup."receiving_account_hash" IS DISTINCT FROM NEW."qr_receiving_account_hash" OR
     source_inbox."receiving_account_hash" IS DISTINCT FROM NEW."settlement_receiving_account_hash" OR
     (source_inbox."virtual_receiving_account_hash" IS NOT NULL AND
       source_inbox."virtual_receiving_account_hash" IS DISTINCT FROM NEW."qr_receiving_account_hash") OR
     source_inbox."occurred_at" IS DISTINCT FROM NEW."occurred_at" OR
     source_inbox."signature_verified_at" IS DISTINCT FROM NEW."signature_verified_at" OR
     NEW."occurred_at" < source_topup."created_at" OR NEW."occurred_at" > source_topup."expires_at" OR
     (source_topup."collection_reference" IS NOT NULL AND
       source_topup."collection_reference" IS DISTINCT FROM NEW."provider_event_identity") THEN
    RAISE EXCEPTION 'GDS PayOS reconciliation signed identity mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_payos_reconciliation_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON "gds_internal_payos_reconciliations" FOR EACH ROW EXECUTE FUNCTION gds_internal_payos_reconciliation_guard();

CREATE FUNCTION gds_internal_payos_inbox_virtual_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."virtual_receiving_account_hash" IS DISTINCT FROM OLD."virtual_receiving_account_hash" THEN
    RAISE EXCEPTION 'GDS PayOS inbox signed virtual account is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_payos_inbox_virtual_immutable BEFORE UPDATE ON "gds_internal_payos_inbox"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_payos_inbox_virtual_guard();

-- Supplement, rather than replace, original QR-binding and state-transition guards.
CREATE FUNCTION gds_internal_topup_settlement_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."settlement_receiving_account_hash" IS NOT NULL THEN
      RAISE EXCEPTION 'GDS settlement binding requires reconciliation proof transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'GDS topup creation time is immutable';
  END IF;
  IF OLD."settlement_receiving_account_hash" IS NOT NULL AND
     NEW."settlement_receiving_account_hash" IS DISTINCT FROM OLD."settlement_receiving_account_hash" THEN
    RAISE EXCEPTION 'GDS settlement account is immutable';
  END IF;
  IF OLD."settlement_receiving_account_hash" IS NULL AND NEW."settlement_receiving_account_hash" IS NOT NULL AND
     NOT (OLD."status"='PENDING_PAYOS' AND NEW."status"='PAYOS_VERIFIED') THEN
    RAISE EXCEPTION 'GDS settlement binding requires reconciliation proof transition';
  END IF;
  IF NEW."settlement_receiving_account_hash" IS NOT NULL OR
     (NEW."status" IN ('PAYOS_VERIFIED','CREDITED') AND EXISTS (
       SELECT 1 FROM "gds_internal_payos_inbox" WHERE "topup_id"=NEW."id")) THEN
    IF NOT EXISTS (SELECT 1 FROM "gds_internal_payos_reconciliations" p WHERE
      p."topup_id"=NEW."id" AND p."payos_order_code"=NEW."payos_order_code" AND
      p."payment_link_id"=NEW."payment_link_id" AND p."amount_minor"=NEW."amount_minor" AND
      p."currency"=NEW."currency" AND p."qr_receiving_account_hash"=NEW."receiving_account_hash" AND
      p."settlement_receiving_account_hash"=NEW."settlement_receiving_account_hash" AND
      p."provider_event_identity"=NEW."collection_reference" AND
      p."signature_verified_at"=NEW."signature_verified_at" AND p."provider_reconciled_at"=NEW."provider_reconciled_at") THEN
      RAISE EXCEPTION 'GDS settlement requires matching reconciliation proof';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_topup_settlement_binding BEFORE INSERT OR UPDATE ON "gds_internal_topups"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_topup_settlement_guard();

COMMIT;
