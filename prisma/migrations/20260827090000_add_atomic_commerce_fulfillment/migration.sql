CREATE TYPE "commerce_notification_outbox_status" AS ENUM ('pending', 'dispatched');

ALTER TABLE "membership_subscriptions"
  ADD COLUMN "source_order_line_id" UUID;

CREATE UNIQUE INDEX "membership_subscriptions_source_order_line_id_key"
  ON "membership_subscriptions"("source_order_line_id");

ALTER TABLE "membership_subscriptions"
  ADD CONSTRAINT "membership_subscriptions_source_order_line_id_fkey"
  FOREIGN KEY ("source_order_line_id") REFERENCES "commerce_order_lines"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "membership_subscriptions_validate_purchase_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_record record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."source_order_line_id" IS NOT NULL AND (
    NEW."source_order_line_id" IS DISTINCT FROM OLD."source_order_line_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."version_id" IS DISTINCT FROM OLD."version_id"
    OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
  ) THEN
    RAISE EXCEPTION 'purchased membership term snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."source_order_line_id" IS NULL THEN RETURN NEW; END IF;
  SELECT line."product_type", line."product_reference_id", orders."buyer_id",
         intent."version_id", intent."starts_at", intent."ends_at"
    INTO source_record
    FROM "commerce_order_lines" line
    JOIN "commerce_orders" orders ON orders."id" = line."order_id"
    JOIN "membership_checkout_intents" intent ON intent."order_id" = orders."id"
    WHERE line."id" = NEW."source_order_line_id";
  IF source_record IS NULL
     OR source_record."product_type" <> 'membership'
     OR source_record."product_reference_id" IS DISTINCT FROM NEW."version_id"
     OR source_record."buyer_id" IS DISTINCT FROM NEW."user_id"
     OR source_record."version_id" IS DISTINCT FROM NEW."version_id"
     OR source_record."starts_at" IS DISTINCT FROM NEW."starts_at"
     OR source_record."ends_at" IS DISTINCT FROM NEW."expires_at" THEN
    RAISE EXCEPTION 'membership term must match its immutable purchased snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "membership_subscriptions_validate_purchase_source"
  BEFORE INSERT OR UPDATE ON "membership_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "membership_subscriptions_validate_purchase_source"();

CREATE TABLE "commerce_fulfillment_effects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "order_line_id" UUID NOT NULL,
  "effect_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerce_fulfillment_effects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commerce_fulfillment_effects_line_effect_source_key"
  ON "commerce_fulfillment_effects"("order_line_id", "effect_type", "source_id");
CREATE INDEX "commerce_fulfillment_effects_order_id_created_at_idx"
  ON "commerce_fulfillment_effects"("order_id", "created_at");
CREATE INDEX "commerce_fulfillment_effects_resource_type_resource_id_idx"
  ON "commerce_fulfillment_effects"("resource_type", "resource_id");

ALTER TABLE "commerce_fulfillment_effects"
  ADD CONSTRAINT "commerce_fulfillment_effects_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "commerce_fulfillment_effects_order_line_id_fkey"
  FOREIGN KEY ("order_line_id") REFERENCES "commerce_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "commerce_fulfillment_effects_order_line_match"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "commerce_order_lines"
    WHERE "id" = NEW."order_line_id" AND "order_id" = NEW."order_id"
  ) THEN
    RAISE EXCEPTION 'fulfillment effect order line must belong to its order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_fulfillment_effects_order_line_match"
  BEFORE INSERT ON "commerce_fulfillment_effects"
  FOR EACH ROW EXECUTE FUNCTION "commerce_fulfillment_effects_order_line_match"();

CREATE TRIGGER "commerce_fulfillment_effects_immutable"
  BEFORE UPDATE OR DELETE ON "commerce_fulfillment_effects"
  FOR EACH ROW EXECUTE FUNCTION "commerce_reject_immutable_change"();

CREATE TABLE "commerce_notification_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_key" VARCHAR(128) NOT NULL,
  "order_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "status" "commerce_notification_outbox_status" NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "dispatched_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerce_notification_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commerce_notification_outbox_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "commerce_notification_outbox_status_check" CHECK (
    ("status" = 'pending' AND "dispatched_at" IS NULL)
    OR ("status" = 'dispatched' AND "dispatched_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "commerce_notification_outbox_event_key_key"
  ON "commerce_notification_outbox"("event_key");
CREATE INDEX "commerce_notification_outbox_status_created_at_idx"
  ON "commerce_notification_outbox"("status", "created_at");
CREATE INDEX "commerce_notification_outbox_order_id_idx"
  ON "commerce_notification_outbox"("order_id");

ALTER TABLE "commerce_notification_outbox"
  ADD CONSTRAINT "commerce_notification_outbox_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "commerce_notification_outbox_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "commerce_notification_outbox_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."event_key" IS DISTINCT FROM NEW."event_key"
     OR OLD."order_id" IS DISTINCT FROM NEW."order_id"
     OR OLD."user_id" IS DISTINCT FROM NEW."user_id"
     OR OLD."event_type" IS DISTINCT FROM NEW."event_type"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'notification outbox identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status"
     AND NOT (OLD."status" = 'pending' AND NEW."status" = 'dispatched') THEN
    RAISE EXCEPTION 'invalid notification outbox transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION 'notification outbox attempts are monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_notification_outbox_guard"
  BEFORE UPDATE ON "commerce_notification_outbox"
  FOR EACH ROW EXECUTE FUNCTION "commerce_notification_outbox_guard"();
