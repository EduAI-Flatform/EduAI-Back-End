CREATE TYPE "service_entitlement_value_type" AS ENUM ('boolean', 'metered', 'unlimited');
CREATE TYPE "service_entitlement_reset_period" AS ENUM ('none', 'calendar_month', 'membership_term');
CREATE TYPE "service_entitlement_grant_status" AS ENUM ('active', 'revoked');

CREATE TABLE "service_entitlement_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(64) NOT NULL,
  "value_type" "service_entitlement_value_type" NOT NULL,
  "reset_period" "service_entitlement_reset_period" NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "unit_label" VARCHAR(40),
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_entitlement_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "service_entitlement_definitions_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "service_entitlement_definitions_display_check" CHECK (length(btrim("display_name")) > 0 AND "display_order" >= 0),
  CONSTRAINT "service_entitlement_definitions_reset_check" CHECK (
    "value_type" = 'metered' OR "reset_period" = 'none'
  )
);

CREATE TABLE "membership_plan_entitlements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version_id" UUID NOT NULL,
  "definition_id" UUID NOT NULL,
  "value_type" "service_entitlement_value_type" NOT NULL,
  "reset_period" "service_entitlement_reset_period" NOT NULL,
  "boolean_value" BOOLEAN,
  "quota" BIGINT,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_plan_entitlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_plan_entitlements_value_check" CHECK (
    ("value_type" = 'boolean' AND "reset_period" = 'none' AND "boolean_value" IS NOT NULL AND "quota" IS NULL)
    OR ("value_type" = 'metered' AND "boolean_value" IS NULL AND "quota" > 0)
    OR ("value_type" = 'unlimited' AND "reset_period" = 'none' AND "boolean_value" IS NULL AND "quota" IS NULL)
  )
);

CREATE TABLE "service_entitlement_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "definition_id" UUID NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "value_type" "service_entitlement_value_type" NOT NULL,
  "reset_period" "service_entitlement_reset_period" NOT NULL,
  "boolean_value" BOOLEAN,
  "quota" BIGINT,
  "status" "service_entitlement_grant_status" NOT NULL DEFAULT 'active',
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_entitlement_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "service_entitlement_grants_value_check" CHECK (
    ("value_type" = 'boolean' AND "reset_period" = 'none' AND "boolean_value" IS NOT NULL AND "quota" IS NULL)
    OR ("value_type" = 'metered' AND "boolean_value" IS NULL AND "quota" > 0)
    OR ("value_type" = 'unlimited' AND "reset_period" = 'none' AND "boolean_value" IS NULL AND "quota" IS NULL)
  ),
  CONSTRAINT "service_entitlement_grants_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "service_entitlement_grants_status_check" CHECK (
    ("status" = 'active' AND "revoked_at" IS NULL)
    OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
  )
);

CREATE TABLE "service_entitlement_usage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "grant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "operation_key_hash" CHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "quantity" BIGINT NOT NULL,
  "remaining_after" BIGINT,
  "period_starts_at" TIMESTAMP(3) NOT NULL,
  "period_ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_entitlement_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "service_entitlement_usage_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "service_entitlement_usage_remaining_check" CHECK ("remaining_after" IS NULL OR "remaining_after" >= 0),
  CONSTRAINT "service_entitlement_usage_period_check" CHECK ("period_ends_at" IS NULL OR "period_ends_at" > "period_starts_at")
);

CREATE UNIQUE INDEX "service_entitlement_definitions_code_key" ON "service_entitlement_definitions"("code");
CREATE INDEX "service_entitlement_definitions_display_order_code_idx" ON "service_entitlement_definitions"("display_order", "code");
CREATE UNIQUE INDEX "membership_plan_entitlements_version_id_definition_id_key" ON "membership_plan_entitlements"("version_id", "definition_id");
CREATE INDEX "membership_plan_entitlements_definition_id_version_id_idx" ON "membership_plan_entitlements"("definition_id", "version_id");
CREATE UNIQUE INDEX "service_entitlement_grants_source_key" ON "service_entitlement_grants"("user_id", "definition_id", "source_type", "source_id");
CREATE INDEX "service_entitlement_grants_user_id_status_starts_at_ends_at_idx" ON "service_entitlement_grants"("user_id", "status", "starts_at", "ends_at");
CREATE INDEX "service_entitlement_grants_definition_id_status_idx" ON "service_entitlement_grants"("definition_id", "status");
CREATE UNIQUE INDEX "service_entitlement_usage_user_id_operation_key_hash_key" ON "service_entitlement_usage"("user_id", "operation_key_hash");
CREATE INDEX "service_entitlement_usage_grant_id_period_starts_at_period_ends_at_idx" ON "service_entitlement_usage"("grant_id", "period_starts_at", "period_ends_at");
CREATE INDEX "service_entitlement_usage_user_id_created_at_idx" ON "service_entitlement_usage"("user_id", "created_at");

ALTER TABLE "service_entitlement_definitions" ADD CONSTRAINT "service_entitlement_definitions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_entitlements" ADD CONSTRAINT "membership_plan_entitlements_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_entitlements" ADD CONSTRAINT "membership_plan_entitlements_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "service_entitlement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_entitlements" ADD CONSTRAINT "membership_plan_entitlements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_entitlement_grants" ADD CONSTRAINT "service_entitlement_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_entitlement_grants" ADD CONSTRAINT "service_entitlement_grants_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "service_entitlement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_entitlement_usage" ADD CONSTRAINT "service_entitlement_usage_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "service_entitlement_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_entitlement_usage" ADD CONSTRAINT "service_entitlement_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "service_entitlement_reject_definition_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service entitlement definitions are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION "membership_guard_plan_entitlement_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_version_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."version_id" ELSE NEW."version_id" END;
  source_status "membership_plan_version_status";
  declared_type "service_entitlement_value_type";
  declared_reset "service_entitlement_reset_period";
BEGIN
  SELECT "status" INTO source_status FROM "membership_plan_versions" WHERE "id" = source_version_id FOR KEY SHARE;
  IF source_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'published membership entitlements are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."version_id" IS DISTINCT FROM NEW."version_id" OR OLD."definition_id" IS DISTINCT FROM NEW."definition_id") THEN
    RAISE EXCEPTION 'membership entitlement identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "value_type", "reset_period" INTO declared_type, declared_reset
      FROM "service_entitlement_definitions" WHERE "id" = NEW."definition_id" FOR KEY SHARE;
    IF declared_type IS DISTINCT FROM NEW."value_type" OR declared_reset IS DISTINCT FROM NEW."reset_period" THEN
      RAISE EXCEPTION 'membership entitlement semantics must match its stable definition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION "service_entitlement_guard_grant_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW."user_id", NEW."definition_id", NEW."source_type", NEW."source_id", NEW."value_type", NEW."reset_period", NEW."boolean_value", NEW."quota", NEW."starts_at", NEW."ends_at", NEW."created_at")
    IS DISTINCT FROM ROW(OLD."user_id", OLD."definition_id", OLD."source_type", OLD."source_id", OLD."value_type", OLD."reset_period", OLD."boolean_value", OLD."quota", OLD."starts_at", OLD."ends_at", OLD."created_at")
  THEN
    RAISE EXCEPTION 'service entitlement grant facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'revoked' OR (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'revoked')) THEN
    RAISE EXCEPTION 'invalid service entitlement grant transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "service_entitlement_validate_grant_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  declared_type "service_entitlement_value_type";
  declared_reset "service_entitlement_reset_period";
BEGIN
  SELECT "value_type", "reset_period" INTO declared_type, declared_reset
    FROM "service_entitlement_definitions" WHERE "id" = NEW."definition_id" FOR KEY SHARE;
  IF declared_type IS DISTINCT FROM NEW."value_type" OR declared_reset IS DISTINCT FROM NEW."reset_period" THEN
    RAISE EXCEPTION 'service entitlement grant semantics must match its stable definition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "service_entitlement_validate_usage"() RETURNS trigger
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
  expected_start timestamp(3);
  expected_end timestamp(3);
  already_used bigint;
BEGIN
  SELECT "user_id", "starts_at", "ends_at", "value_type", "reset_period", "boolean_value", "quota", "status"
    INTO owning_user, grant_start, grant_end, grant_type, grant_reset, grant_boolean, grant_quota, grant_status
    FROM "service_entitlement_grants" WHERE "id" = NEW."grant_id" FOR UPDATE;
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
    SELECT COALESCE(SUM("quantity"), 0) INTO already_used
      FROM "service_entitlement_usage"
      WHERE "grant_id" = NEW."grant_id"
        AND "period_starts_at" = NEW."period_starts_at"
        AND "period_ends_at" IS NOT DISTINCT FROM NEW."period_ends_at";
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

CREATE FUNCTION "service_entitlement_reject_usage_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service entitlement usage is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "service_entitlement_definitions_immutable" BEFORE UPDATE OR DELETE ON "service_entitlement_definitions" FOR EACH ROW EXECUTE FUNCTION "service_entitlement_reject_definition_change"();
CREATE TRIGGER "membership_plan_entitlements_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "membership_plan_entitlements" FOR EACH ROW EXECUTE FUNCTION "membership_guard_plan_entitlement_change"();
CREATE TRIGGER "service_entitlement_grants_validate" BEFORE INSERT ON "service_entitlement_grants" FOR EACH ROW EXECUTE FUNCTION "service_entitlement_validate_grant_insert"();
CREATE TRIGGER "service_entitlement_grants_immutable" BEFORE UPDATE OR DELETE ON "service_entitlement_grants" FOR EACH ROW EXECUTE FUNCTION "service_entitlement_guard_grant_change"();
CREATE TRIGGER "service_entitlement_usage_validate" BEFORE INSERT ON "service_entitlement_usage" FOR EACH ROW EXECUTE FUNCTION "service_entitlement_validate_usage"();
CREATE TRIGGER "service_entitlement_usage_append_only" BEFORE UPDATE OR DELETE ON "service_entitlement_usage" FOR EACH ROW EXECUTE FUNCTION "service_entitlement_reject_usage_change"();
