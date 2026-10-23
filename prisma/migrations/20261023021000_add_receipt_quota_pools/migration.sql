-- Additive receipt quota lineage. Historical grants/usage and financial guards stay intact.
CREATE TABLE "service_entitlement_quota_pools" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_line_id" UUID NOT NULL REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "definition_id" UUID NOT NULL REFERENCES "service_entitlement_definitions"("id") ON DELETE RESTRICT,
  "value_type" "service_entitlement_value_type" NOT NULL,
  "reset_period" "service_entitlement_reset_period" NOT NULL,
  "boolean_value" BOOLEAN,
  "quota" BIGINT,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_entitlement_quota_pools_line_definition_key" UNIQUE ("order_line_id", "definition_id"),
  CONSTRAINT "service_entitlement_quota_pools_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "service_entitlement_quota_pools_value_check" CHECK (
    ("value_type" = 'boolean' AND "reset_period" = 'none' AND "boolean_value" IS NOT NULL AND "quota" IS NULL)
    OR ("value_type" = 'metered' AND "boolean_value" IS NULL AND "quota" IS NOT NULL AND "quota" > 0)
    OR ("value_type" = 'unlimited' AND "reset_period" = 'none' AND "boolean_value" IS NULL AND "quota" IS NULL)
  )
);

ALTER TABLE "service_entitlement_grants" ADD COLUMN "quota_pool_id" UUID
  REFERENCES "service_entitlement_quota_pools"("id") ON DELETE RESTRICT;
CREATE INDEX "service_entitlement_grants_quota_pool_id_idx" ON "service_entitlement_grants"("quota_pool_id");

CREATE FUNCTION "receipt_quota_pool_validate_snapshot"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "commerce_order_lines" line
    JOIN "commerce_orders" orders ON orders."id" = line."order_id"
    JOIN "membership_checkout_intents" intent ON intent."order_id" = orders."id"
    JOIN "membership_plan_entitlements" entitlement ON entitlement."version_id" = intent."version_id"
    WHERE line."id" = NEW."order_line_id" AND line."product_type" = 'membership'
      AND line."product_reference_id" = intent."version_id"
      AND orders."buyer_id" = NEW."user_id" AND entitlement."definition_id" = NEW."definition_id"
      AND entitlement."value_type" = NEW."value_type" AND entitlement."reset_period" = NEW."reset_period"
      AND entitlement."boolean_value" IS NOT DISTINCT FROM NEW."boolean_value"
      AND entitlement."quota" IS NOT DISTINCT FROM NEW."quota"
      AND intent."starts_at" = NEW."starts_at" AND intent."ends_at" IS NOT DISTINCT FROM NEW."ends_at"
  ) THEN
    RAISE EXCEPTION 'receipt quota pool must match its immutable membership order snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "receipt_quota_pool_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receipt quota pool snapshot is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "receipt_quota_pool_validate" BEFORE INSERT ON "service_entitlement_quota_pools"
  FOR EACH ROW EXECUTE FUNCTION "receipt_quota_pool_validate_snapshot"();
CREATE TRIGGER "receipt_quota_pool_immutable" BEFORE UPDATE OR DELETE ON "service_entitlement_quota_pools"
  FOR EACH ROW EXECUTE FUNCTION "receipt_quota_pool_reject_change"();

CREATE FUNCTION "receipt_quota_grant_validate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pool "service_entitlement_quota_pools"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."quota_pool_id" IS DISTINCT FROM NEW."quota_pool_id" THEN
    RAISE EXCEPTION 'receipt quota pool assignment is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."quota_pool_id" IS NULL THEN
    IF NEW."source_type" = 'UNVERIFIED_RECEIPT_ACCESS' OR (
      NEW."source_type" = 'membership' AND EXISTS (
        SELECT 1 FROM "service_entitlement_quota_pools" p
        WHERE p."order_line_id"::text = NEW."source_id" AND p."definition_id" = NEW."definition_id"
      )
    ) THEN
      RAISE EXCEPTION 'receipt-derived service grants must retain their quota pool' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO pool FROM "service_entitlement_quota_pools" WHERE "id" = NEW."quota_pool_id" FOR KEY SHARE;
  IF pool."id" IS NULL
    OR ROW(NEW."user_id", NEW."definition_id", NEW."value_type", NEW."reset_period", NEW."boolean_value", NEW."quota", NEW."starts_at", NEW."ends_at")
      IS DISTINCT FROM ROW(pool."user_id", pool."definition_id", pool."value_type", pool."reset_period", pool."boolean_value", pool."quota", pool."starts_at", pool."ends_at")
    OR NOT ((NEW."source_type" = 'membership' AND NEW."source_id" = pool."order_line_id"::text)
      OR (NEW."source_type" = 'UNVERIFIED_RECEIPT_ACCESS' AND NEW."source_id" ~ ('^[0-9a-fA-F-]{36}:' || pool."order_line_id"::text || '$')))
  THEN
    RAISE EXCEPTION 'receipt service grant must match its quota pool snapshot and order line' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "receipt_quota_grant_validate" BEFORE INSERT OR UPDATE ON "service_entitlement_grants"
  FOR EACH ROW EXECUTE FUNCTION "receipt_quota_grant_validate"();

-- Preserve the previous grant/ownership/window/typed-value guards, adding only pool serialization and aggregation.
CREATE OR REPLACE FUNCTION "service_entitlement_validate_usage"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owning_user uuid;
  grant_start timestamp(3);
  grant_end timestamp(3);
  grant_type "service_entitlement_value_type";
  grant_reset "service_entitlement_reset_period";
  grant_boolean boolean;
  grant_quota bigint;
  grant_status "service_entitlement_grant_status";
  quota_pool uuid;
  expected_start timestamp(3);
  expected_end timestamp(3);
  already_used bigint;
BEGIN
  SELECT "user_id", "starts_at", "ends_at", "value_type", "reset_period", "boolean_value", "quota", "status", "quota_pool_id"
    INTO owning_user, grant_start, grant_end, grant_type, grant_reset, grant_boolean, grant_quota, grant_status, quota_pool
    FROM "service_entitlement_grants" WHERE "id" = NEW."grant_id" FOR UPDATE;
  IF quota_pool IS NOT NULL THEN
    PERFORM "id" FROM "service_entitlement_quota_pools" WHERE "id" = quota_pool FOR UPDATE;
  END IF;
  IF grant_reset = 'calendar_month' THEN
    expected_start := GREATEST(grant_start, date_trunc('month', NEW."created_at"));
    expected_end := LEAST(COALESCE(grant_end, 'infinity'::timestamp), date_trunc('month', NEW."created_at") + INTERVAL '1 month');
  ELSE
    expected_start := grant_start;
    expected_end := grant_end;
  END IF;
  IF owning_user IS DISTINCT FROM NEW."user_id"
    OR grant_status IS DISTINCT FROM 'active'
    OR NEW."created_at" < grant_start
    OR (grant_end IS NOT NULL AND NEW."created_at" >= grant_end)
    OR NEW."period_starts_at" IS DISTINCT FROM expected_start
    OR NEW."period_ends_at" IS DISTINCT FROM expected_end
  THEN
    RAISE EXCEPTION 'service entitlement usage must match its owning grant' USING ERRCODE = '23514';
  END IF;
  IF grant_type = 'boolean' AND grant_boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'disabled service entitlement cannot be consumed' USING ERRCODE = '23514';
  END IF;
  IF grant_type = 'metered' THEN
    SELECT COALESCE(SUM(usage."quantity"), 0) INTO already_used
      FROM "service_entitlement_usage" usage
      JOIN "service_entitlement_grants" source ON source."id" = usage."grant_id"
      WHERE ((quota_pool IS NULL AND usage."grant_id" = NEW."grant_id")
          OR (quota_pool IS NOT NULL AND source."quota_pool_id" = quota_pool))
        AND usage."period_starts_at" = NEW."period_starts_at"
        AND usage."period_ends_at" IS NOT DISTINCT FROM NEW."period_ends_at";
    IF already_used + NEW."quantity" > grant_quota THEN
      RAISE EXCEPTION 'service entitlement quota exhausted' USING ERRCODE = '23514';
    END IF;
    IF NEW."remaining_after" IS DISTINCT FROM grant_quota - already_used - NEW."quantity" THEN
      RAISE EXCEPTION 'service entitlement remaining snapshot is inconsistent' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."remaining_after" IS NOT NULL THEN
    RAISE EXCEPTION 'unmetered service entitlement cannot store a remaining quota' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
