-- Admit internal GDS capture through the canonical settlement source validator.
-- Provider collection and zero-payable validation are preserved verbatim.
BEGIN;
CREATE OR REPLACE FUNCTION "commerce_validate_settlement"() RETURNS trigger
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
  ELSIF NEW."kind" = 'wallet_capture' THEN
    -- Lock the authoritative order before consuming its immutable capture proof.
    PERFORM 1 FROM "commerce_orders" WHERE "id" = NEW."order_id" FOR UPDATE;
    SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = NEW."order_id";
    IF NOT FOUND OR order_row."status" <> 'pending_payment'
       OR order_row."confirmed_settlement_id" IS NOT NULL
       OR NEW."amount_minor" IS DISTINCT FROM order_row."payable_amount_minor"
       OR NEW."currency" IS DISTINCT FROM order_row."currency"
       OR NEW."amount_minor" <= 0 OR NEW."currency" <> 'VND'
       OR NEW."disposition" <> 'internal' OR NEW."provider" IS DISTINCT FROM 'gds'
       OR NEW."payment_attempt_id" IS NOT NULL OR NEW."payment_event_id" IS NOT NULL
       OR NEW."provider_settlement_reference" IS DISTINCT FROM 'gds:order:' || NEW."order_id"::text
       OR EXISTS (SELECT 1 FROM "commerce_payment_attempts" WHERE "order_id" = NEW."order_id")
       OR EXISTS (SELECT 1 FROM "commerce_settlements" WHERE "order_id" = NEW."order_id")
       OR NOT EXISTS (
         SELECT 1 FROM "gds_internal_holds" hold
         JOIN "gds_internal_wallets" wallet ON wallet."id" = hold."wallet_id"
         JOIN "gds_internal_journal" journal ON journal."wallet_id" = wallet."id"
           AND journal."order_ref" = NEW."order_id"::text
         WHERE hold."order_ref" = NEW."order_id"::text
           AND wallet."buyer_id" = order_row."buyer_id" AND wallet."status" = 'ACTIVE'
           AND hold."status" = 'CAPTURED' AND hold."amount_minor" = NEW."amount_minor"
           AND journal."kind" = 'CAPTURE' AND journal."event_key" = 'gds:capture:' || NEW."order_id"::text
           AND journal."amount_minor" = NEW."amount_minor"
           AND journal."available_delta_minor" = 0 AND journal."held_delta_minor" = -NEW."amount_minor"
           AND journal."clearing_delta_minor" = NEW."amount_minor"
           AND journal."topup_id" IS NULL AND journal."collection_reference" IS NULL
       ) THEN
      RAISE EXCEPTION 'wallet settlement requires exact captured GDS proof and unpaid order' USING ERRCODE = '23514';
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
COMMIT;
