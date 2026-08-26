ALTER TABLE "commerce_payment_attempts"
  ADD COLUMN "provider_order_code" BIGINT,
  ADD COLUMN "provider_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "provider_request_started_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "commerce_payment_attempts_provider_order_code_key"
  ON "commerce_payment_attempts"("provider", "provider_order_code")
  WHERE "provider_order_code" IS NOT NULL;

ALTER TABLE "commerce_payment_attempts"
  ADD CONSTRAINT "commerce_payment_attempts_provider_request_check" CHECK (
    ("provider" <> 'payos')
    OR (
      "provider_order_code" IS NOT NULL
      AND "provider_order_code" > 0
      AND "provider_expires_at" IS NOT NULL
      AND "provider_expires_at" > "created_at"
      AND "provider_request_started_at" IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION "commerce_guard_payment_attempt_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."provider", NEW."local_request_identity", NEW."provider_order_code",
         NEW."provider_expires_at", NEW."provider_request_started_at", NEW."amount_minor",
         NEW."currency", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."order_id", OLD."provider", OLD."local_request_identity", OLD."provider_order_code",
         OLD."provider_expires_at", OLD."provider_request_started_at", OLD."amount_minor",
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
