-- PAYW-04 UAT: PayOS is authoritative for its beneficiary account.
-- An intent is first reserved with an all-zero, explicitly unbound SHA-256
-- placeholder; bind the real SHA-256 ONLY as the payment link is attached.
-- Legacy intents with an already bound hash retain their immutable identity.
-- No existing rows are changed by this migration.
CREATE OR REPLACE FUNCTION gds_internal_topup_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GDS topup audit is append-only'; END IF;

  IF NEW."buyer_id" IS DISTINCT FROM OLD."buyer_id" OR
     NEW."wallet_id" IS DISTINCT FROM OLD."wallet_id" OR
     NEW."request_key_hash" IS DISTINCT FROM OLD."request_key_hash" OR
     NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."payos_order_code" IS DISTINCT FROM OLD."payos_order_code" OR
     NEW."transfer_memo" IS DISTINCT FROM OLD."transfer_memo" OR
     NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR
     (NEW."receiving_account_hash" IS DISTINCT FROM OLD."receiving_account_hash" AND NOT (
       OLD."status" = 'CREATED' AND NEW."status" = 'PENDING_PAYOS' AND
       OLD."receiving_account_hash" = repeat('0', 64) AND
       NEW."receiving_account_hash" ~ '^[a-f0-9]{64}$' AND
       NEW."receiving_account_hash" <> repeat('0', 64) AND
       OLD."payment_link_id" IS NULL AND NEW."payment_link_id" IS NOT NULL
     )) OR
     (OLD."payment_link_id" IS NOT NULL AND NEW."payment_link_id" IS DISTINCT FROM OLD."payment_link_id") OR
     (OLD."collection_reference" IS NOT NULL AND NEW."collection_reference" IS DISTINCT FROM OLD."collection_reference") OR
     (OLD."signature_verified_at" IS NOT NULL AND NEW."signature_verified_at" IS DISTINCT FROM OLD."signature_verified_at") OR
     (OLD."provider_reconciled_at" IS NOT NULL AND NEW."provider_reconciled_at" IS DISTINCT FROM OLD."provider_reconciled_at") OR
     (OLD."credited_at" IS NOT NULL AND NEW."credited_at" IS DISTINCT FROM OLD."credited_at") THEN
    RAISE EXCEPTION 'GDS topup immutable identity cannot change';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'CREATED' AND NEW."status" IN ('PENDING_PAYOS','CANCELLED')) OR
    (OLD."status" = 'PENDING_PAYOS' AND NEW."status" IN ('PAYOS_VERIFIED','CANCELLED','REVIEW')) OR
    (OLD."status" = 'PAYOS_VERIFIED' AND NEW."status" IN ('CREDITED','REVIEW')) OR
    (OLD."status" = 'CANCELLED' AND NEW."status" = 'REVIEW')
  ) THEN RAISE EXCEPTION 'GDS topup status cannot move backwards'; END IF;
  IF NEW."status" = 'CREDITED' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'GDS credit must originate in verified journal trigger';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Pending/verified/credited records must always have a bound beneficiary;
-- no no-account QR can be marked paid or credited even by direct SQL.
ALTER TABLE "gds_internal_topups" ADD CONSTRAINT "gds_internal_topups_bound_link_check"
  CHECK ("status" NOT IN ('PENDING_PAYOS', 'PAYOS_VERIFIED', 'CREDITED') OR
    "receiving_account_hash" <> repeat('0', 64));
