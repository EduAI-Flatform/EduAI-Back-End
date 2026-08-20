CREATE TYPE "job_status" AS ENUM ('draft', 'published', 'closed');
CREATE TYPE "job_work_mode" AS ENUM ('remote', 'hybrid', 'onsite');
CREATE TYPE "job_employment_type" AS ENUM ('full_time', 'part_time', 'internship', 'contract');

CREATE TABLE "job_opportunities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "created_by_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "company_name" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "location" TEXT,
  "work_mode" "job_work_mode" NOT NULL,
  "employment_type" "job_employment_type" NOT NULL,
  "salary_min" INTEGER,
  "salary_max" INTEGER,
  "salary_currency" VARCHAR(3),
  "status" "job_status" NOT NULL DEFAULT 'draft',
  "published_at" TIMESTAMP(3),
  "closes_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "job_opportunities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_required_skills" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "level" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_required_skills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_opportunities_status_closes_at_idx" ON "job_opportunities"("status", "closes_at");
CREATE INDEX "job_opportunities_company_name_idx" ON "job_opportunities"("company_name");
CREATE INDEX "job_opportunities_created_at_idx" ON "job_opportunities"("created_at");
CREATE INDEX "job_opportunities_deleted_at_idx" ON "job_opportunities"("deleted_at");
CREATE UNIQUE INDEX "job_required_skills_job_id_name_key" ON "job_required_skills"("job_id", "name");
CREATE INDEX "job_required_skills_name_idx" ON "job_required_skills"("name");
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_required_skills" ADD CONSTRAINT "job_required_skills_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
