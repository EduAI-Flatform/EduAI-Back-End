ALTER TABLE "commerce_payment_attempts"
  ADD COLUMN "provider_receiving_account_hash" VARCHAR(128);

ALTER TABLE "commerce_payment_attempts"
  ADD CONSTRAINT "commerce_payment_attempts_receiving_account_check" CHECK (
    "provider" <> 'payos'
    OR "status" = 'created'
    OR "provider_receiving_account_hash" IS NOT NULL
  );

CREATE FUNCTION "commerce_guard_payment_receiving_account"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."provider_receiving_account_hash" IS NOT NULL
     AND NEW."provider_receiving_account_hash"
       IS DISTINCT FROM OLD."provider_receiving_account_hash" THEN
    RAISE EXCEPTION 'provider receiving account identity is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commerce_payment_attempts_guard_receiving_account"
  BEFORE UPDATE ON "commerce_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "commerce_guard_payment_receiving_account"();
