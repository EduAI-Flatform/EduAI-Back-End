-- PAYW-04I/B: SOURCE-ONLY closed-loop prepayment journal (separate from partner mirror).
-- Never apply to the live Neon database without owner + legal/finance + release approvals.
-- No API or trigger in this migration calls PayOS or confers course entitlements.

CREATE TABLE "gds_internal_wallets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "buyer_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "available_minor" BIGINT NOT NULL DEFAULT 0,
  "held_minor" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gds_internal_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gds_internal_wallets_status_check" CHECK ("status" IN ('ACTIVE','SUSPENDED')),
  CONSTRAINT "gds_internal_wallets_nonnegative_check" CHECK ("available_minor" >= 0 AND "held_minor" >= 0),
  CONSTRAINT "gds_internal_wallets_buyer_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "gds_internal_wallets_buyer_id_key" ON "gds_internal_wallets"("buyer_id");

CREATE TABLE "gds_internal_topups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "buyer_id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "request_key_hash" VARCHAR(64) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
  "payos_order_code" BIGINT NOT NULL,
  "transfer_memo" VARCHAR(9) NOT NULL,
  "receiving_account_hash" VARCHAR(64) NOT NULL,
  "payment_link_id" VARCHAR(128),
  "collection_reference" VARCHAR(160),
  "status" VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "signature_verified_at" TIMESTAMP(3),
  "provider_reconciled_at" TIMESTAMP(3),
  "credited_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gds_internal_topups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gds_internal_topups_amount_check" CHECK ("amount_minor" > 0 AND "amount_minor" <= 9007199254740991),
  CONSTRAINT "gds_internal_topups_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "gds_internal_topups_order_check" CHECK ("payos_order_code" > 0 AND "payos_order_code" <= 9007199254740991),
  CONSTRAINT "gds_internal_topups_memo_check" CHECK ("transfer_memo" ~ '^G[A-Z0-9]{8}$'),
  CONSTRAINT "gds_internal_topups_hash_check" CHECK ("receiving_account_hash" ~ '^[a-f0-9]{64}$' AND "request_key_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "gds_internal_topups_status_check" CHECK ("status" IN ('CREATED','PENDING_PAYOS','PAYOS_VERIFIED','CREDITED','CANCELLED','REVIEW')),
  CONSTRAINT "gds_internal_topups_link_check" CHECK ("status" NOT IN ('PENDING_PAYOS','PAYOS_VERIFIED','CREDITED') OR "payment_link_id" IS NOT NULL),
  CONSTRAINT "gds_internal_topups_verified_check" CHECK (
    "status" NOT IN ('PAYOS_VERIFIED','CREDITED') OR
    ("collection_reference" IS NOT NULL AND "signature_verified_at" IS NOT NULL AND
     "provider_reconciled_at" IS NOT NULL AND "provider_reconciled_at" >= "signature_verified_at")
  ),
  CONSTRAINT "gds_internal_topups_credit_check" CHECK (
    ("status" = 'CREDITED' AND "credited_at" IS NOT NULL) OR
    ("status" <> 'CREDITED' AND "credited_at" IS NULL)
  ),
  CONSTRAINT "gds_internal_topups_buyer_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gds_internal_topups_wallet_fkey" FOREIGN KEY ("wallet_id") REFERENCES "gds_internal_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "gds_internal_topups_payos_order_code_key" ON "gds_internal_topups"("payos_order_code");
CREATE UNIQUE INDEX "gds_internal_topups_payment_link_id_key" ON "gds_internal_topups"("payment_link_id");
CREATE UNIQUE INDEX "gds_internal_topups_collection_reference_key" ON "gds_internal_topups"("collection_reference");
CREATE UNIQUE INDEX "gds_internal_topups_buyer_id_request_key_hash_key" ON "gds_internal_topups"("buyer_id","request_key_hash");
CREATE INDEX "gds_internal_topups_buyer_id_created_at_idx" ON "gds_internal_topups"("buyer_id","created_at");
CREATE INDEX "gds_internal_topups_status_created_at_idx" ON "gds_internal_topups"("status","created_at");

CREATE TABLE "gds_internal_holds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_id" UUID NOT NULL,
  "order_ref" VARCHAR(160) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gds_internal_holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gds_internal_holds_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "gds_internal_holds_status_check" CHECK ("status" IN ('RESERVED','CAPTURED','RELEASED')),
  CONSTRAINT "gds_internal_holds_wallet_fkey" FOREIGN KEY ("wallet_id") REFERENCES "gds_internal_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "gds_internal_holds_order_ref_key" ON "gds_internal_holds"("order_ref");
CREATE INDEX "gds_internal_holds_wallet_id_status_idx" ON "gds_internal_holds"("wallet_id","status");

-- One record is two or three balanced postings; platform clearing is the
-- offset, NOT a seller payout or Commerce settlement. Refund posting is
-- deliberately unavailable until approved refund policy and 04C integration.
CREATE TABLE "gds_internal_journal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_id" UUID NOT NULL,
  "event_key" VARCHAR(160) NOT NULL,
  "kind" VARCHAR(24) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "available_delta_minor" BIGINT NOT NULL,
  "held_delta_minor" BIGINT NOT NULL,
  "clearing_delta_minor" BIGINT NOT NULL,
  "topup_id" UUID,
  "collection_reference" VARCHAR(160),
  "order_ref" VARCHAR(160),
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gds_internal_journal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gds_internal_journal_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "gds_internal_journal_balance_check" CHECK ("available_delta_minor" + "held_delta_minor" + "clearing_delta_minor" = 0),
  CONSTRAINT "gds_internal_journal_posting_check" CHECK (
    ("kind" = 'TOPUP_CREDIT' AND "available_delta_minor" = "amount_minor" AND "held_delta_minor" = 0 AND "clearing_delta_minor" = -"amount_minor" AND "topup_id" IS NOT NULL AND "collection_reference" IS NOT NULL AND "order_ref" IS NULL) OR
    ("kind" = 'RESERVE' AND "available_delta_minor" = -"amount_minor" AND "held_delta_minor" = "amount_minor" AND "clearing_delta_minor" = 0 AND "topup_id" IS NULL AND "collection_reference" IS NULL AND "order_ref" IS NOT NULL) OR
    ("kind" = 'CAPTURE' AND "available_delta_minor" = 0 AND "held_delta_minor" = -"amount_minor" AND "clearing_delta_minor" = "amount_minor" AND "topup_id" IS NULL AND "collection_reference" IS NULL AND "order_ref" IS NOT NULL) OR
    ("kind" = 'RELEASE' AND "available_delta_minor" = "amount_minor" AND "held_delta_minor" = -"amount_minor" AND "clearing_delta_minor" = 0 AND "topup_id" IS NULL AND "collection_reference" IS NULL AND "order_ref" IS NOT NULL)
  ),
  CONSTRAINT "gds_internal_journal_wallet_fkey" FOREIGN KEY ("wallet_id") REFERENCES "gds_internal_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gds_internal_journal_topup_fkey" FOREIGN KEY ("topup_id") REFERENCES "gds_internal_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "gds_internal_journal_event_key_key" ON "gds_internal_journal"("event_key");
CREATE UNIQUE INDEX "gds_internal_journal_topup_id_key" ON "gds_internal_journal"("topup_id");
CREATE UNIQUE INDEX "gds_internal_journal_collection_reference_key" ON "gds_internal_journal"("collection_reference");
CREATE INDEX "gds_internal_journal_wallet_id_occurred_at_idx" ON "gds_internal_journal"("wallet_id","occurred_at");
CREATE INDEX "gds_internal_journal_order_ref_kind_idx" ON "gds_internal_journal"("order_ref","kind");

-- Cached balances may change only as part of an inserting journal entry.
CREATE FUNCTION gds_internal_wallet_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GDS wallet cannot be deleted'; END IF;
  IF NEW."buyer_id" IS DISTINCT FROM OLD."buyer_id" OR
     ((NEW."available_minor" IS DISTINCT FROM OLD."available_minor" OR
       NEW."held_minor" IS DISTINCT FROM OLD."held_minor") AND pg_trigger_depth() < 2) THEN
    RAISE EXCEPTION 'GDS wallet balance is journal-controlled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_wallet_balance_guard BEFORE UPDATE OR DELETE ON "gds_internal_wallets"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_wallet_guard();

CREATE FUNCTION gds_internal_hold_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GDS hold cannot be deleted'; END IF;
  IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'GDS hold is journal-controlled'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_hold_mutation_guard BEFORE INSERT OR UPDATE OR DELETE ON "gds_internal_holds"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_hold_guard();

CREATE FUNCTION gds_internal_topup_owner_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "gds_internal_wallets" WHERE "id" = NEW."wallet_id" AND "buyer_id" = NEW."buyer_id") THEN
    RAISE EXCEPTION 'GDS topup buyer/wallet mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_topup_owner_check BEFORE INSERT ON "gds_internal_topups"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_topup_owner_guard();

CREATE FUNCTION gds_internal_topup_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GDS topup audit is append-only'; END IF;
  IF NEW."buyer_id" IS DISTINCT FROM OLD."buyer_id" OR
     NEW."wallet_id" IS DISTINCT FROM OLD."wallet_id" OR
     NEW."request_key_hash" IS DISTINCT FROM OLD."request_key_hash" OR
     NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."payos_order_code" IS DISTINCT FROM OLD."payos_order_code" OR
     NEW."transfer_memo" IS DISTINCT FROM OLD."transfer_memo" OR
     NEW."receiving_account_hash" IS DISTINCT FROM OLD."receiving_account_hash" OR
     NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR
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
CREATE TRIGGER gds_internal_topup_transition_guard BEFORE UPDATE OR DELETE ON "gds_internal_topups"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_topup_guard();

CREATE FUNCTION gds_internal_journal_no_mutation() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'GDS journal is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_journal_immutable BEFORE UPDATE OR DELETE ON "gds_internal_journal"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_journal_no_mutation();

-- An INSERT atomically validates its source, changes the hold state and
-- updates the wallet balance. PostgreSQL row updates serialize competing
-- journals; the nonnegative wallet CHECK fails an overspend and rolls back
-- the entire entry, including any hold or topup transition.
CREATE FUNCTION gds_internal_apply_journal() RETURNS TRIGGER AS $$
DECLARE source_topup RECORD;
BEGIN
  IF NEW."kind" = 'TOPUP_CREDIT' THEN
    SELECT * INTO source_topup FROM "gds_internal_topups" WHERE "id" = NEW."topup_id" FOR UPDATE;
    IF NOT FOUND OR source_topup."status" <> 'PAYOS_VERIFIED' OR
       source_topup."wallet_id" <> NEW."wallet_id" OR
       source_topup."amount_minor" <> NEW."amount_minor" OR
       source_topup."collection_reference" IS DISTINCT FROM NEW."collection_reference" OR
       source_topup."signature_verified_at" IS NULL OR
       source_topup."provider_reconciled_at" IS NULL OR
       source_topup."provider_reconciled_at" < source_topup."signature_verified_at" THEN
      RAISE EXCEPTION 'GDS topup is not signed and reconciled';
    END IF;
    UPDATE "gds_internal_topups" SET "status" = 'CREDITED', "credited_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."topup_id";
  ELSIF NEW."kind" = 'RESERVE' THEN
    INSERT INTO "gds_internal_holds"("wallet_id","order_ref","amount_minor","updated_at")
      VALUES (NEW."wallet_id",NEW."order_ref",NEW."amount_minor",CURRENT_TIMESTAMP);
  ELSE
    UPDATE "gds_internal_holds" SET "status" = CASE WHEN NEW."kind" = 'CAPTURE' THEN 'CAPTURED' ELSE 'RELEASED' END,
      "updated_at" = CURRENT_TIMESTAMP
      WHERE "wallet_id" = NEW."wallet_id" AND "order_ref" = NEW."order_ref" AND
        "amount_minor" = NEW."amount_minor" AND "status" = 'RESERVED';
    IF NOT FOUND THEN RAISE EXCEPTION 'GDS hold is missing, mismatched or terminal'; END IF;
  END IF;
  UPDATE "gds_internal_wallets"
    SET "available_minor" = "available_minor" + NEW."available_delta_minor",
        "held_minor" = "held_minor" + NEW."held_delta_minor",
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."wallet_id" AND "status" = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'GDS wallet is unavailable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gds_internal_journal_apply AFTER INSERT ON "gds_internal_journal"
  FOR EACH ROW EXECUTE FUNCTION gds_internal_apply_journal();
