-- CreateEnum
CREATE TYPE "TmiRewardKind" AS ENUM ('course_access', 'voucher', 'gift');

-- CreateEnum
CREATE TYPE "TmiRewardStatus" AS ENUM ('draft', 'active', 'disabled', 'expired');

-- CreateTable
CREATE TABLE "tmi_rewards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "TmiRewardKind" NOT NULL,
    "cost" INTEGER NOT NULL,
    "status" "TmiRewardStatus" NOT NULL DEFAULT 'draft',
    "quota" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "inventory_metadata" JSONB,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tmi_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tmi_rewards_status_starts_at_ends_at_idx" ON "tmi_rewards"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "tmi_rewards_created_by_id_idx" ON "tmi_rewards"("created_by_id");

-- AddForeignKey
ALTER TABLE "tmi_rewards" ADD CONSTRAINT "tmi_rewards_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
