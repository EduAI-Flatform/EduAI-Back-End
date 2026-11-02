-- Source-only PAYW-04C. Do NOT apply until the financial and UAT release gates pass.
-- Commerce must never accept an invented wallet settlement as paid. In the
-- wallet branch, the exact buyer wallet, RESERVED -> CAPTURED hold and durable
-- CAPTURE posting must already exist in this same database transaction.
CREATE OR REPLACE FUNCTION "commerce_guard_order_update"() RETURNS trigger
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
          OR (
            settlement."kind" = 'wallet_capture'
            AND settlement."disposition" = 'internal'
            AND settlement."provider" = 'gds'
            AND settlement."provider_settlement_reference" = 'gds:order:' || NEW."id"::text
            AND NEW."payable_amount_minor" > 0
            AND NOT EXISTS (
              SELECT 1 FROM "commerce_payment_attempts" competing
               WHERE competing."order_id" = NEW."id"
            )
            AND EXISTS (
              SELECT 1 FROM "gds_internal_holds" hold
              INNER JOIN "gds_internal_wallets" wallet ON wallet."id" = hold."wallet_id"
              INNER JOIN "gds_internal_journal" journal ON journal."wallet_id" = wallet."id"
               AND journal."order_ref" = NEW."id"::text
              WHERE hold."order_ref" = NEW."id"::text
                AND wallet."buyer_id" = NEW."buyer_id"
                AND hold."amount_minor" = NEW."payable_amount_minor"
                AND hold."status" = 'CAPTURED'
                AND journal."kind" = 'CAPTURE'
                AND journal."event_key" = 'gds:capture:' || NEW."id"::text
                AND journal."amount_minor" = NEW."payable_amount_minor"
            )
          )
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
