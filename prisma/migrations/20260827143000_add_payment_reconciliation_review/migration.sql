ALTER TYPE "commerce_reconciliation_kind" ADD VALUE IF NOT EXISTS 'provider_outage';
ALTER TYPE "commerce_reconciliation_kind" ADD VALUE IF NOT EXISTS 'provider_fact_mismatch';
ALTER TYPE "commerce_reconciliation_kind" ADD VALUE IF NOT EXISTS 'unknown_provider_status';
ALTER TYPE "commerce_reconciliation_kind" ADD VALUE IF NOT EXISTS 'paid_not_fulfilled';

ALTER TYPE "commerce_reconciliation_resolution" ADD VALUE IF NOT EXISTS 'retry_succeeded';
ALTER TYPE "commerce_reconciliation_resolution" ADD VALUE IF NOT EXISTS 'acknowledged';

ALTER TABLE "commerce_reconciliation_cases"
  ALTER COLUMN "settlement_id" DROP NOT NULL,
  ADD COLUMN "payment_attempt_id" UUID,
  ADD COLUMN "reason_code" VARCHAR(80),
  ADD COLUMN "source_key" VARCHAR(160),
  ADD COLUMN "last_checked_at" TIMESTAMP(3),
  ADD COLUMN "check_count" INTEGER NOT NULL DEFAULT 1;

UPDATE "commerce_reconciliation_cases" review
SET "payment_attempt_id" = settlement."payment_attempt_id",
    "reason_code" = CASE review."kind"::text
      WHEN 'duplicate_collection' THEN 'DUPLICATE_COLLECTION'
      ELSE 'LATE_PAYMENT'
    END
FROM "commerce_settlements" settlement
WHERE settlement."id" = review."settlement_id";

ALTER TABLE "commerce_reconciliation_cases"
  ALTER COLUMN "reason_code" SET NOT NULL,
  ADD CONSTRAINT "commerce_reconciliation_check_count_check" CHECK ("check_count" > 0),
  ADD CONSTRAINT "commerce_reconciliation_source_check" CHECK (
    ("kind" IN ('duplicate_collection', 'late_payment') AND "settlement_id" IS NOT NULL)
    OR ("kind" NOT IN ('duplicate_collection', 'late_payment') AND "payment_attempt_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "commerce_reconciliation_cases_payment_attempt_id_fkey"
    FOREIGN KEY ("payment_attempt_id") REFERENCES "commerce_payment_attempts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "commerce_reconciliation_cases_payment_attempt_id_status_idx"
  ON "commerce_reconciliation_cases"("payment_attempt_id", "status");
CREATE UNIQUE INDEX "commerce_reconciliation_cases_source_key_key"
  ON "commerce_reconciliation_cases"("source_key");

CREATE INDEX "commerce_payment_attempts_reconciliation_scan_idx"
  ON "commerce_payment_attempts"("status", "provider_status_checked_at", "id");

CREATE OR REPLACE FUNCTION "commerce_guard_reconciliation_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."settlement_id", NEW."payment_attempt_id", NEW."kind",
         NEW."reason_code", NEW."source_key", NEW."opened_at")
     IS DISTINCT FROM
     ROW(OLD."order_id", OLD."settlement_id", OLD."payment_attempt_id", OLD."kind",
         OLD."reason_code", OLD."source_key", OLD."opened_at") THEN
    RAISE EXCEPTION 'reconciliation source facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."check_count" < OLD."check_count"
     OR (NEW."last_checked_at" IS NOT NULL AND OLD."last_checked_at" IS NOT NULL
         AND NEW."last_checked_at" < OLD."last_checked_at") THEN
    RAISE EXCEPTION 'reconciliation observation evidence is monotonic' USING ERRCODE = '23514';
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

CREATE OR REPLACE FUNCTION "commerce_validate_reconciliation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_order uuid;
  settlement_attempt uuid;
  settlement_disposition "commerce_settlement_disposition";
  attempt_order uuid;
BEGIN
  IF NEW."settlement_id" IS NOT NULL THEN
    SELECT "order_id", "payment_attempt_id", "disposition"
      INTO settlement_order, settlement_attempt, settlement_disposition
      FROM "commerce_settlements" WHERE "id" = NEW."settlement_id";
    IF settlement_order IS DISTINCT FROM NEW."order_id"
       OR (NEW."payment_attempt_id" IS NOT NULL AND settlement_attempt IS DISTINCT FROM NEW."payment_attempt_id")
       OR (NEW."kind" = 'duplicate_collection' AND settlement_disposition <> 'duplicate_collection')
       OR (NEW."kind" = 'late_payment' AND settlement_disposition <> 'late_collection') THEN
      RAISE EXCEPTION 'reconciliation case does not match settlement disposition' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "order_id" INTO attempt_order
      FROM "commerce_payment_attempts" WHERE "id" = NEW."payment_attempt_id";
    IF attempt_order IS DISTINCT FROM NEW."order_id" THEN
      RAISE EXCEPTION 'reconciliation case does not match payment attempt' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_validate_reconciliation_resolution"() RETURNS trigger
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
  IF NEW."resolution" = 'retry_succeeded' AND NOT EXISTS (
    SELECT 1 FROM "commerce_orders"
      WHERE "id" = NEW."order_id" AND "status" = 'confirmed' AND "fulfillment_status" = 'fulfilled'
  ) THEN
    RAISE EXCEPTION 'retry resolution requires fulfilled order evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW."resolution" = 'acknowledged'
     AND NEW."kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled') THEN
    RAISE EXCEPTION 'financial collection review cannot be acknowledged away' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
