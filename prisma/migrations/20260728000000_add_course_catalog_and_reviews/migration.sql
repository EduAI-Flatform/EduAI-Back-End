ALTER TABLE "courses"
ADD COLUMN "badge" TEXT,
ADD COLUMN "featured_rank" INTEGER,
ADD COLUMN "price_amount_minor" INTEGER,
ADD COLUMN "price_currency" VARCHAR(3);

ALTER TABLE "courses"
ADD CONSTRAINT "courses_featured_rank_check"
CHECK ("featured_rank" IS NULL OR "featured_rank" > 0),
ADD CONSTRAINT "courses_price_amount_minor_check"
CHECK ("price_amount_minor" IS NULL OR "price_amount_minor" >= 0),
ADD CONSTRAINT "courses_price_pair_check"
CHECK (
  ("price_amount_minor" IS NULL AND "price_currency" IS NULL)
  OR
  ("price_amount_minor" IS NOT NULL AND "price_currency" IS NOT NULL)
);

CREATE INDEX "courses_featured_rank_idx" ON "courses"("featured_rank");

CREATE TABLE "course_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "course_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "course_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  CONSTRAINT "course_reviews_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_reviews_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "course_reviews_course_id_user_id_key"
ON "course_reviews"("course_id", "user_id");

CREATE INDEX "course_reviews_user_id_idx" ON "course_reviews"("user_id");
