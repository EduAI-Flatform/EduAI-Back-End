-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('draft', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('percentage', 'fixed');

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "category_slug" TEXT;

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'draft',
    "kind" "VoucherKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "minimum_course_price_minor" INTEGER,
    "maximum_discount_minor" INTEGER,
    "usage_limit" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "per_user_limit" INTEGER,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "voucher_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,

    CONSTRAINT "voucher_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "voucher_id" UUID NOT NULL,
    "category_slug" TEXT NOT NULL,

    CONSTRAINT "voucher_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "voucher_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "voucher_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_redemptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "voucher_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "redemption_key" TEXT NOT NULL,
    "original_amount_minor" INTEGER NOT NULL,
    "discount_amount_minor" INTEGER NOT NULL,
    "final_amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX "vouchers_status_starts_at_ends_at_idx" ON "vouchers"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "vouchers_created_by_id_idx" ON "vouchers"("created_by_id");

-- CreateIndex
CREATE INDEX "voucher_courses_course_id_idx" ON "voucher_courses"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_courses_voucher_id_course_id_key" ON "voucher_courses"("voucher_id", "course_id");

-- CreateIndex
CREATE INDEX "voucher_categories_category_slug_idx" ON "voucher_categories"("category_slug");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_categories_voucher_id_category_slug_key" ON "voucher_categories"("voucher_id", "category_slug");

-- CreateIndex
CREATE INDEX "voucher_users_user_id_idx" ON "voucher_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_users_voucher_id_user_id_key" ON "voucher_users"("voucher_id", "user_id");

-- CreateIndex
CREATE INDEX "voucher_redemptions_user_id_created_at_idx" ON "voucher_redemptions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "voucher_redemptions_course_id_created_at_idx" ON "voucher_redemptions"("course_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_redemptions_voucher_id_user_id_redemption_key_key" ON "voucher_redemptions"("voucher_id", "user_id", "redemption_key");

-- CreateIndex
CREATE INDEX "courses_category_slug_idx" ON "courses"("category_slug");

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_courses" ADD CONSTRAINT "voucher_courses_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_courses" ADD CONSTRAINT "voucher_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_categories" ADD CONSTRAINT "voucher_categories_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_users" ADD CONSTRAINT "voucher_users_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_users" ADD CONSTRAINT "voucher_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
