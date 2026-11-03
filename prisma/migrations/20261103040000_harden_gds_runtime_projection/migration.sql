-- Keep projections under a bounded definer trigger so runtime cannot mutate funds directly.
-- No table, model, balance or historical journal data is changed.
CREATE OR REPLACE FUNCTION public.gds_internal_apply_journal() RETURNS TRIGGER
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE source_topup RECORD;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR
     TG_RELID <> 'public.gds_internal_journal'::regclass THEN
    RAISE EXCEPTION 'GDS journal projection requires its canonical journal trigger';
  END IF;
  IF NEW."kind" = 'TOPUP_CREDIT' THEN
    SELECT * INTO source_topup FROM public."gds_internal_topups" WHERE "id" = NEW."topup_id" FOR UPDATE;
    IF NOT FOUND OR source_topup."status" <> 'PAYOS_VERIFIED' OR
       source_topup."wallet_id" <> NEW."wallet_id" OR
       source_topup."amount_minor" <> NEW."amount_minor" OR
       source_topup."collection_reference" IS DISTINCT FROM NEW."collection_reference" OR
       source_topup."signature_verified_at" IS NULL OR
       source_topup."provider_reconciled_at" IS NULL OR
       source_topup."provider_reconciled_at" < source_topup."signature_verified_at" THEN
      RAISE EXCEPTION 'GDS topup is not signed and reconciled';
    END IF;
    UPDATE public."gds_internal_topups" SET "status" = 'CREDITED', "credited_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP WHERE "id" = NEW."topup_id";
  ELSIF NEW."kind" = 'RESERVE' THEN
    INSERT INTO public."gds_internal_holds"("wallet_id","order_ref","amount_minor","updated_at")
      VALUES (NEW."wallet_id",NEW."order_ref",NEW."amount_minor",CURRENT_TIMESTAMP);
  ELSE
    UPDATE public."gds_internal_holds" SET "status" = CASE WHEN NEW."kind" = 'CAPTURE' THEN 'CAPTURED' ELSE 'RELEASED' END,
      "updated_at" = CURRENT_TIMESTAMP
      WHERE "wallet_id" = NEW."wallet_id" AND "order_ref" = NEW."order_ref" AND
        "amount_minor" = NEW."amount_minor" AND "status" = 'RESERVED';
    IF NOT FOUND THEN RAISE EXCEPTION 'GDS hold is missing, mismatched or terminal'; END IF;
  END IF;
  UPDATE public."gds_internal_wallets"
    SET "available_minor" = "available_minor" + NEW."available_delta_minor",
        "held_minor" = "held_minor" + NEW."held_delta_minor",
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."wallet_id" AND "status" = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'GDS wallet is unavailable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.gds_internal_apply_journal() FROM PUBLIC;

-- Prisma explicitly includes scalar defaults. Permit zero-valued inserts, never opening credit.
CREATE FUNCTION public.gds_internal_wallet_zero_start() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.available_minor <> 0 OR NEW.held_minor <> 0) AND
     NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid=TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'Runtime wallets must start at zero';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gds_internal_wallet_zero_start() FROM PUBLIC;
CREATE TRIGGER gds_internal_wallet_zero_start BEFORE INSERT ON public.gds_internal_wallets
FOR EACH ROW EXECUTE FUNCTION public.gds_internal_wallet_zero_start();
