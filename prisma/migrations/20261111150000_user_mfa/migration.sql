CREATE TABLE "user_mfa" (
  "user_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "secret_encrypted" TEXT,
  "pending_secret_encrypted" TEXT,
  "pending_expires_at" TIMESTAMP(3),
  "last_used_step" INTEGER,
  "recovery_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "enabled_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_mfa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_mfa_enabled_secret_check" CHECK (NOT "enabled" OR ("secret_encrypted" IS NOT NULL AND "enabled_at" IS NOT NULL)),
  CONSTRAINT "user_mfa_revision_check" CHECK ("revision" >= 0)
);
