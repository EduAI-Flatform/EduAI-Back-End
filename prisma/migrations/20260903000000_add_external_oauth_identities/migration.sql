-- Keep existing Firebase Google sessions compatible. The normalized table is
-- additive and does not attempt to infer a provider ID from firebase_uid.
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'facebook';
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'zalo';

CREATE TYPE "ExternalProvider" AS ENUM ('facebook', 'zalo');

CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "ExternalProvider" NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "user_id" UUID,
    "provider_email" VARCHAR(320),
    "provider_name" VARCHAR(160),
    "provider_avatar" VARCHAR(2048),
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "pending_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_accounts_provider_provider_user_id_key"
    ON "oauth_accounts"("provider", "provider_user_id");
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");
CREATE INDEX "oauth_accounts_pending_expires_at_idx"
    ON "oauth_accounts"("pending_expires_at");

ALTER TABLE "oauth_accounts"
    ADD CONSTRAINT "oauth_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
