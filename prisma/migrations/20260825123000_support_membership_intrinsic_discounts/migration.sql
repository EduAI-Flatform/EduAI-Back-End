CREATE OR REPLACE FUNCTION "commerce_validate_order_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  order_row "commerce_orders"%ROWTYPE;
  line_subtotal bigint;
  line_discount bigint;
  line_final bigint;
  line_count bigint;
  benefit_discount bigint;
BEGIN
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    target_order_id := NEW."id";
  ELSE
    target_order_id := NEW."order_id";
  END IF;
  SELECT * INTO order_row FROM "commerce_orders" WHERE "id" = target_order_id;
  IF order_row."id" IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum("subtotal_amount_minor"), 0), COALESCE(sum("discount_amount_minor"), 0),
         COALESCE(sum("final_amount_minor"), 0), count(*)
    INTO line_subtotal, line_discount, line_final, line_count
    FROM "commerce_order_lines" WHERE "order_id" = target_order_id;
  IF line_count = 0 OR line_subtotal <> order_row."subtotal_amount_minor"
     OR line_discount <> order_row."discount_amount_minor"
     OR line_final <> order_row."payable_amount_minor" THEN
    RAISE EXCEPTION 'order totals do not equal immutable line snapshots' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'commerce_order_lines' THEN
    SELECT COALESCE(sum("allocated_discount_amount_minor"), 0) INTO benefit_discount
      FROM "commerce_order_line_benefits" WHERE "order_line_id" = NEW."id";
    IF NEW."product_type" = 'course' AND benefit_discount <> NEW."discount_amount_minor" THEN
      RAISE EXCEPTION 'line benefit allocations do not equal line discount' USING ERRCODE = '23514';
    END IF;
    IF NEW."product_type" = 'membership' AND benefit_discount <> 0 THEN
      RAISE EXCEPTION 'membership duration pricing cannot be represented as a promotion benefit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_validate_benefit_totals"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected bigint;
  actual bigint;
  line_product_type "commerce_product_type";
BEGIN
  SELECT "discount_amount_minor", "product_type" INTO expected, line_product_type
    FROM "commerce_order_lines" WHERE "id" = NEW."order_line_id";
  IF line_product_type = 'membership' THEN
    RAISE EXCEPTION 'membership duration pricing cannot be represented as a promotion benefit' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum("allocated_discount_amount_minor"), 0) INTO actual
    FROM "commerce_order_line_benefits" WHERE "order_line_id" = NEW."order_line_id";
  IF actual <> expected THEN
    RAISE EXCEPTION 'line benefit allocations do not equal line discount' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
