CREATE TABLE "learning_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "learning_goal" TEXT,
  "current_level" TEXT,
  "weekly_availability_hours" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "learning_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "learning_profiles_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "learning_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "learning_skill_gaps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profile_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "current_level" TEXT,
  "target_level" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "learning_skill_gaps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "learning_skill_gaps_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "learning_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "learning_skill_gaps_profile_id_idx" ON "learning_skill_gaps"("profile_id");
