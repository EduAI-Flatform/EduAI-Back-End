-- Additive card-service provenance. Existing purchases, grants, usage and balances are not rewritten.
ALTER TABLE "service_entitlement_grants"
  ADD COLUMN "card_policy_revision_id" UUID,
  ADD COLUMN "card_tier_code" TEXT,
  ADD COLUMN "card_source_digest" CHAR(64),
  ADD COLUMN "card_qualification" JSONB,
  ADD CONSTRAINT "membership_card_policy_fk" FOREIGN KEY ("card_policy_revision_id")
    REFERENCES "platform_policy_revisions"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "membership_card_grant_provenance_check" CHECK (
    ("source_type" = 'MEMBERSHIP_CARD'
      AND "card_policy_revision_id" IS NOT NULL AND "card_tier_code" IS NOT NULL
      AND "card_source_digest" IS NOT NULL AND "card_qualification" IS NOT NULL
      AND "card_tier_code" ~ '^[a-z][a-z0-9-]*$' AND length("card_tier_code") <= 2000
      AND "card_source_digest" ~ '^[0-9a-f]{64}$' AND "source_id" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("card_qualification") = 'object'
      AND "value_type" = 'metered' AND "quota_pool_id" IS NULL)
    OR ("source_type" <> 'MEMBERSHIP_CARD'
      AND "card_policy_revision_id" IS NULL AND "card_tier_code" IS NULL
      AND "card_source_digest" IS NULL AND "card_qualification" IS NULL)
  );
CREATE INDEX "service_entitlement_grants_card_policy_idx" ON "service_entitlement_grants"("card_policy_revision_id");
CREATE INDEX "membership_card_grant_scope_idx" ON "service_entitlement_grants"("user_id", "definition_id")
  WHERE "source_type" = 'MEMBERSHIP_CARD';
CREATE UNIQUE INDEX "membership_card_grant_context_key" ON "service_entitlement_grants"
  ("user_id", "definition_id", "card_policy_revision_id", "card_tier_code", "starts_at", COALESCE("ends_at", 'infinity'::timestamp))
  WHERE "source_type" = 'MEMBERSHIP_CARD';

CREATE FUNCTION "membership_card_grant_provenance_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."card_policy_revision_id", NEW."card_tier_code", NEW."card_source_digest", NEW."card_qualification")
    IS DISTINCT FROM ROW(OLD."card_policy_revision_id", OLD."card_tier_code", OLD."card_source_digest", OLD."card_qualification") THEN
    RAISE EXCEPTION 'membership card grant provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "membership_card_grant_provenance_immutable" BEFORE UPDATE ON "service_entitlement_grants"
  FOR EACH ROW EXECUTE FUNCTION "membership_card_grant_provenance_immutable"();

CREATE FUNCTION "membership_card_grant_validate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_group text; policy_status "platform_policy_status"; policy_content jsonb;
  policy_effective timestamp(3); policy_approved timestamp(3); policy_created timestamp(3); effective_id uuid;
  qualification_at timestamp(3); qualification_start timestamp(3); qualification_end timestamp(3); qualification_months integer;
  qualified_amount numeric; qualified_tier text;
  tier_content jsonb; rule_content jsonb; matches integer;
  expected_start timestamp(3); expected_end timestamp(3); anchor_at timestamp(3);
  term_months integer; months_elapsed integer; period_index integer;
BEGIN
  IF NEW."source_type" <> 'MEMBERSHIP_CARD' THEN RETURN NEW; END IF;
  IF NEW."card_policy_revision_id" IS NULL OR NEW."card_tier_code" IS NULL
    OR jsonb_typeof(NEW."card_qualification") IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW."card_qualification"->'evaluatedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW."card_qualification"->'windowStartsAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW."card_qualification"->'windowEndsAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW."card_qualification"->'qualifyingAmountMinor') IS DISTINCT FROM 'string'
    OR (NEW."card_qualification"->>'qualifyingAmountMinor') !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'membership card grant requires qualification provenance' USING ERRCODE = '23514';
  END IF;
  BEGIN
    qualification_at := (NEW."card_qualification"->>'evaluatedAt')::timestamptz AT TIME ZONE 'UTC';
    qualification_start := (NEW."card_qualification"->>'windowStartsAt')::timestamptz AT TIME ZONE 'UTC';
    qualification_end := (NEW."card_qualification"->>'windowEndsAt')::timestamptz AT TIME ZONE 'UTC';
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'membership card qualification time is invalid' USING ERRCODE = '23514';
  END;
  IF qualification_at IS NULL OR NOT isfinite(qualification_at) OR qualification_at IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'membership card qualification must match its grant creation time' USING ERRCODE = '23514';
  END IF;
  SELECT "group", "status", "content", "effective_at", "approved_at", "created_at"
    INTO policy_group, policy_status, policy_content, policy_effective, policy_approved, policy_created
    FROM "platform_policy_revisions" WHERE "id" = NEW."card_policy_revision_id" FOR SHARE;
  SELECT "id" INTO effective_id FROM "platform_policy_revisions"
    WHERE "group" = 'membership' AND "status" = 'scheduled' AND "effective_at" <= qualification_at
    ORDER BY "effective_at" DESC, "version" DESC LIMIT 1;
  IF policy_group IS DISTINCT FROM 'membership' OR policy_status IS DISTINCT FROM 'scheduled'
    OR policy_effective IS NULL OR policy_effective > qualification_at OR effective_id IS DISTINCT FROM NEW."card_policy_revision_id"
    OR policy_approved IS NULL OR policy_approved > qualification_at OR policy_created > qualification_at
    OR policy_content->'enabled' IS DISTINCT FROM 'true'::jsonb
    OR policy_content->'serviceLimits'->'enabled' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(policy_content->'tiers') IS DISTINCT FROM 'array'
    OR (policy_content->>'currency') IS DISTINCT FROM 'VND'
    OR policy_content->>'basis' IS NULL OR (policy_content->>'basis') NOT IN ('spend', 'topup')
    OR (NEW."card_qualification"->>'basis') IS DISTINCT FROM (policy_content->>'basis')
    OR (NEW."card_qualification"->>'currency') IS DISTINCT FROM (policy_content->>'currency') THEN
    RAISE EXCEPTION 'membership card policy must be the effective enabled membership policy' USING ERRCODE = '23514';
  END IF;
  IF (policy_content->>'cycleMode') IS DISTINCT FROM 'rolling'
    OR jsonb_typeof(policy_content->'cycleMonths') IS DISTINCT FROM 'number'
    OR (policy_content->>'cycleMonths') !~ '^[1-9][0-9]{0,2}$' THEN
    RAISE EXCEPTION 'membership card qualification requires its configured rank window' USING ERRCODE = '23514';
  END IF;
  qualification_months := (policy_content->>'cycleMonths')::integer;
  IF qualification_months > 120 OR qualification_start IS NULL OR qualification_end IS NULL
    OR NOT isfinite(qualification_start) OR NOT isfinite(qualification_end)
    OR qualification_end IS DISTINCT FROM qualification_at
    OR qualification_start IS DISTINCT FROM qualification_at - make_interval(months => qualification_months) THEN
    RAISE EXCEPTION 'membership card qualification must match its rank window' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(policy_content->'tiers') tier
    WHERE jsonb_typeof(tier->'threshold') IS DISTINCT FROM 'number' OR (tier->>'threshold') !~ '^(0|[1-9][0-9]*)$') THEN
    RAISE EXCEPTION 'membership card tier thresholds are invalid' USING ERRCODE = '23514';
  END IF;
  qualified_amount := (NEW."card_qualification"->>'qualifyingAmountMinor')::numeric;
  SELECT tier->>'code' INTO qualified_tier FROM jsonb_array_elements(policy_content->'tiers') tier
    WHERE (tier->>'threshold')::numeric <= qualified_amount ORDER BY (tier->>'threshold')::numeric DESC LIMIT 1;
  IF qualified_tier IS DISTINCT FROM NEW."card_tier_code" THEN
    RAISE EXCEPTION 'membership card tier must match its qualification amount' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*), jsonb_agg(tier)->0 INTO matches, tier_content
    FROM jsonb_array_elements(policy_content->'tiers') tier WHERE tier->>'code' = NEW."card_tier_code";
  IF matches <> 1 OR jsonb_typeof(tier_content->'serviceLimits') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'membership card tier is not configured in its policy' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*), jsonb_agg(rule)->0 INTO matches, rule_content
    FROM jsonb_array_elements(tier_content->'serviceLimits') rule
    WHERE lower(rule->>'definitionId') = NEW."definition_id"::text;
  IF matches <> 1 OR jsonb_typeof(rule_content->'quota') IS DISTINCT FROM 'string'
    OR (rule_content->>'quota') !~ '^[1-9][0-9]{0,18}$' THEN
    RAISE EXCEPTION 'membership card quota must reference one configured positive service limit' USING ERRCODE = '23514';
  END IF;
  IF (rule_content->>'quota')::numeric IS DISTINCT FROM NEW."quota"::numeric THEN
    RAISE EXCEPTION 'membership card quota must match its policy snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."reset_period" = 'calendar_month' THEN
    expected_start := date_trunc('month', qualification_at);
    expected_end := expected_start + INTERVAL '1 month';
  ELSIF NEW."reset_period" = 'none' THEN
    expected_start := policy_effective; expected_end := NULL;
  ELSE
    IF jsonb_typeof(policy_content->'serviceLimits'->'termMonths') IS DISTINCT FROM 'number'
      OR (policy_content->'serviceLimits'->>'termMonths') !~ '^[1-9][0-9]{0,2}$'
      OR jsonb_typeof(policy_content->'serviceLimits'->'termAnchorAt') IS DISTINCT FROM 'string'
      OR (policy_content->'serviceLimits'->>'termAnchorAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION 'membership card fixed window requires an explicit anchor and duration' USING ERRCODE = '23514';
    END IF;
    term_months := (policy_content->'serviceLimits'->>'termMonths')::integer;
    BEGIN
      anchor_at := (policy_content->'serviceLimits'->>'termAnchorAt')::timestamptz AT TIME ZONE 'UTC';
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'membership card fixed window anchor is invalid' USING ERRCODE = '23514';
    END;
    IF term_months > 120 OR anchor_at IS NULL OR NOT isfinite(anchor_at) OR qualification_at < anchor_at THEN
      RAISE EXCEPTION 'membership card fixed window is not available' USING ERRCODE = '23514';
    END IF;
    months_elapsed := (extract(year FROM qualification_at)::integer - extract(year FROM anchor_at)::integer) * 12
      + extract(month FROM qualification_at)::integer - extract(month FROM anchor_at)::integer;
    period_index := floor(months_elapsed::numeric / term_months)::integer;
    expected_start := anchor_at + make_interval(months => period_index * term_months);
    IF expected_start > qualification_at THEN period_index := period_index - 1; END IF;
    expected_start := anchor_at + make_interval(months => period_index * term_months);
    expected_end := anchor_at + make_interval(months => (period_index + 1) * term_months);
  END IF;
  IF NEW."starts_at" IS DISTINCT FROM expected_start OR NEW."ends_at" IS DISTINCT FROM expected_end THEN
    RAISE EXCEPTION 'membership card grant window must match its configured service period' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "membership_card_grant_validate" BEFORE INSERT ON "service_entitlement_grants"
  FOR EACH ROW EXECUTE FUNCTION "membership_card_grant_validate"();

CREATE FUNCTION "membership_card_policy_facts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."group" <> 'membership' AND NEW."group" <> 'membership' THEN RETURN NEW; END IF;
  IF (OLD."group" = 'membership' OR NEW."group" = 'membership')
    AND ROW(NEW."group", NEW."version", NEW."content", NEW."created_by_id", NEW."created_at")
      IS DISTINCT FROM ROW(OLD."group", OLD."version", OLD."content", OLD."created_by_id", OLD."created_at") THEN
    RAISE EXCEPTION 'membership policy facts are immutable; create a new revision' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "service_entitlement_grants" WHERE "card_policy_revision_id" = OLD."id")
    AND ROW(NEW."status", NEW."approved_by_id", NEW."approved_at", NEW."effective_at")
      IS DISTINCT FROM ROW(OLD."status", OLD."approved_by_id", OLD."approved_at", OLD."effective_at") THEN
    RAISE EXCEPTION 'referenced membership policy approval and effective facts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "membership_card_policy_facts_immutable" BEFORE UPDATE ON "platform_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION "membership_card_policy_facts_immutable"();

-- Keep legacy/receipt guards and pooling intact. Card usage shares consumption across revisions/tiers.
CREATE OR REPLACE FUNCTION "service_entitlement_validate_usage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owning_user uuid; grant_definition uuid; grant_source text; grant_policy uuid; effective_policy uuid;
  grant_start timestamp(3); grant_end timestamp(3);
  grant_type "service_entitlement_value_type"; grant_reset "service_entitlement_reset_period";
  grant_boolean boolean; grant_quota bigint; grant_status "service_entitlement_grant_status"; quota_pool uuid;
  expected_start timestamp(3); expected_end timestamp(3); already_used numeric;
BEGIN
  SELECT "user_id", "source_type" INTO owning_user, grant_source
    FROM "service_entitlement_grants" WHERE "id" = NEW."grant_id";
  IF grant_source = 'MEMBERSHIP_CARD' THEN
    -- A lock alone cannot refresh a RepeatableRead snapshot. SSI is required for cross-grant counters.
    IF current_setting('transaction_isolation') <> 'serializable' THEN
      RAISE EXCEPTION 'membership card consumption requires serializable isolation' USING ERRCODE = '23514';
    END IF;
    PERFORM "id" FROM "users" WHERE "id" = owning_user FOR UPDATE;
  END IF;
  SELECT "user_id", "starts_at", "ends_at", "value_type", "reset_period", "boolean_value", "quota", "status", "quota_pool_id",
      "definition_id", "source_type", "card_policy_revision_id"
    INTO owning_user, grant_start, grant_end, grant_type, grant_reset, grant_boolean, grant_quota, grant_status, quota_pool,
      grant_definition, grant_source, grant_policy
    FROM "service_entitlement_grants" WHERE "id" = NEW."grant_id" FOR UPDATE;
  IF grant_source = 'MEMBERSHIP_CARD' THEN
    SELECT "id" INTO effective_policy FROM "platform_policy_revisions"
      WHERE "group" = 'membership' AND "status" = 'scheduled' AND "effective_at" <= NEW."created_at"
      ORDER BY "effective_at" DESC, "version" DESC LIMIT 1;
    IF effective_policy IS DISTINCT FROM grant_policy THEN
      RAISE EXCEPTION 'membership card consumption requires its effective policy' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF quota_pool IS NOT NULL THEN
    PERFORM "id" FROM "service_entitlement_quota_pools" WHERE "id" = quota_pool FOR UPDATE;
  END IF;
  IF grant_reset = 'calendar_month' THEN
    expected_start := GREATEST(grant_start, date_trunc('month', NEW."created_at"));
    expected_end := LEAST(COALESCE(grant_end, 'infinity'::timestamp), date_trunc('month', NEW."created_at") + INTERVAL '1 month');
  ELSE
    expected_start := grant_start; expected_end := grant_end;
  END IF;
  IF owning_user IS DISTINCT FROM NEW."user_id" OR grant_status IS DISTINCT FROM 'active'
    OR NEW."created_at" < grant_start OR (grant_end IS NOT NULL AND NEW."created_at" >= grant_end)
    OR NEW."period_starts_at" IS DISTINCT FROM expected_start OR NEW."period_ends_at" IS DISTINCT FROM expected_end THEN
    RAISE EXCEPTION 'service entitlement usage must match its owning grant' USING ERRCODE = '23514';
  END IF;
  IF grant_type = 'boolean' AND grant_boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'disabled service entitlement cannot be consumed' USING ERRCODE = '23514';
  END IF;
  IF grant_type = 'metered' THEN
    IF grant_source = 'MEMBERSHIP_CARD' THEN
      SELECT COALESCE(SUM(usage."quantity"), 0) INTO already_used
        FROM "service_entitlement_usage" usage
        JOIN "service_entitlement_grants" source ON source."id" = usage."grant_id"
        WHERE source."source_type" = 'MEMBERSHIP_CARD' AND source."user_id" = owning_user AND source."definition_id" = grant_definition
          AND (grant_reset = 'none' OR (usage."created_at" >= expected_start AND usage."created_at" < expected_end));
    ELSE
      SELECT COALESCE(SUM(usage."quantity"), 0) INTO already_used
        FROM "service_entitlement_usage" usage
        JOIN "service_entitlement_grants" source ON source."id" = usage."grant_id"
        WHERE ((quota_pool IS NULL AND usage."grant_id" = NEW."grant_id")
            OR (quota_pool IS NOT NULL AND source."quota_pool_id" = quota_pool))
          AND usage."period_starts_at" = NEW."period_starts_at"
          AND usage."period_ends_at" IS NOT DISTINCT FROM NEW."period_ends_at";
    END IF;
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
