-- CreateEnum
CREATE TYPE "tmi_ledger_kind" AS ENUM ('earn', 'redeem', 'refund', 'adjustment', 'expiry');

-- CreateEnum
CREATE TYPE "tmi_adjustment_direction" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "tmi_entitlement_status" AS ENUM ('active', 'revoked');

-- DropIndex
DROP INDEX "quiz_attempts_quiz_user_submitted_at_idx";

-- AlterTable
ALTER TABLE "ai_learning_paths" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "tmi_redemptions" (
    "idempotency_key" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "reward_id" UUID NOT NULL,
    "cost" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tmi_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tmi_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "redemption_id" UUID,
    "kind" "tmi_ledger_kind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "adjustment_direction" "tmi_adjustment_direction",
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "tmi_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tmi_entitlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "redemption_id" UUID NOT NULL,
    "kind" "TmiRewardKind" NOT NULL,
    "status" "tmi_entitlement_status" NOT NULL DEFAULT 'active',
    "benefit_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "tmi_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tmi_redemptions_user_id_created_at_idx" ON "tmi_redemptions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "tmi_redemptions_reward_id_created_at_idx" ON "tmi_redemptions"("reward_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tmi_redemptions_user_id_idempotency_key_key" ON "tmi_redemptions"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "tmi_ledger_entries_user_id_occurred_at_idx" ON "tmi_ledger_entries"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "tmi_ledger_entries_redemption_id_idx" ON "tmi_ledger_entries"("redemption_id");

-- CreateIndex
CREATE UNIQUE INDEX "tmi_ledger_entries_user_id_kind_source_type_source_id_key" ON "tmi_ledger_entries"("user_id", "kind", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "tmi_entitlements_redemption_id_key" ON "tmi_entitlements"("redemption_id");

-- CreateIndex
CREATE INDEX "tmi_entitlements_user_id_status_created_at_idx" ON "tmi_entitlements"("user_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "tmi_redemptions" ADD CONSTRAINT "tmi_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tmi_redemptions" ADD CONSTRAINT "tmi_redemptions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "tmi_rewards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tmi_ledger_entries" ADD CONSTRAINT "tmi_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tmi_ledger_entries" ADD CONSTRAINT "tmi_ledger_entries_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "tmi_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tmi_entitlements" ADD CONSTRAINT "tmi_entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tmi_entitlements" ADD CONSTRAINT "tmi_entitlements_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "tmi_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
