-- CreateEnum
CREATE TYPE "ScholarshipStatus" AS ENUM ('draft', 'active', 'paused', 'closed');

-- CreateEnum
CREATE TYPE "ScholarshipApplicationMode" AS ENUM ('application', 'automatic');

-- CreateEnum
CREATE TYPE "ScholarshipBenefitKind" AS ENUM ('course_access', 'percentage_discount', 'fixed_credit');

-- CreateEnum
CREATE TYPE "ScholarshipApplicationStatus" AS ENUM ('pending', 'awarded', 'rejected', 'revoked');

-- CreateTable
CREATE TABLE "scholarship_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ScholarshipStatus" NOT NULL DEFAULT 'draft',
    "application_mode" "ScholarshipApplicationMode" NOT NULL,
    "benefit_kind" "ScholarshipBenefitKind" NOT NULL,
    "benefit_value" INTEGER NOT NULL,
    "currency" VARCHAR(3),
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "quota" INTEGER,
    "awarded_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scholarship_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scholarship_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,

    CONSTRAINT "scholarship_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scholarship_id" UUID NOT NULL,
    "category_slug" TEXT NOT NULL,

    CONSTRAINT "scholarship_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scholarship_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "scholarship_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scholarship_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "status" "ScholarshipApplicationStatus" NOT NULL DEFAULT 'pending',
    "decision_reason" TEXT,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scholarship_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarship_awards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scholarship_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "benefit_kind" "ScholarshipBenefitKind" NOT NULL,
    "benefit_value" INTEGER NOT NULL,
    "currency" VARCHAR(3),
    "awarded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "scholarship_awards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scholarship_campaigns_status_starts_at_ends_at_idx" ON "scholarship_campaigns"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "scholarship_campaigns_created_by_id_idx" ON "scholarship_campaigns"("created_by_id");

-- CreateIndex
CREATE INDEX "scholarship_courses_course_id_idx" ON "scholarship_courses"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_courses_scholarship_id_course_id_key" ON "scholarship_courses"("scholarship_id", "course_id");

-- CreateIndex
CREATE INDEX "scholarship_categories_category_slug_idx" ON "scholarship_categories"("category_slug");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_categories_scholarship_id_category_slug_key" ON "scholarship_categories"("scholarship_id", "category_slug");

-- CreateIndex
CREATE INDEX "scholarship_users_user_id_idx" ON "scholarship_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_users_scholarship_id_user_id_key" ON "scholarship_users"("scholarship_id", "user_id");

-- CreateIndex
CREATE INDEX "scholarship_applications_user_id_status_idx" ON "scholarship_applications"("user_id", "status");

-- CreateIndex
CREATE INDEX "scholarship_applications_course_id_status_idx" ON "scholarship_applications"("course_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_applications_scholarship_id_user_id_course_id_key" ON "scholarship_applications"("scholarship_id", "user_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "scholarship_awards_application_id_key" ON "scholarship_awards"("application_id");

-- CreateIndex
CREATE INDEX "scholarship_awards_user_id_course_id_idx" ON "scholarship_awards"("user_id", "course_id");

-- CreateIndex
CREATE INDEX "scholarship_awards_scholarship_id_awarded_at_idx" ON "scholarship_awards"("scholarship_id", "awarded_at");

-- AddForeignKey
ALTER TABLE "scholarship_campaigns" ADD CONSTRAINT "scholarship_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_courses" ADD CONSTRAINT "scholarship_courses_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarship_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_courses" ADD CONSTRAINT "scholarship_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_categories" ADD CONSTRAINT "scholarship_categories_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarship_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_users" ADD CONSTRAINT "scholarship_users_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarship_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_users" ADD CONSTRAINT "scholarship_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_applications" ADD CONSTRAINT "scholarship_applications_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarship_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_applications" ADD CONSTRAINT "scholarship_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_applications" ADD CONSTRAINT "scholarship_applications_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_awards" ADD CONSTRAINT "scholarship_awards_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarship_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_awards" ADD CONSTRAINT "scholarship_awards_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "scholarship_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarship_awards" ADD CONSTRAINT "scholarship_awards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
