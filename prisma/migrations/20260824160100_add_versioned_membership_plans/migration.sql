CREATE TYPE "membership_plan_status" AS ENUM ('active', 'archived');
CREATE TYPE "membership_plan_version_status" AS ENUM ('draft', 'published', 'archived');

CREATE TABLE "membership_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(64) NOT NULL,
  "status" "membership_plan_status" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "membership_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_plans_archive_check" CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);

CREATE TABLE "membership_plan_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(2000),
  "base_monthly_price_amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
  "sales_start_at" TIMESTAMP(3),
  "sales_end_at" TIMESTAMP(3),
  "status" "membership_plan_version_status" NOT NULL DEFAULT 'draft',
  "created_by_id" UUID NOT NULL,
  "published_by_id" UUID,
  "archived_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "published_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "membership_plan_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_plan_versions_version_check" CHECK ("version_number" > 0),
  CONSTRAINT "membership_plan_versions_price_check" CHECK ("base_monthly_price_amount_minor" >= 0),
  CONSTRAINT "membership_plan_versions_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "membership_plan_versions_sales_window_check" CHECK (
    "sales_end_at" IS NULL OR "sales_start_at" IS NULL OR "sales_end_at" > "sales_start_at"
  ),
  CONSTRAINT "membership_plan_versions_status_check" CHECK (
    ("status" = 'draft' AND "published_at" IS NULL AND "published_by_id" IS NULL AND "archived_at" IS NULL AND "archived_by_id" IS NULL)
    OR ("status" = 'published' AND "published_at" IS NOT NULL AND "published_by_id" IS NOT NULL AND "archived_at" IS NULL AND "archived_by_id" IS NULL)
    OR ("status" = 'archived' AND "published_at" IS NOT NULL AND "published_by_id" IS NOT NULL AND "archived_at" IS NOT NULL AND "archived_by_id" IS NOT NULL)
  )
);

CREATE TABLE "membership_duration_options" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version_id" UUID NOT NULL,
  "months" INTEGER NOT NULL,
  "price_amount_minor" BIGINT,
  "discount_percent" INTEGER,
  "display_order" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_duration_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_duration_options_months_check" CHECK ("months" > 0),
  CONSTRAINT "membership_duration_options_display_order_check" CHECK ("display_order" >= 0),
  CONSTRAINT "membership_duration_options_price_check" CHECK ("price_amount_minor" IS NULL OR "price_amount_minor" >= 0),
  CONSTRAINT "membership_duration_options_discount_check" CHECK ("discount_percent" IS NULL OR "discount_percent" BETWEEN 0 AND 100),
  CONSTRAINT "membership_duration_options_pricing_mode_check" CHECK (
    ("price_amount_minor" IS NOT NULL) <> ("discount_percent" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "membership_plans_code_key" ON "membership_plans"("code");
CREATE INDEX "membership_plans_status_updated_at_idx" ON "membership_plans"("status", "updated_at");
CREATE INDEX "membership_plans_archived_at_idx" ON "membership_plans"("archived_at");
CREATE UNIQUE INDEX "membership_plan_versions_plan_id_version_number_key" ON "membership_plan_versions"("plan_id", "version_number");
CREATE INDEX "membership_plan_versions_plan_id_status_version_number_idx" ON "membership_plan_versions"("plan_id", "status", "version_number");
CREATE INDEX "membership_plan_versions_status_sales_start_at_sales_end_at_idx" ON "membership_plan_versions"("status", "sales_start_at", "sales_end_at");
CREATE UNIQUE INDEX "membership_duration_options_version_id_months_key" ON "membership_duration_options"("version_id", "months");
CREATE UNIQUE INDEX "membership_duration_options_version_id_display_order_key" ON "membership_duration_options"("version_id", "display_order");
CREATE INDEX "membership_duration_options_version_id_display_order_idx" ON "membership_duration_options"("version_id", "display_order");

ALTER TABLE "membership_plan_versions" ADD CONSTRAINT "membership_plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_versions" ADD CONSTRAINT "membership_plan_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_versions" ADD CONSTRAINT "membership_plan_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_plan_versions" ADD CONSTRAINT "membership_plan_versions_archived_by_id_fkey" FOREIGN KEY ("archived_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_duration_options" ADD CONSTRAINT "membership_duration_options_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commerce_products" ADD COLUMN "membership_plan_version_id" UUID;
CREATE UNIQUE INDEX "commerce_products_membership_plan_version_id_key" ON "commerce_products"("membership_plan_version_id");
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_membership_plan_version_id_fkey" FOREIGN KEY ("membership_plan_version_id") REFERENCES "membership_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commerce_products" DROP CONSTRAINT "commerce_products_supported_source_check";
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_reference_check" CHECK (
  ("type" = 'course' AND "course_id" IS NOT NULL AND "membership_plan_version_id" IS NULL)
  OR ("type" = 'membership' AND "course_id" IS NULL AND "membership_plan_version_id" IS NOT NULL)
);

CREATE FUNCTION "membership_guard_plan_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership plan identities are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status" = 'archived'
    OR (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'archived'))
  THEN
    RAISE EXCEPTION 'membership plan identities are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" = 'archived' AND EXISTS (
    SELECT 1
      FROM "membership_plan_versions" v
      JOIN "commerce_products" p ON p."membership_plan_version_id" = v."id"
      WHERE v."plan_id" = OLD."id" AND p."status" <> 'archived'
  ) THEN
    RAISE EXCEPTION 'membership plan products must be archived first' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "membership_require_draft_version_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'draft' THEN
    RAISE EXCEPTION 'membership versions must be created as drafts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "membership_reject_immutable_version_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_plan_status "membership_plan_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'published membership versions are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'membership version identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('published', 'archived') AND (
    NEW."display_name" IS DISTINCT FROM OLD."display_name"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."base_monthly_price_amount_minor" IS DISTINCT FROM OLD."base_monthly_price_amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."sales_start_at" IS DISTINCT FROM OLD."sales_start_at"
    OR NEW."sales_end_at" IS DISTINCT FROM OLD."sales_end_at"
    OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
    OR (OLD."status" = 'archived')
    OR NEW."status" NOT IN ('published', 'archived')
  ) THEN
    RAISE EXCEPTION 'published membership versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'draft' AND NEW."status" = 'published' AND NOT EXISTS (
    SELECT 1 FROM "membership_duration_options" WHERE "version_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'A published membership version requires at least one duration option' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'draft' AND NEW."status" = 'published' THEN
    SELECT "status" INTO source_plan_status FROM "membership_plans" WHERE "id" = OLD."plan_id" FOR UPDATE;
    IF source_plan_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'only active membership plans can publish versions' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "membership_guard_duration_option_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_version_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."version_id" ELSE NEW."version_id" END;
  source_status "membership_plan_version_status";
BEGIN
  SELECT "status" INTO source_status FROM "membership_plan_versions" WHERE "id" = source_version_id;
  IF source_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'published membership duration options are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."version_id" IS DISTINCT FROM NEW."version_id" THEN
    RAISE EXCEPTION 'membership duration options cannot move between versions' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "membership_plans_immutable"
  BEFORE UPDATE OR DELETE ON "membership_plans"
  FOR EACH ROW EXECUTE FUNCTION "membership_guard_plan_change"();
CREATE TRIGGER "membership_plan_versions_require_draft"
  BEFORE INSERT ON "membership_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "membership_require_draft_version_insert"();
CREATE TRIGGER "membership_plan_versions_immutable"
  BEFORE UPDATE OR DELETE ON "membership_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "membership_reject_immutable_version_change"();
CREATE TRIGGER "membership_duration_options_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "membership_duration_options"
  FOR EACH ROW EXECUTE FUNCTION "membership_guard_duration_option_change"();

CREATE OR REPLACE FUNCTION "commerce_validate_product_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  course_instructor uuid;
  membership_status "membership_plan_version_status";
  membership_plan_status "membership_plan_status";
  seller_is_platform_admin boolean;
BEGIN
  IF NEW."type" = 'course' THEN
    SELECT "instructor_id" INTO course_instructor FROM "courses" WHERE "id" = NEW."course_id";
    IF course_instructor IS DISTINCT FROM NEW."seller_id" THEN
      RAISE EXCEPTION 'commerce product seller must own the source course' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW."status" = 'archived' THEN
      RETURN NEW;
    END IF;
    SELECT "status" INTO membership_status
      FROM "membership_plan_versions" WHERE "id" = NEW."membership_plan_version_id";
    SELECT "status" INTO membership_plan_status
      FROM "membership_plans"
      WHERE "id" = (
        SELECT "plan_id" FROM "membership_plan_versions"
          WHERE "id" = NEW."membership_plan_version_id"
      )
      FOR KEY SHARE;
    SELECT EXISTS (
      SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."role_id"
      WHERE ur."user_id" = NEW."seller_id" AND r."name" = 'platform_admin'
    ) INTO seller_is_platform_admin;
    IF membership_status IS DISTINCT FROM 'published'
      OR membership_plan_status IS DISTINCT FROM 'active'
      OR NOT seller_is_platform_admin
    THEN
      RAISE EXCEPTION 'membership products require a published version and platform administrator seller' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "commerce_products_validate_source" ON "commerce_products";
CREATE TRIGGER "commerce_products_validate_source"
  BEFORE INSERT OR UPDATE OF "status" ON "commerce_products"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_product_source"();

CREATE OR REPLACE FUNCTION "commerce_guard_product_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."type", NEW."course_id", NEW."membership_plan_version_id", NEW."seller_id", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."type", OLD."course_id", OLD."membership_plan_version_id", OLD."seller_id", OLD."created_at") THEN
    RAISE EXCEPTION 'commerce product source facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       (OLD."status" = 'draft' AND NEW."status" IN ('active', 'archived'))
       OR (OLD."status" = 'active' AND NEW."status" = 'archived')
     ) THEN
    RAISE EXCEPTION 'invalid commerce product status transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS DISTINCT FROM OLD."archived_at" THEN
    RAISE EXCEPTION 'commerce product archive timestamp is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
