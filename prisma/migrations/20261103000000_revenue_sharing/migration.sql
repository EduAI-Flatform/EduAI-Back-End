-- AlterTable
ALTER TABLE "membership_plan_versions" ADD COLUMN     "revenue_policy_id" UUID;

-- AlterTable
ALTER TABLE "membership_plan_included_courses" ADD COLUMN     "revenue_weight" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "revenue_terms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_participations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "terms_id" UUID NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_participation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "terms_id" UUID NOT NULL,
    "action" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_participation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_plan_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "terms_id" UUID NOT NULL,
    "platform_fee_bps" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "overrides" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "notice_mode" VARCHAR(20) NOT NULL,
    "notice_days" INTEGER,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_version_id" UUID,

    CONSTRAINT "revenue_plan_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_retail_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "platform_fee_bps" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "notice_mode" VARCHAR(20) NOT NULL,
    "notice_days" INTEGER,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_retail_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_order_snapshots" (
    "order_line_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_type" VARCHAR(20) NOT NULL,
    "policy_id" UUID NOT NULL,
    "platform_fee_bps" INTEGER NOT NULL,
    "basis_amount_minor" BIGINT NOT NULL,
    "platform_amount_minor" BIGINT NOT NULL,
    "seller_amount_minor" BIGINT NOT NULL,
    "participants" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_order_snapshots_pkey" PRIMARY KEY ("order_line_id")
);

-- CreateTable
CREATE TABLE "revenue_earning_periods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "period_index" INTEGER NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "revenue_earning_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period_id" UUID NOT NULL,
    "source_key" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_participations_course_id_key" ON "revenue_participations"("course_id");

-- CreateIndex
CREATE INDEX "revenue_participations_seller_id_left_at_idx" ON "revenue_participations"("seller_id", "left_at");

-- CreateIndex
CREATE INDEX "revenue_participation_events_course_id_created_at_idx" ON "revenue_participation_events"("course_id", "created_at");

-- CreateIndex
CREATE INDEX "revenue_plan_policies_status_effective_at_idx" ON "revenue_plan_policies"("status", "effective_at");

-- CreateIndex
CREATE INDEX "revenue_plan_policies_plan_id_created_at_idx" ON "revenue_plan_policies"("plan_id", "created_at");

-- CreateIndex
CREATE INDEX "revenue_retail_policies_status_effective_at_idx" ON "revenue_retail_policies"("status", "effective_at");

-- CreateIndex
CREATE INDEX "revenue_order_snapshots_order_id_idx" ON "revenue_order_snapshots"("order_id");

-- CreateIndex
CREATE INDEX "revenue_earning_periods_seller_id_due_at_idx" ON "revenue_earning_periods"("seller_id", "due_at");

-- CreateIndex
CREATE INDEX "revenue_earning_periods_due_at_idx" ON "revenue_earning_periods"("due_at");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_earning_periods_snapshot_id_course_id_period_index_key" ON "revenue_earning_periods"("snapshot_id", "course_id", "period_index");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_ledger_entries_source_key_key" ON "revenue_ledger_entries"("source_key");

-- CreateIndex
CREATE INDEX "revenue_ledger_entries_period_id_created_at_idx" ON "revenue_ledger_entries"("period_id", "created_at");

-- AddForeignKey
ALTER TABLE "revenue_earning_periods" ADD CONSTRAINT "revenue_earning_periods_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "revenue_order_snapshots"("order_line_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "revenue_earning_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Financial history is append-only; mutable rows are projections/policy lifecycle only.
ALTER TABLE "revenue_terms" ADD CONSTRAINT "revenue_terms_creator_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participations" ADD CONSTRAINT "revenue_participations_course_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participations" ADD CONSTRAINT "revenue_participations_seller_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participations" ADD CONSTRAINT "revenue_participations_terms_fkey" FOREIGN KEY ("terms_id") REFERENCES "revenue_terms"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participation_events" ADD CONSTRAINT "revenue_participation_events_course_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participation_events" ADD CONSTRAINT "revenue_participation_events_seller_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_participation_events" ADD CONSTRAINT "revenue_participation_events_terms_fkey" FOREIGN KEY ("terms_id") REFERENCES "revenue_terms"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_source_version_fkey" FOREIGN KEY ("source_version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_activated_version_fkey" FOREIGN KEY ("activated_version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_terms_fkey" FOREIGN KEY ("terms_id") REFERENCES "revenue_terms"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_retail_policies" ADD CONSTRAINT "revenue_retail_policies_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "membership_plan_versions" ADD CONSTRAINT "membership_versions_revenue_policy_fkey" FOREIGN KEY ("revenue_policy_id") REFERENCES "revenue_plan_policies"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_order_snapshots" ADD CONSTRAINT "revenue_order_snapshots_line_fkey" FOREIGN KEY ("order_line_id") REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_order_snapshots" ADD CONSTRAINT "revenue_order_snapshots_order_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_earning_periods" ADD CONSTRAINT "revenue_earning_periods_seller_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_earning_periods" ADD CONSTRAINT "revenue_earning_periods_course_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT;

ALTER TABLE "revenue_terms" ADD CONSTRAINT "revenue_terms_nonempty" CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0);
ALTER TABLE "revenue_participations" ADD CONSTRAINT "revenue_participations_chronology" CHECK ("left_at" IS NULL OR "left_at" >= "accepted_at");
ALTER TABLE "revenue_participation_events" ADD CONSTRAINT "revenue_participation_events_action" CHECK ("action" IN ('accepted', 'left'));
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_fee_bounded" CHECK ("platform_fee_bps" BETWEEN 0 AND 10000);
ALTER TABLE "revenue_retail_policies" ADD CONSTRAINT "revenue_retail_policies_fee_bounded" CHECK ("platform_fee_bps" BETWEEN 0 AND 10000);
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_state" CHECK ("status" IN ('scheduled','active','superseded','cancelled'));
ALTER TABLE "revenue_retail_policies" ADD CONSTRAINT "revenue_retail_policies_state" CHECK ("status" IN ('scheduled','active','superseded','cancelled'));
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_notice" CHECK (("notice_mode"='immediate' AND "notice_days" IS NULL) OR ("notice_mode"='delayed' AND "notice_days" IS NOT NULL AND "notice_days">0));
ALTER TABLE "revenue_retail_policies" ADD CONSTRAINT "revenue_retail_policies_notice" CHECK (("notice_mode"='immediate' AND "notice_days" IS NULL) OR ("notice_mode"='delayed' AND "notice_days" IS NOT NULL AND "notice_days">0));
ALTER TABLE "revenue_plan_policies" ADD CONSTRAINT "revenue_plan_policies_arrays" CHECK (jsonb_typeof("rules")='array' AND jsonb_typeof("overrides")='array');
ALTER TABLE "membership_plan_included_courses" ADD CONSTRAINT "membership_included_course_positive_weight" CHECK ("revenue_weight">0);
ALTER TABLE "revenue_order_snapshots" ADD CONSTRAINT "revenue_order_snapshots_money" CHECK ("platform_fee_bps" BETWEEN 0 AND 10000 AND "basis_amount_minor">=0 AND "platform_amount_minor">=0 AND "seller_amount_minor">=0 AND "platform_amount_minor"+"seller_amount_minor"="basis_amount_minor");
ALTER TABLE "revenue_order_snapshots" ADD CONSTRAINT "revenue_order_snapshots_participants" CHECK ("product_type" IN ('course','membership') AND jsonb_typeof("participants")='array');
ALTER TABLE "revenue_earning_periods" ADD CONSTRAINT "revenue_earning_periods_bounds" CHECK ("period_index">=0 AND "amount_minor">=0);
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_entries_kind" CHECK ("kind" IN ('recognized','refund_pending','refund_recognized') AND ("kind"<>'recognized' OR "amount_minor">=0));
CREATE UNIQUE INDEX "revenue_plan_policy_one_scheduled" ON "revenue_plan_policies"("plan_id") WHERE "status"='scheduled';
CREATE UNIQUE INDEX "revenue_plan_policy_one_active" ON "revenue_plan_policies"("plan_id") WHERE "status"='active';
CREATE UNIQUE INDEX "revenue_retail_policy_one_scheduled" ON "revenue_retail_policies"((true)) WHERE "status"='scheduled';
CREATE UNIQUE INDEX "revenue_retail_policy_one_active" ON "revenue_retail_policies"((true)) WHERE "status"='active';

CREATE FUNCTION "revenue_reject_history_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revenue history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER "revenue_terms_immutable" BEFORE UPDATE OR DELETE ON "revenue_terms" FOR EACH ROW EXECUTE FUNCTION "revenue_reject_history_mutation"();
CREATE TRIGGER "revenue_participation_events_immutable" BEFORE UPDATE OR DELETE ON "revenue_participation_events" FOR EACH ROW EXECUTE FUNCTION "revenue_reject_history_mutation"();
CREATE TRIGGER "revenue_order_snapshots_immutable" BEFORE UPDATE OR DELETE ON "revenue_order_snapshots" FOR EACH ROW EXECUTE FUNCTION "revenue_reject_history_mutation"();
CREATE TRIGGER "revenue_earning_periods_immutable" BEFORE UPDATE OR DELETE ON "revenue_earning_periods" FOR EACH ROW EXECUTE FUNCTION "revenue_reject_history_mutation"();
CREATE TRIGGER "revenue_ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "revenue_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "revenue_reject_history_mutation"();

CREATE FUNCTION "revenue_guard_policy_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'revenue policy history is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'status'-'activated_version_id') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'activated_version_id') THEN
    RAISE EXCEPTION 'revenue policy terms are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW."status"=OLD."status" OR (OLD."status"='scheduled' AND NEW."status" IN ('active','cancelled')) OR (OLD."status"='active' AND NEW."status"='superseded')) THEN
    RAISE EXCEPTION 'invalid revenue policy transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "revenue_plan_policy_history" BEFORE UPDATE OR DELETE ON "revenue_plan_policies" FOR EACH ROW EXECUTE FUNCTION "revenue_guard_policy_update"();
CREATE TRIGGER "revenue_retail_policy_history" BEFORE UPDATE OR DELETE ON "revenue_retail_policies" FOR EACH ROW EXECUTE FUNCTION "revenue_guard_policy_update"();

CREATE FUNCTION "revenue_guard_membership_policy_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"<>'draft' AND NEW."revenue_policy_id" IS DISTINCT FROM OLD."revenue_policy_id" THEN
    RAISE EXCEPTION 'published membership revenue policy is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."revenue_policy_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "revenue_plan_policies" WHERE "id"=NEW."revenue_policy_id" AND "plan_id"=NEW."plan_id") THEN
    RAISE EXCEPTION 'membership revenue policy must belong to plan' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "membership_version_revenue_policy_immutable" BEFORE UPDATE ON "membership_plan_versions" FOR EACH ROW EXECUTE FUNCTION "revenue_guard_membership_policy_change"();

CREATE FUNCTION "revenue_guard_snapshot_source"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_line RECORD;
BEGIN
  SELECT * INTO source_line FROM "commerce_order_lines" WHERE "id"=NEW."order_line_id";
  IF NOT FOUND OR source_line."order_id"<>NEW."order_id" OR source_line."product_type"::text<>NEW."product_type" OR source_line."final_amount_minor"<>NEW."basis_amount_minor" OR source_line."currency"<>'VND' THEN
    RAISE EXCEPTION 'revenue snapshot does not match order line' USING ERRCODE='23514';
  END IF;
  IF NEW."product_type"='course' AND NOT EXISTS (SELECT 1 FROM "revenue_retail_policies" WHERE "id"=NEW."policy_id" AND "platform_fee_bps"=NEW."platform_fee_bps") THEN
    RAISE EXCEPTION 'revenue retail snapshot policy is missing or mismatched' USING ERRCODE='23514';
  END IF;
  IF NEW."product_type"='membership' AND NOT EXISTS (SELECT 1 FROM "revenue_plan_policies" WHERE "id"=NEW."policy_id" AND "platform_fee_bps"=NEW."platform_fee_bps") THEN
    RAISE EXCEPTION 'revenue membership snapshot policy is missing or mismatched' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "revenue_order_snapshot_source" BEFORE INSERT ON "revenue_order_snapshots" FOR EACH ROW EXECUTE FUNCTION "revenue_guard_snapshot_source"();

-- Each adjustment points to the recorded refund that established its cumulative target.
ALTER TABLE "revenue_ledger_entries" ADD COLUMN "source_refund_id" UUID;
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_source_refund_fkey" FOREIGN KEY ("source_refund_id") REFERENCES "commerce_refunds"("id") ON DELETE RESTRICT;
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_refund_source_required" CHECK (("kind"='recognized' AND "source_refund_id" IS NULL) OR ("kind" IN ('refund_pending','refund_recognized') AND "source_refund_id" IS NOT NULL));
CREATE FUNCTION "revenue_guard_ledger_refund_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IN ('refund_pending','refund_recognized') AND NOT EXISTS (
    SELECT 1 FROM "commerce_refunds" r
    JOIN "commerce_refund_allocations" a ON a."refund_id"=r."id"
    JOIN "revenue_earning_periods" p ON p."snapshot_id"=a."order_line_id"
    JOIN "revenue_order_snapshots" s ON s."order_line_id"=p."snapshot_id"
    JOIN "commerce_orders" o ON o."id"=s."order_id"
    WHERE r."id"=NEW."source_refund_id" AND r."status"='recorded' AND p."id"=NEW."period_id"
      AND r."order_id"=o."id" AND r."settlement_id"=o."confirmed_settlement_id"
  ) THEN
    RAISE EXCEPTION 'revenue adjustment requires a recorded canonical refund allocated to its order line' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "revenue_ledger_refund_source" BEFORE INSERT ON "revenue_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "revenue_guard_ledger_refund_source"();
