-- SPR25-007: make reconciliation source identity complete before production UAT.
-- This migration updates reconciliation metadata only. It never deletes financial data.
-- Existing acknowledged financial cases are preserved as explicit legacy history;
-- the marker never asserts canonical payment or fulfillment proof.
-- Only NULL source_key values are derived. Existing non-NULL source_key values,
-- including legacy reason-specific provider-fact-mismatch identities, are never
-- transformed.

-- Fail closed if the observed production shape cannot be transformed safely.
DO $$
DECLARE
  missing_attempts bigint;
  missing_settlements bigint;
  duplicate_keys bigint;
  existing_collisions bigint;
  oversized_keys bigint;
  acknowledged_financial_cases bigint;
  unproven_legacy_cases bigint;
BEGIN
  SELECT COUNT(*)
    INTO missing_attempts
    FROM "commerce_reconciliation_cases"
   WHERE "source_key" IS NULL
     AND "payment_attempt_id" IS NULL;

  IF missing_attempts > 0 THEN
    RAISE EXCEPTION 'reconciliation source-key backfill has % rows without payment-attempt identity', missing_attempts
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
    INTO missing_settlements
    FROM "commerce_reconciliation_cases"
   WHERE "source_key" IS NULL
     AND "kind" IN ('duplicate_collection', 'late_payment')
     AND "settlement_id" IS NULL;

  IF missing_settlements > 0 THEN
    RAISE EXCEPTION 'settlement-backed reconciliation source-key backfill has % rows without settlement identity', missing_settlements
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
    INTO acknowledged_financial_cases
    FROM "commerce_reconciliation_cases"
   WHERE "status" = 'resolved'
     AND "resolution" = 'acknowledged'
     AND "kind" IN (
       'duplicate_collection',
       'late_payment',
       'provider_outage',
       'provider_fact_mismatch',
       'unknown_provider_status',
       'paid_not_fulfilled'
     );

  SELECT COUNT(*)
    INTO unproven_legacy_cases
    FROM "commerce_reconciliation_cases" review
   WHERE review."status" = 'resolved'
     AND review."resolution" = 'acknowledged'
     AND review."kind" IN (
       'duplicate_collection',
       'late_payment',
       'provider_outage',
       'provider_fact_mismatch',
       'unknown_provider_status',
       'paid_not_fulfilled'
     )
     AND (
       review."resolved_at" IS NULL
       OR review."resolved_by_id" IS NULL
       OR review."status_operation_id" IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM "commerce_lifecycle_events" lifecycle
          WHERE lifecycle."entity_type" = 'reconciliation'::"commerce_lifecycle_entity_type"
            AND lifecycle."entity_id" = review."id"
            AND lifecycle."operation_id" = review."status_operation_id"
            AND lifecycle."previous_status" = 'open'
            AND lifecycle."next_status" = 'resolved'
            AND lifecycle."actor_kind" = 'user'::"commerce_actor_kind"
            AND lifecycle."actor_id" = review."resolved_by_id"
            AND lifecycle."reason_code" = 'OPERATOR_ACKNOWLEDGED'
       )
     );

  IF unproven_legacy_cases > 0 THEN
    RAISE EXCEPTION 'existing acknowledged financial reconciliation cases lack immutable legacy provenance: %', unproven_legacy_cases
      USING ERRCODE = '23514';
  END IF;

  WITH deterministic_source_keys AS (
    SELECT
      "id",
      concat_ws(
        ':',
        "payment_attempt_id"::text,
        "kind"::text,
        CASE
          WHEN "kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
            THEN "settlement_id"::text
        END
      ) AS source_key
    FROM "commerce_reconciliation_cases"
    WHERE "source_key" IS NULL
  )
  SELECT COUNT(*)
    INTO duplicate_keys
    FROM (
      SELECT source_key
      FROM deterministic_source_keys
      GROUP BY source_key
      HAVING COUNT(*) > 1
    ) collisions;

  IF duplicate_keys > 0 THEN
    RAISE EXCEPTION 'duplicate reconciliation source keys detected: %', duplicate_keys
      USING ERRCODE = '23505';
  END IF;

  WITH deterministic_source_keys AS (
    SELECT
      "id",
      concat_ws(
        ':',
        "payment_attempt_id"::text,
        "kind"::text,
        CASE
          WHEN "kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
            THEN "settlement_id"::text
        END
      ) AS source_key
    FROM "commerce_reconciliation_cases"
    WHERE "source_key" IS NULL
  )
  SELECT COUNT(*)
    INTO existing_collisions
    FROM deterministic_source_keys candidate
    INNER JOIN "commerce_reconciliation_cases" existing
      ON existing."source_key" = candidate.source_key
     AND existing."id" <> candidate."id";

  IF existing_collisions > 0 THEN
    RAISE EXCEPTION 'existing reconciliation source-key collision detected: %', existing_collisions
      USING ERRCODE = '23505';
  END IF;

  WITH deterministic_source_keys AS (
    SELECT
      concat_ws(
        ':',
        "payment_attempt_id"::text,
        "kind"::text,
        CASE
          WHEN "kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
            THEN "settlement_id"::text
        END
      ) AS source_key
    FROM "commerce_reconciliation_cases"
    WHERE "source_key" IS NULL
  )
  SELECT COUNT(*)
    INTO oversized_keys
    FROM deterministic_source_keys
   WHERE length(source_key) > 160;

  IF oversized_keys > 0 THEN
    RAISE EXCEPTION 'reconciliation source-key backfill has % oversized keys', oversized_keys
      USING ERRCODE = '22001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS "commerce_reconciliation_legacy_acknowledgements" (
  "reconciliation_case_id" UUID NOT NULL,
  "historical_status" VARCHAR(40) NOT NULL,
  "historical_resolution" VARCHAR(40) NOT NULL,
  "historical_reason_code" VARCHAR(80) NOT NULL,
  "preservation_reason" VARCHAR(120) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "migration_version" VARCHAR(64) NOT NULL,
  CONSTRAINT "commerce_reconciliation_legacy_acknowledgements_pkey"
    PRIMARY KEY ("reconciliation_case_id"),
  CONSTRAINT "commerce_reconciliation_legacy_acknowledgements_case_fkey"
    FOREIGN KEY ("reconciliation_case_id")
    REFERENCES "commerce_reconciliation_cases"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "commerce_reconciliation_legacy_acknowledgements_state_check"
    CHECK ("historical_status" = 'resolved' AND "historical_resolution" = 'acknowledged')
);

CREATE OR REPLACE FUNCTION "commerce_guard_reconciliation_legacy_acknowledgement"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy reconciliation acknowledgement evidence is immutable' USING ERRCODE = '23514';
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'commerce_reconciliation_legacy_acknowledgements_immutable'
       AND tgrelid = 'commerce_reconciliation_legacy_acknowledgements'::regclass
  ) THEN
    CREATE TRIGGER "commerce_reconciliation_legacy_acknowledgements_immutable"
      BEFORE UPDATE OR DELETE
      ON "commerce_reconciliation_legacy_acknowledgements"
      FOR EACH ROW
      EXECUTE FUNCTION "commerce_guard_reconciliation_legacy_acknowledgement"();
  END IF;
END;
$$;

INSERT INTO "commerce_reconciliation_legacy_acknowledgements" (
  "reconciliation_case_id",
  "historical_status",
  "historical_resolution",
  "historical_reason_code",
  "preservation_reason",
  "migration_version"
)
SELECT
  review."id",
  review."status"::text,
  review."resolution"::text,
  review."reason_code",
  'PRE_HARDENING_ACKNOWLEDGEMENT_NO_CANONICAL_RESOLUTION',
  '20260916123000_harden_reconciliation_source_identity'
FROM "commerce_reconciliation_cases" review
WHERE review."status" = 'resolved'
  AND review."resolution" = 'acknowledged'
  AND review."kind" IN (
    'duplicate_collection',
    'late_payment',
    'provider_outage',
    'provider_fact_mismatch',
    'unknown_provider_status',
    'paid_not_fulfilled'
  )
ON CONFLICT ("reconciliation_case_id") DO NOTHING;

DO $$
DECLARE
  unmarked_legacy_cases bigint;
  mismatched_legacy_markers bigint;
BEGIN
  SELECT COUNT(*)
    INTO unmarked_legacy_cases
    FROM "commerce_reconciliation_cases" review
   WHERE review."status" = 'resolved'
     AND review."resolution" = 'acknowledged'
     AND review."kind" IN (
       'duplicate_collection',
       'late_payment',
       'provider_outage',
       'provider_fact_mismatch',
       'unknown_provider_status',
       'paid_not_fulfilled'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM "commerce_reconciliation_legacy_acknowledgements" marker
        WHERE marker."reconciliation_case_id" = review."id"
     );

  IF unmarked_legacy_cases > 0 THEN
    RAISE EXCEPTION 'acknowledged financial reconciliation cases were not preserved as legacy history: %', unmarked_legacy_cases
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
    INTO mismatched_legacy_markers
    FROM "commerce_reconciliation_legacy_acknowledgements" marker
    INNER JOIN "commerce_reconciliation_cases" review
      ON review."id" = marker."reconciliation_case_id"
   WHERE marker."historical_status" IS DISTINCT FROM review."status"::text
      OR marker."historical_resolution" IS DISTINCT FROM review."resolution"::text
      OR marker."historical_reason_code" IS DISTINCT FROM review."reason_code";

  IF mismatched_legacy_markers > 0 THEN
    RAISE EXCEPTION 'legacy reconciliation provenance does not match immutable case history: %', mismatched_legacy_markers
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The existing update guard remains active. It permits only this one-way,
-- deterministic null-to-derived-key backfill; all later source facts remain immutable.
CREATE OR REPLACE FUNCTION "commerce_guard_reconciliation_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."order_id", NEW."settlement_id", NEW."payment_attempt_id", NEW."kind",
         NEW."reason_code", NEW."opened_at")
     IS DISTINCT FROM
     ROW(OLD."order_id", OLD."settlement_id", OLD."payment_attempt_id", OLD."kind",
         OLD."reason_code", OLD."opened_at") THEN
    RAISE EXCEPTION 'reconciliation source facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."source_key" IS NULL
     AND NEW."source_key" IS NOT NULL
     AND NEW."source_key" IS DISTINCT FROM concat_ws(
       ':',
       NEW."payment_attempt_id"::text,
       NEW."kind"::text,
       CASE
         WHEN NEW."kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
           THEN NEW."settlement_id"::text
       END
     ) THEN
    RAISE EXCEPTION 'reconciliation source key backfill is not deterministic' USING ERRCODE = '23514';
  END IF;
  IF OLD."source_key" IS NOT NULL
     AND NEW."source_key" IS DISTINCT FROM OLD."source_key" THEN
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

WITH deterministic_source_keys AS (
  SELECT
    "id",
    concat_ws(
      ':',
      "payment_attempt_id"::text,
      "kind"::text,
      CASE
        WHEN "kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
          THEN "settlement_id"::text
      END
    ) AS source_key
  FROM "commerce_reconciliation_cases"
  WHERE "source_key" IS NULL
)
UPDATE "commerce_reconciliation_cases" review
   SET "source_key" = deterministic_source_keys.source_key
  FROM deterministic_source_keys
 WHERE review."id" = deterministic_source_keys."id";

ALTER TABLE "commerce_reconciliation_cases"
  ALTER COLUMN "source_key" SET NOT NULL;

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
     AND NEW."kind" IN (
       'duplicate_collection',
       'late_payment',
       'provider_outage',
       'provider_fact_mismatch',
       'unknown_provider_status',
       'paid_not_fulfilled'
     ) THEN
    IF TG_OP = 'UPDATE'
       AND OLD."status" = 'resolved'
       AND OLD."resolution" = 'acknowledged'
       AND EXISTS (
         SELECT 1
           FROM "commerce_reconciliation_legacy_acknowledgements" marker
          WHERE marker."reconciliation_case_id" = NEW."id"
       ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'financial reconciliation case cannot be acknowledged without canonical resolution' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
