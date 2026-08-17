CREATE TABLE "ai_learning_paths" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "input_json" JSONB NOT NULL,
  "output_json" JSONB NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_learning_paths_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_learning_paths_user_id_version_key" UNIQUE ("user_id", "version"),
  CONSTRAINT "ai_learning_paths_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ai_learning_paths_user_id_created_at_idx" ON "ai_learning_paths"("user_id", "created_at");
