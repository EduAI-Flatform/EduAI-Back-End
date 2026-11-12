-- Source-only adapter; does not enable withdrawal processing or admission.
CREATE TABLE affiliate_wallet_effects (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), accrual_id UUID NOT NULL UNIQUE REFERENCES affiliate_accruals(id) ON DELETE RESTRICT,
 wallet_id UUID NOT NULL REFERENCES gds_internal_wallets(id) ON DELETE RESTRICT,
 delta_minor BIGINT NOT NULL CHECK(delta_minor<>0), available_delta_minor BIGINT NOT NULL, debt_delta_minor BIGINT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(available_delta_minor-debt_delta_minor=delta_minor)
);
CREATE FUNCTION affiliate_wallet_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(73410201); RETURN NEW; END $$;
CREATE TRIGGER affiliate_wallet_lock BEFORE INSERT ON affiliate_wallet_effects FOR EACH ROW EXECUTE FUNCTION affiliate_wallet_lock();
CREATE TRIGGER affiliate_wallet_effect_immutable BEFORE UPDATE OR DELETE ON affiliate_wallet_effects FOR EACH ROW EXECUTE FUNCTION affiliate_immutable_record();
CREATE FUNCTION affiliate_wallet_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; r RECORD; w RECORD; o RECORD; p JSONB; settled RECORD;
 net BIGINT; refunded BIGINT; allocated BIGINT; basis BIGINT; capacity BIGINT; target BIGINT; applied BIGINT; delta BIGINT; cash BIGINT; debt BIGINT;
BEGIN
 SELECT * INTO a FROM public.affiliate_accruals WHERE id=NEW.accrual_id;
 SELECT at.*,i.owner_id,pr.content,pr.status AS policy_status,pr.effective_at,pr."group" AS policy_group
 INTO r FROM public.affiliate_attributions at JOIN public.affiliate_identities i ON i.id=at.identity_id
 JOIN public.platform_policy_revisions pr ON pr.id=at.policy_revision_id WHERE at.id=a.attribution_id;
 p:=r.content;
 IF NOT FOUND OR r.buyer_id=r.owner_id OR r.policy_group<>'affiliate' OR r.policy_status<>'scheduled' OR r.effective_at IS NULL OR r.effective_at>r.created_at
  OR p->>'fundingSource' IS DISTINCT FROM 'platform_fee' OR p->>'allocationPrecedence' IS DISTINCT FROM 'seller_entitlements_first'
  OR p->>'currency' IS DISTINCT FROM 'VND' OR p->>'commissionBase' IS DISTINCT FROM 'net_paid_after_recorded_refunds'
  OR p->>'attributionModel' IS DISTINCT FROM 'first_touch' OR p->>'enabled' IS DISTINCT FROM 'true'
  OR p->>'subAffiliateEnabled' IS DISTINCT FROM 'false'
  OR (NEW.delta_minor>0 AND NOT EXISTS(SELECT 1 FROM public.gds_withdrawal_settings WHERE id='global' AND processing_enabled))
 THEN RAISE EXCEPTION 'Affiliate wallet funding or processing unavailable'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=r.order_id;
 SELECT * INTO settled FROM public.commerce_settlements WHERE id=o.confirmed_settlement_id;
 IF o.status<>'confirmed' OR o.fulfillment_status<>'fulfilled' OR o.currency<>'VND'
  OR settled.id IS NULL OR settled.order_id<>o.id OR settled.amount_minor<>o.payable_amount_minor OR settled.currency<>'VND'
  OR settled.settled_at<r.created_at OR settled.settled_at>clock_timestamp() OR settled.disposition NOT IN ('matched','internal')
  OR a.hold_until<>settled.settled_at+((p->>'holdDays')::integer*INTERVAL '1 day') OR a.hold_until>clock_timestamp()
 THEN RAISE EXCEPTION 'Affiliate wallet settlement or hold invalid'; END IF;
 SELECT COALESCE(sum(amount_minor),0) INTO refunded FROM public.commerce_refunds
 WHERE order_id=o.id AND settlement_id=settled.id AND status='recorded' AND recorded_at<=clock_timestamp() AND currency='VND';
 net:=o.payable_amount_minor-refunded;
 SELECT COALESCE(sum(s.basis_amount_minor),0),COALESCE(sum(x.refunded),0),
 COALESCE(sum(CASE WHEN s.basis_amount_minor=0 THEN 0 ELSE floor(s.platform_amount_minor::numeric*(s.basis_amount_minor-x.refunded)/s.basis_amount_minor)::bigint END),0)
 INTO basis,allocated,capacity FROM public.revenue_order_snapshots s
 CROSS JOIN LATERAL (SELECT COALESCE(sum(ra.amount_minor),0) AS refunded FROM public.commerce_refund_allocations ra
 JOIN public.commerce_refunds rf ON rf.id=ra.refund_id WHERE ra.order_line_id=s.id AND rf.status='recorded'
 AND rf.settlement_id=settled.id AND rf.recorded_at<=clock_timestamp()) x WHERE s.order_id=o.id;
 IF basis<>o.payable_amount_minor OR allocated<>refunded OR net<0 OR capacity<0
  OR EXISTS(SELECT 1 FROM public.revenue_order_snapshots s WHERE s.order_id=o.id AND
    (SELECT COALESCE(sum(ra.amount_minor),0) FROM public.commerce_refund_allocations ra JOIN public.commerce_refunds rf ON rf.id=ra.refund_id
      WHERE ra.order_line_id=s.id AND rf.status='recorded' AND rf.settlement_id=settled.id AND rf.recorded_at<=clock_timestamp())>s.basis_amount_minor)
  OR EXISTS(SELECT 1 FROM public.revenue_order_snapshots WHERE order_id=o.id AND basis_amount_minor<>platform_amount_minor+seller_amount_minor)
  OR a.currency<>'VND' OR a.commission_bps<>(p->>'commissionBps')::integer OR a.qualifying_amount_minor<>net
 THEN RAISE EXCEPTION 'Affiliate wallet allocation source invalid'; END IF;
 target:=floor(net::numeric*a.commission_bps/10000)::bigint;
 IF (SELECT COALESCE(sum(delta_minor),0) FROM public.affiliate_accruals WHERE attribution_id=r.id)<>target
 THEN RAISE EXCEPTION 'Affiliate wallet accrual history mismatch'; END IF;
 SELECT COALESCE(sum(e.delta_minor),0) INTO applied FROM public.affiliate_wallet_effects e
 JOIN public.affiliate_accruals ac ON ac.id=e.accrual_id WHERE ac.attribution_id=r.id AND e.id<>NEW.id;
 IF target>capacity AND LEAST(target,capacity)>=applied THEN RAISE EXCEPTION 'AFFILIATE_PLATFORM_FEE_INSUFFICIENT'; END IF;
 target:=LEAST(target,capacity); delta:=target-applied;
 SELECT * INTO w FROM public.gds_internal_wallets WHERE id=NEW.wallet_id FOR UPDATE;
 IF NOT FOUND OR w.buyer_id<>r.owner_id THEN RAISE EXCEPTION 'Affiliate wallet owner mismatch'; END IF;
 IF delta>0 THEN debt:=-LEAST(delta,w.debt_minor); cash:=delta+debt;
 ELSE cash:=-LEAST(-delta,w.available_minor); debt:=-delta+cash; END IF;
 IF NEW.delta_minor<>delta OR NEW.available_delta_minor<>cash OR NEW.debt_delta_minor<>debt THEN RAISE EXCEPTION 'Affiliate wallet posting mismatch'; END IF;
 UPDATE public.gds_internal_wallets SET debt_minor=debt_minor+debt WHERE id=w.id;
 IF cash<>0 THEN
 INSERT INTO public.gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
 VALUES(w.id,'gds:affiliate:'||NEW.id,CASE WHEN cash>0 THEN 'REVENUE_CREDIT' ELSE 'REVENUE_REVERSAL' END,abs(cash),cash,0,-cash,NEW.id::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER affiliate_wallet_apply AFTER INSERT ON affiliate_wallet_effects FOR EACH ROW EXECUTE FUNCTION affiliate_wallet_apply();

-- Existing withdrawal/revenue checks are preserved; affiliate receipts extend the same journal.
CREATE OR REPLACE FUNCTION gds_extended_journal_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r RECORD;
BEGIN
 IF NEW.kind LIKE 'WITHDRAWAL_%' THEN
 SELECT * INTO r FROM public.gds_withdrawals WHERE id::text=NEW.order_ref FOR UPDATE;
 IF NOT FOUND OR r.wallet_id<>NEW.wallet_id OR r.amount_minor<>NEW.amount_minor OR
 (NEW.kind='WITHDRAWAL_RESERVE' AND r.status<>'PENDING') OR
 (NEW.kind='WITHDRAWAL_RELEASE' AND r.status NOT IN ('CANCELLED','REJECTED','FAILED')) OR
 (NEW.kind='WITHDRAWAL_PAID' AND r.status<>'PAID') THEN RAISE EXCEPTION 'GDS withdrawal journal missing or mismatched source'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.gds_revenue_effects e JOIN public.gds_revenue_projections p ON p.id=e.projection_id
 WHERE e.id::text=NEW.order_ref AND p.wallet_id=NEW.wallet_id AND e.available_delta_minor=NEW.available_delta_minor AND NEW.event_key='gds:revenue:'||e.id::text)
 AND NOT EXISTS(SELECT 1 FROM public.affiliate_wallet_effects e WHERE e.id::text=NEW.order_ref AND e.wallet_id=NEW.wallet_id
 AND e.available_delta_minor=NEW.available_delta_minor AND NEW.event_key='gds:affiliate:'||e.id::text)
 THEN RAISE EXCEPTION 'GDS revenue journal missing or mismatched source'; END IF;
 END IF;
 UPDATE public.gds_internal_wallets SET available_minor=available_minor+NEW.available_delta_minor,
 held_minor=held_minor+NEW.held_delta_minor,updated_at=CURRENT_TIMESTAMP WHERE id=NEW.wallet_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'GDS wallet missing'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION affiliate_wallet_apply(),affiliate_wallet_lock() FROM PUBLIC;

-- Refund debt must block new spend as well as withdrawals. RELEASE remains allowed.
CREATE FUNCTION gds_spending_debt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debt BIGINT;
BEGIN
 SELECT debt_minor INTO debt FROM public.gds_internal_wallets WHERE id=NEW.wallet_id FOR UPDATE;
 IF debt IS NULL OR debt<>0 THEN RAISE EXCEPTION 'GDS_SPENDING_DEBT_BLOCKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_spending_debt_guard BEFORE INSERT ON gds_internal_journal FOR EACH ROW
 WHEN (NEW.kind IN ('RESERVE','CAPTURE')) EXECUTE FUNCTION gds_spending_debt_guard();
REVOKE ALL ON FUNCTION gds_spending_debt_guard() FROM PUBLIC;
