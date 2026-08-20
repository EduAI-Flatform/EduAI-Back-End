ALTER TABLE "user_profiles"
ADD COLUMN "career_goal" TEXT,
ADD COLUMN "preferred_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "preferred_work_modes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "availability_status" TEXT,
ADD COLUMN "available_from" DATE;
