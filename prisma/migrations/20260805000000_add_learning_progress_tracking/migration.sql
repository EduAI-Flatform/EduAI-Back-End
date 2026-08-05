ALTER TABLE "learning_progress"
  ADD COLUMN "watched_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duration_seconds" INTEGER,
  ADD COLUMN "last_position_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_watched_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "document_progress_percent" INTEGER NOT NULL DEFAULT 0;
