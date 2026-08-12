ALTER TABLE "quizzes"
  ADD COLUMN "max_attempts" INTEGER,
  ADD COLUMN "randomize_questions" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "randomize_options" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "show_correct_answers" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "quizzes"
  ADD CONSTRAINT "quizzes_max_attempts_positive"
  CHECK ("max_attempts" IS NULL OR "max_attempts" > 0);

CREATE INDEX "quiz_attempts_quiz_user_submitted_at_idx"
  ON "quiz_attempts"("quiz_id", "user_id", "submitted_at");
