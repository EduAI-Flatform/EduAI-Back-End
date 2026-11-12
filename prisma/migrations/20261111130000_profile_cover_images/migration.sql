-- Additive only: existing profile and access records are preserved.
ALTER TABLE "user_profiles"
  ADD COLUMN "cover_url" TEXT,
  ADD COLUMN "cover_storage_key" TEXT;
