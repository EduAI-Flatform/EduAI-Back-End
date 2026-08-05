ALTER TABLE "assignments"
  ADD COLUMN "instructions" TEXT,
  ADD COLUMN "rubric" TEXT,
  ADD COLUMN "allowed_file_mime_types" TEXT[] NOT NULL DEFAULT ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'image/jpeg',
    'image/png'
  ]::TEXT[],
  ADD COLUMN "max_file_size_bytes" INTEGER NOT NULL DEFAULT 20971520;
