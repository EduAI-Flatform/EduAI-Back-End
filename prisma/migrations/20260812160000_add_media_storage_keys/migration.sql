ALTER TABLE "users"
  ADD COLUMN "avatar_storage_key" TEXT;

ALTER TABLE "portfolios"
  ADD COLUMN "image_storage_key" TEXT;

ALTER TABLE "courses"
  ADD COLUMN "thumbnail_storage_key" TEXT;

ALTER TABLE "lessons"
  ADD COLUMN "video_storage_key" TEXT,
  ADD COLUMN "document_storage_key" TEXT;
