-- Source/dev migration only. Admission and processing start disabled.
ALTER TABLE gds_internal_wallets ADD COLUMN debt_minor BIGINT NOT NULL DEFAULT 0 CHECK (debt_minor >= 0);
CREATE OR REPLACE FUNCTION public.gds_internal_wallet_zero_start() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.available_minor<>0 OR NEW.held_minor<>0 OR NEW.debt_minor<>0) AND
 NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=TG_RELID),'USAGE') THEN
 RAISE EXCEPTION 'Runtime wallets must start at zero'; END IF;
 RETURN NEW;
END $$;
CREATE TABLE gds_withdrawal_settings (
 id VARCHAR(16) PRIMARY KEY DEFAULT 'global' CHECK(id='global'),
 minimum_minor BIGINT NOT NULL DEFAULT 50000 CHECK(minimum_minor>0),
 maximum_minor BIGINT NOT NULL DEFAULT 10000000 CHECK(maximum_minor>=minimum_minor AND maximum_minor<=9007199254740991),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 admission_enabled BOOLEAN NOT NULL DEFAULT false,
 processing_enabled BOOLEAN NOT NULL DEFAULT false,
 revenue_cutoff_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 revenue_activated_at TIMESTAMP(3),
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO gds_withdrawal_settings(id) VALUES('global');
-- Freeze the historical boundary on first activation, covering deployment delays.
CREATE FUNCTION gds_withdrawal_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GDS settings cannot be deleted'; END IF;
 IF OLD.revenue_activated_at IS NOT NULL AND (NEW.revenue_cutoff_at<>OLD.revenue_cutoff_at OR NEW.revenue_activated_at IS DISTINCT FROM OLD.revenue_activated_at)
 THEN RAISE EXCEPTION 'GDS historical cutoff is immutable after activation'; END IF;
 IF OLD.revenue_activated_at IS NULL AND NEW.processing_enabled THEN
  NEW.revenue_activated_at:=clock_timestamp(); NEW.revenue_cutoff_at:=NEW.revenue_activated_at;
 ELSIF OLD.revenue_activated_at IS NULL AND (NEW.revenue_cutoff_at<>OLD.revenue_cutoff_at OR NEW.revenue_activated_at IS NOT NULL) THEN
  RAISE EXCEPTION 'GDS cutoff requires first processing activation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_settings_guard BEFORE UPDATE OR DELETE ON gds_withdrawal_settings FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_settings_guard();
CREATE TABLE gds_withdrawals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 wallet_id UUID NOT NULL REFERENCES gds_internal_wallets(id) ON DELETE RESTRICT,
 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key_hash VARCHAR(64) NOT NULL CHECK(request_key_hash ~ '^[a-f0-9]{64}$'),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0), currency VARCHAR(3) NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
 bank_code VARCHAR(32) NOT NULL CHECK(bank_code ~ '^[A-Za-z0-9_-]{2,32}$'),
 account_number VARCHAR(34) NOT NULL CHECK(account_number ~ '^[0-9]{6,34}$'),
 account_holder VARCHAR(160) NOT NULL CHECK(length(trim(account_holder)) BETWEEN 2 AND 160),
 settings_version INTEGER NOT NULL, minimum_minor BIGINT NOT NULL, maximum_minor BIGINT NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','PROCESSING','PAID','CANCELLED','REJECTED','FAILED')),
 processing_admin_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 bank_transaction_ref VARCHAR(160) UNIQUE,
 transferred_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,request_key_hash), CHECK(amount_minor BETWEEN minimum_minor AND maximum_minor),
 CHECK(processing_admin_id IS NULL OR processing_admin_id<>owner_id),
 CHECK(status<>'PAID' OR (bank_transaction_ref IS NOT NULL AND length(trim(bank_transaction_ref))>0 AND transferred_at IS NOT NULL))
);
CREATE INDEX gds_withdrawals_owner_created_idx ON gds_withdrawals(owner_id,created_at);
CREATE INDEX gds_withdrawals_status_created_idx ON gds_withdrawals(status,created_at);
CREATE TABLE gds_withdrawal_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), withdrawal_id UUID NOT NULL REFERENCES gds_withdrawals(id) ON DELETE RESTRICT,
 actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 from_status VARCHAR(16), to_status VARCHAR(16) NOT NULL,
 reason VARCHAR(500) NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 bank_transaction_ref VARCHAR(160), transferred_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gds_withdrawal_events_history_idx ON gds_withdrawal_events(withdrawal_id,created_at);
CREATE TABLE gds_revenue_projections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), period_id UUID NOT NULL UNIQUE REFERENCES revenue_earning_periods(id) ON DELETE RESTRICT,
 wallet_id UUID NOT NULL REFERENCES gds_internal_wallets(id) ON DELETE RESTRICT,
 applied_net_minor BIGINT NOT NULL DEFAULT 0, historical_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK(historical_paid_minor>=0),
 review_required BOOLEAN NOT NULL, reviewed_by_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 reviewed_at TIMESTAMP(3), review_reason VARCHAR(500), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE gds_revenue_effects (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), projection_id UUID NOT NULL REFERENCES gds_revenue_projections(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL, delta_minor BIGINT NOT NULL CHECK(delta_minor<>0),
 available_delta_minor BIGINT NOT NULL, debt_delta_minor BIGINT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(projection_id,revision),
 CHECK(available_delta_minor-debt_delta_minor=delta_minor)
);

-- Preserve all previous topup/capture source validators and definer privileges.
DROP TRIGGER gds_internal_journal_apply ON gds_internal_journal;
CREATE TRIGGER gds_internal_journal_apply AFTER INSERT ON gds_internal_journal
 FOR EACH ROW WHEN (NEW.kind IN ('TOPUP_CREDIT','RESERVE','CAPTURE','RELEASE')) EXECUTE FUNCTION gds_internal_apply_journal();
DO $$ DECLARE old_check TEXT; BEGIN
 SELECT pg_get_constraintdef(oid) INTO old_check FROM pg_constraint
 WHERE conrelid='gds_internal_journal'::regclass AND conname='gds_internal_journal_posting_check';
 EXECUTE 'ALTER TABLE gds_internal_journal DROP CONSTRAINT gds_internal_journal_posting_check';
 EXECUTE 'ALTER TABLE gds_internal_journal ADD CONSTRAINT gds_internal_journal_posting_check CHECK ((' ||
 substring(old_check FROM 8 FOR length(old_check)-8) || ') OR (' ||
 'topup_id IS NULL AND collection_reference IS NULL AND order_ref IS NOT NULL AND (' ||
 '(kind=''WITHDRAWAL_RESERVE'' AND available_delta_minor=-amount_minor AND held_delta_minor=amount_minor AND clearing_delta_minor=0) OR ' ||
 '(kind=''WITHDRAWAL_RELEASE'' AND available_delta_minor=amount_minor AND held_delta_minor=-amount_minor AND clearing_delta_minor=0) OR ' ||
 '(kind=''WITHDRAWAL_PAID'' AND available_delta_minor=0 AND held_delta_minor=-amount_minor AND clearing_delta_minor=amount_minor) OR ' ||
 '(kind=''REVENUE_CREDIT'' AND available_delta_minor=amount_minor AND held_delta_minor=0 AND clearing_delta_minor=-amount_minor) OR ' ||
 '(kind=''REVENUE_REVERSAL'' AND available_delta_minor=-amount_minor AND held_delta_minor=0 AND clearing_delta_minor=amount_minor))))';
END $$;
CREATE UNIQUE INDEX gds_withdrawal_journal_once ON gds_internal_journal(order_ref,kind) WHERE kind LIKE 'WITHDRAWAL_%';

CREATE OR REPLACE FUNCTION gds_internal_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GDS wallet cannot be deleted'; END IF;
 IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id OR
 ((NEW.available_minor IS DISTINCT FROM OLD.available_minor OR NEW.held_minor IS DISTINCT FROM OLD.held_minor OR NEW.debt_minor IS DISTINCT FROM OLD.debt_minor) AND pg_trigger_depth()<2)
 THEN RAISE EXCEPTION 'GDS wallet balance is journal-controlled'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION gds_withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w RECORD; s RECORD;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GDS withdrawal audit is append-only'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO s FROM gds_withdrawal_settings WHERE id='global' FOR SHARE;
  SELECT * INTO w FROM gds_internal_wallets WHERE id=NEW.wallet_id FOR UPDATE;
  IF NOT FOUND OR w.buyer_id<>NEW.owner_id OR w.status<>'ACTIVE' OR w.debt_minor<>0 OR w.available_minor<NEW.amount_minor
   OR NOT s.admission_enabled OR NOT s.processing_enabled OR NEW.status<>'PENDING' OR NEW.processing_admin_id IS NOT NULL
   OR NEW.bank_transaction_ref IS NOT NULL OR NEW.transferred_at IS NOT NULL
   OR NEW.settings_version<>s.version OR NEW.minimum_minor<>s.minimum_minor OR NEW.maximum_minor<>s.maximum_minor
  THEN RAISE EXCEPTION 'GDS withdrawal admission or balance invalid'; END IF;
 ELSE
  IF pg_trigger_depth()<2 OR
    (to_jsonb(NEW)-ARRAY['status','processing_admin_id','bank_transaction_ref','transferred_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','processing_admin_id','bank_transaction_ref','transferred_at','updated_at'])
  THEN RAISE EXCEPTION 'GDS withdrawal is event-controlled with immutable identity'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_guard BEFORE INSERT OR UPDATE OR DELETE ON gds_withdrawals FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_guard();

CREATE FUNCTION gds_withdrawal_new() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO public.gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
 VALUES(NEW.wallet_id,'gds:withdrawal:reserve:'||NEW.id,'WITHDRAWAL_RESERVE',NEW.amount_minor,-NEW.amount_minor,NEW.amount_minor,0,NEW.id::text);
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_new AFTER INSERT ON gds_withdrawals FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_new();

CREATE FUNCTION gds_withdrawal_event_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r RECORD; w RECORD; k TEXT;
BEGIN
 SELECT * INTO r FROM public.gds_withdrawals WHERE id=NEW.withdrawal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GDS withdrawal missing'; END IF;
 IF NEW.from_status IS NULL THEN
  IF r.status<>'PENDING' OR NEW.to_status<>'PENDING' OR NEW.actor_id<>r.owner_id OR EXISTS(SELECT 1 FROM public.gds_withdrawal_events WHERE withdrawal_id=r.id AND id<>NEW.id)
  THEN RAISE EXCEPTION 'GDS withdrawal invalid creation event'; END IF;
  RETURN NEW;
 END IF;
 IF r.status<>NEW.from_status OR NOT (
 (r.status='PENDING' AND NEW.to_status IN ('APPROVED','REJECTED','CANCELLED')) OR
 (r.status='APPROVED' AND NEW.to_status IN ('PROCESSING','REJECTED')) OR
 (r.status='PROCESSING' AND NEW.to_status IN ('PAID','FAILED')))
 THEN RAISE EXCEPTION 'GDS withdrawal invalid transition'; END IF;
 IF (NEW.to_status='CANCELLED' AND NEW.actor_id<>r.owner_id) OR (NEW.to_status<>'CANCELLED' AND NEW.actor_id=r.owner_id)
 THEN RAISE EXCEPTION 'GDS withdrawal actor invalid'; END IF;
 IF NEW.to_status IN ('PROCESSING','PAID','FAILED') AND NOT (SELECT processing_enabled FROM public.gds_withdrawal_settings WHERE id='global')
 THEN RAISE EXCEPTION 'GDS withdrawal processing disabled'; END IF;
 IF NEW.to_status='PROCESSING' THEN
  SELECT * INTO w FROM public.gds_internal_wallets WHERE id=r.wallet_id FOR UPDATE;
  IF w.status<>'ACTIVE' OR w.debt_minor<>0 THEN RAISE EXCEPTION 'GDS withdrawal blocked by wallet or debt'; END IF;
 ELSIF NEW.to_status IN ('PAID','FAILED') AND r.processing_admin_id IS DISTINCT FROM NEW.actor_id THEN
  RAISE EXCEPTION 'GDS withdrawal claimed by another admin';
 END IF;
 IF NEW.to_status='PAID' AND (NEW.bank_transaction_ref IS NULL OR length(trim(NEW.bank_transaction_ref))<1 OR NEW.transferred_at IS NULL
  OR NEW.transferred_at<r.created_at OR NEW.transferred_at>clock_timestamp())
 THEN RAISE EXCEPTION 'GDS withdrawal payment proof or transfer time invalid'; END IF;
 IF NEW.to_status<>'PAID' AND (NEW.bank_transaction_ref IS NOT NULL OR NEW.transferred_at IS NOT NULL)
 THEN RAISE EXCEPTION 'GDS withdrawal unexpected payment proof'; END IF;
 UPDATE public.gds_withdrawals SET status=NEW.to_status,
  processing_admin_id=CASE WHEN NEW.to_status='PROCESSING' THEN NEW.actor_id ELSE processing_admin_id END,
  bank_transaction_ref=CASE WHEN NEW.to_status='PAID' THEN NEW.bank_transaction_ref ELSE bank_transaction_ref END,
  transferred_at=CASE WHEN NEW.to_status='PAID' THEN NEW.transferred_at ELSE transferred_at END,
  updated_at=CURRENT_TIMESTAMP WHERE id=r.id;
 k:=CASE WHEN NEW.to_status='PAID' THEN 'WITHDRAWAL_PAID' WHEN NEW.to_status IN ('CANCELLED','REJECTED','FAILED') THEN 'WITHDRAWAL_RELEASE' END;
 IF k IS NOT NULL THEN
  INSERT INTO public.gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
  VALUES(r.wallet_id,'gds:withdrawal:terminal:'||r.id,k,r.amount_minor,CASE WHEN k='WITHDRAWAL_RELEASE' THEN r.amount_minor ELSE 0 END,-r.amount_minor,CASE WHEN k='WITHDRAWAL_PAID' THEN r.amount_minor ELSE 0 END,r.id::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_event_apply AFTER INSERT ON gds_withdrawal_events FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_event_apply();
CREATE TRIGGER gds_withdrawal_event_immutable BEFORE UPDATE OR DELETE ON gds_withdrawal_events FOR EACH ROW EXECUTE FUNCTION gds_internal_journal_no_mutation();

CREATE FUNCTION gds_extended_journal_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r RECORD;
BEGIN
 IF NEW.kind LIKE 'WITHDRAWAL_%' THEN
  SELECT * INTO r FROM public.gds_withdrawals WHERE id::text=NEW.order_ref FOR UPDATE;
  IF NOT FOUND OR r.wallet_id<>NEW.wallet_id OR r.amount_minor<>NEW.amount_minor OR
   (NEW.kind='WITHDRAWAL_RESERVE' AND r.status<>'PENDING') OR
   (NEW.kind='WITHDRAWAL_RELEASE' AND r.status NOT IN ('CANCELLED','REJECTED','FAILED')) OR
   (NEW.kind='WITHDRAWAL_PAID' AND r.status<>'PAID')
  THEN RAISE EXCEPTION 'GDS withdrawal journal missing or mismatched source'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.gds_revenue_effects e JOIN public.gds_revenue_projections p ON p.id=e.projection_id
   WHERE e.id::text=NEW.order_ref AND p.wallet_id=NEW.wallet_id AND e.available_delta_minor=NEW.available_delta_minor
   AND NEW.event_key='gds:revenue:'||e.id::text)
  THEN RAISE EXCEPTION 'GDS revenue journal missing or mismatched source'; END IF;
 END IF;
 UPDATE public.gds_internal_wallets SET available_minor=available_minor+NEW.available_delta_minor,
  held_minor=held_minor+NEW.held_delta_minor,updated_at=CURRENT_TIMESTAMP WHERE id=NEW.wallet_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'GDS wallet missing'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_extended_journal_apply AFTER INSERT ON gds_internal_journal FOR EACH ROW
 WHEN (NEW.kind IN ('WITHDRAWAL_RESERVE','WITHDRAWAL_RELEASE','WITHDRAWAL_PAID','REVENUE_CREDIT','REVENUE_REVERSAL')) EXECUTE FUNCTION gds_extended_journal_apply();

CREATE FUNCTION gds_revenue_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller UUID; historic BOOLEAN; net BIGINT;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GDS revenue audit is append-only'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT seller_id INTO seller FROM revenue_earning_periods WHERE id=NEW.period_id;
  SELECT EXISTS(SELECT 1 FROM revenue_ledger_entries e,gds_withdrawal_settings s WHERE e.period_id=NEW.period_id AND e.kind='recognized' AND e.created_at<=s.revenue_cutoff_at) INTO historic;
  IF NOT EXISTS(SELECT 1 FROM gds_internal_wallets WHERE id=NEW.wallet_id AND buyer_id=seller) OR NEW.applied_net_minor<>0 OR NEW.historical_paid_minor<>0 OR NEW.revision<>0 OR NEW.review_required<>historic
   OR NEW.reviewed_at IS NOT NULL OR NEW.reviewed_by_id IS NOT NULL THEN RAISE EXCEPTION 'GDS revenue projection invalid source'; END IF;
 ELSE
  IF NEW.period_id<>OLD.period_id OR NEW.wallet_id<>OLD.wallet_id OR NEW.created_at<>OLD.created_at
   OR ((NEW.applied_net_minor<>OLD.applied_net_minor OR NEW.revision<>OLD.revision) AND pg_trigger_depth()<2)
  THEN RAISE EXCEPTION 'GDS revenue projection is effect-controlled'; END IF;
  IF OLD.reviewed_at IS NOT NULL AND (NEW.historical_paid_minor<>OLD.historical_paid_minor OR NEW.review_required<>OLD.review_required OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by_id IS DISTINCT FROM OLD.reviewed_by_id OR NEW.review_reason IS DISTINCT FROM OLD.review_reason)
   THEN RAISE EXCEPTION 'GDS revenue review is immutable'; END IF;
  IF OLD.review_required AND NOT NEW.review_required THEN
   SELECT COALESCE(sum(amount_minor),0) INTO net FROM revenue_ledger_entries WHERE period_id=OLD.period_id AND kind='recognized';
   IF NEW.reviewed_by_id IS NULL OR NEW.reviewed_at IS NULL OR NEW.review_reason IS NULL OR length(trim(NEW.review_reason))<1 OR NEW.historical_paid_minor>net
    OR EXISTS(SELECT 1 FROM gds_internal_wallets WHERE id=NEW.wallet_id AND buyer_id=NEW.reviewed_by_id)
   THEN RAISE EXCEPTION 'GDS revenue review invalid'; END IF;
  ELSIF NEW.historical_paid_minor<>OLD.historical_paid_minor OR NEW.review_required<>OLD.review_required OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by_id IS DISTINCT FROM OLD.reviewed_by_id THEN
   RAISE EXCEPTION 'GDS revenue review invalid transition';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_revenue_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON gds_revenue_projections FOR EACH ROW EXECUTE FUNCTION gds_revenue_projection_guard();

CREATE FUNCTION gds_revenue_effect_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p RECORD; w RECORD; target BIGINT; delta BIGINT; cash BIGINT; debt BIGINT;
BEGIN
 SELECT * INTO p FROM public.gds_revenue_projections WHERE id=NEW.projection_id FOR UPDATE;
 IF NOT FOUND OR p.review_required OR NEW.revision<>p.revision+1 THEN RAISE EXCEPTION 'GDS revenue requires review or revision mismatch'; END IF;
 SELECT * INTO w FROM public.gds_internal_wallets WHERE id=p.wallet_id FOR UPDATE;
 SELECT COALESCE(sum(amount_minor),0) INTO target FROM public.revenue_ledger_entries WHERE period_id=p.period_id AND kind IN ('recognized','refund_recognized');
 IF target<0 OR NOT EXISTS (
  SELECT 1 FROM public.revenue_earning_periods ep
  JOIN public.revenue_order_snapshots s ON s.id=ep.snapshot_id
  JOIN public.commerce_orders o ON o.id=s.order_id
  JOIN public.commerce_settlements c ON c.id=o.confirmed_settlement_id
  WHERE ep.id=p.period_id AND target<=ep.amount_minor AND ep.due_at<=clock_timestamp()
   AND o.status='confirmed' AND c.order_id=o.id AND c.amount_minor=o.payable_amount_minor
   AND c.currency=o.currency AND o.currency='VND' AND c.disposition IN ('matched','internal')
 ) THEN RAISE EXCEPTION 'GDS revenue requires verified settlement and bounded recognized amount'; END IF;
 delta:=target-p.historical_paid_minor-p.applied_net_minor;
 IF delta>0 THEN debt:=-LEAST(delta,w.debt_minor); cash:=delta+debt;
 ELSE cash:=-LEAST(-delta,w.available_minor); debt:=-delta+cash; END IF;
 IF NEW.delta_minor<>delta OR NEW.available_delta_minor<>cash OR NEW.debt_delta_minor<>debt THEN RAISE EXCEPTION 'GDS revenue effect source or balance mismatch'; END IF;
 UPDATE public.gds_revenue_projections SET applied_net_minor=target-historical_paid_minor,revision=NEW.revision WHERE id=p.id;
 UPDATE public.gds_internal_wallets SET debt_minor=debt_minor+debt WHERE id=w.id;
 IF cash<>0 THEN
  INSERT INTO public.gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
  VALUES(w.id,'gds:revenue:'||NEW.id,CASE WHEN cash>0 THEN 'REVENUE_CREDIT' ELSE 'REVENUE_REVERSAL' END,abs(cash),cash,0,-cash,NEW.id::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_revenue_effect_apply AFTER INSERT ON gds_revenue_effects FOR EACH ROW EXECUTE FUNCTION gds_revenue_effect_apply();
CREATE TRIGGER gds_revenue_effect_immutable BEFORE UPDATE OR DELETE ON gds_revenue_effects FOR EACH ROW EXECUTE FUNCTION gds_internal_journal_no_mutation();
REVOKE ALL ON FUNCTION gds_withdrawal_new(),gds_withdrawal_event_apply(),gds_extended_journal_apply(),gds_revenue_effect_apply() FROM PUBLIC;
