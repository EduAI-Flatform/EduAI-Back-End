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

CREATE OR REPLACE FUNCTION "commerce_validate_order_line_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_row "commerce_orders"%ROWTYPE;
  product_row "commerce_products"%ROWTYPE;
  course_title text;
  course_price integer;
  course_currency varchar(3);
  membership_title text;
  membership_currency varchar(3);
  membership_base_price bigint;
  membership_months integer;
  membership_fixed_price bigint;
  membership_discount_percent integer;
  membership_list_price bigint;
  membership_final_price bigint;
BEGIN
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = NEW."order_id";
  SELECT * INTO product_row FROM "commerce_products" WHERE "id" = NEW."product_id";
  IF order_row."id" IS NULL OR product_row."id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."currency" <> order_row."currency"
     OR NEW."product_type" <> product_row."type"
     OR NEW."seller_id" <> product_row."seller_id" THEN
    RAISE EXCEPTION 'order line snapshot does not match order/product authority' USING ERRCODE = '23514';
  END IF;

  IF product_row."type" = 'course' THEN
    IF NEW."product_reference_id" IS DISTINCT FROM product_row."course_id" THEN
      RAISE EXCEPTION 'order line snapshot does not match order/product authority' USING ERRCODE = '23514';
    END IF;
    SELECT "title", COALESCE("price_amount_minor", 0), COALESCE("price_currency", 'VND')
      INTO course_title, course_price, course_currency
      FROM "courses" WHERE "id" = product_row."course_id";
    IF product_row."status" <> 'active' OR course_title IS NULL
       OR NEW."display_title" <> course_title
       OR NEW."unit_list_price_amount_minor" <> course_price
       OR NEW."currency" <> course_currency THEN
      RAISE EXCEPTION 'order line must snapshot the active course title and current price' USING ERRCODE = '23514';
    END IF;
  ELSIF product_row."type" = 'membership' THEN
    IF NEW."product_reference_id" IS DISTINCT FROM product_row."membership_plan_version_id" THEN
      RAISE EXCEPTION 'membership order line must match its immutable checkout intent' USING ERRCODE = '23514';
    END IF;
    SELECT version."display_name", version."currency", version."base_monthly_price_amount_minor",
           duration."months", duration."price_amount_minor", duration."discount_percent"
      INTO membership_title, membership_currency, membership_base_price,
           membership_months, membership_fixed_price, membership_discount_percent
      FROM "membership_checkout_intents" intent
      JOIN "membership_plan_versions" version ON version."id" = intent."version_id"
      JOIN "membership_duration_options" duration ON duration."id" = intent."duration_option_id"
      WHERE intent."order_id" = NEW."order_id"
        AND intent."version_id" = product_row."membership_plan_version_id"
        AND duration."version_id" = version."id";
    IF membership_title IS NULL THEN
      RAISE EXCEPTION 'membership order line must match its immutable checkout intent' USING ERRCODE = '23514';
    END IF;
    membership_final_price := COALESCE(
      membership_fixed_price,
      membership_base_price * membership_months * (100 - COALESCE(membership_discount_percent, 0)) / 100
    );
    membership_list_price := CASE
      WHEN membership_discount_percent IS NULL THEN membership_final_price
      ELSE membership_base_price * membership_months
    END;
    IF product_row."status" <> 'active'
       OR NEW."display_title" <> membership_title
       OR NEW."currency" <> membership_currency
       OR NEW."quantity" <> 1
       OR NEW."unit_list_price_amount_minor" <> membership_list_price
       OR NEW."subtotal_amount_minor" <> membership_list_price
       OR NEW."discount_amount_minor" <> membership_list_price - membership_final_price
       OR NEW."final_amount_minor" <> membership_final_price THEN
      RAISE EXCEPTION 'membership order line must match its immutable checkout intent' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'order line product type is unsupported' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
