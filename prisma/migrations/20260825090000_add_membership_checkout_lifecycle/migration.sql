CREATE TYPE "membership_subscription_status" AS ENUM ('active', 'cancelled');
CREATE TYPE "membership_checkout_action" AS ENUM ('purchase', 'renew', 'upgrade', 'downgrade');

CREATE TABLE "membership_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "status" "membership_subscription_status" NOT NULL DEFAULT 'active',
  "starts_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "membership_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_subscriptions_window_check" CHECK ("expires_at" > "starts_at")
);

CREATE TABLE "membership_checkout_intents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "duration_option_id" UUID NOT NULL,
  "action" "membership_checkout_action" NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "activates_immediately" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_checkout_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_checkout_intents_order_id_key" UNIQUE ("order_id"),
  CONSTRAINT "membership_checkout_intents_window_check" CHECK ("ends_at" > "starts_at")
);

CREATE INDEX "membership_subscriptions_user_id_status_expires_at_idx" ON "membership_subscriptions"("user_id", "status", "expires_at");
CREATE INDEX "membership_checkout_intents_user_id_created_at_idx" ON "membership_checkout_intents"("user_id", "created_at");
CREATE INDEX "membership_checkout_intents_version_id_idx" ON "membership_checkout_intents"("version_id");

ALTER TABLE "membership_subscriptions" ADD CONSTRAINT "membership_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_subscriptions" ADD CONSTRAINT "membership_subscriptions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_checkout_intents" ADD CONSTRAINT "membership_checkout_intents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_checkout_intents" ADD CONSTRAINT "membership_checkout_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_checkout_intents" ADD CONSTRAINT "membership_checkout_intents_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_checkout_intents" ADD CONSTRAINT "membership_checkout_intents_duration_option_id_fkey" FOREIGN KEY ("duration_option_id") REFERENCES "membership_duration_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
