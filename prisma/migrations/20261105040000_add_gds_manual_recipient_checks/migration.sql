-- Explicit admin checks are distinct from provider lookup. No balance or snapshot updates.
ALTER TABLE gds_account_verifications DROP CONSTRAINT gds_account_verifications_provider_check;
ALTER TABLE gds_account_verifications ADD CONSTRAINT gds_account_verifications_provider_check
 CHECK (provider='vietqr' OR (provider='admin_manual' AND purpose='TRANSFER'));

CREATE OR REPLACE FUNCTION gds_account_verification_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.verified_at>clock_timestamp()+INTERVAL '1 second' OR NEW.expires_at<=clock_timestamp()
  OR NEW.normalized_account_holder<>gds_normalize_bank_name(NEW.account_holder)
 THEN RAISE EXCEPTION 'GDS verification time or name invalid'; END IF;
 IF NEW.purpose='TRANSFER' AND NOT EXISTS(SELECT 1 FROM gds_withdrawals r WHERE r.id=NEW.withdrawal_id
  AND r.owner_id=NEW.owner_id AND r.bank_code=NEW.bank_code AND r.account_number=NEW.account_number
  AND gds_normalize_bank_name(r.account_holder)=NEW.normalized_account_holder
  AND r.status IN ('PENDING','APPROVED','PROCESSING')
  AND (r.status<>'PROCESSING' OR r.processing_admin_id=NEW.actor_id)
  AND (NEW.provider<>'admin_manual' OR (r.verification_id IS NULL AND
    NOT (SELECT account_verification_required FROM gds_withdrawal_settings WHERE id='global'))))
 THEN RAISE EXCEPTION 'GDS verification request mismatch'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION gds_withdrawal_transfer_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.to_status='PROCESSING' AND NOT EXISTS(
   SELECT 1 FROM gds_account_verifications p JOIN gds_withdrawals r ON r.id=p.withdrawal_id
   WHERE r.id=NEW.withdrawal_id AND p.purpose='TRANSFER' AND p.actor_id=NEW.actor_id AND p.owner_id=r.owner_id
    AND p.bank_code=r.bank_code AND p.account_number=r.account_number AND p.expires_at>clock_timestamp()
    AND p.normalized_account_holder=gds_normalize_bank_name(r.account_holder)
    AND (p.provider='vietqr' OR (p.provider='admin_manual' AND r.verification_id IS NULL
      AND NOT (SELECT account_verification_required FROM gds_withdrawal_settings WHERE id='global'))))
 THEN RAISE EXCEPTION 'GDS transfer recipient requires fresh matching verification'; END IF;
 RETURN NEW;
END $$;
