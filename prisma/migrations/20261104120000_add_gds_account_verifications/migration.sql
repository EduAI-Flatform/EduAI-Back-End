-- Additive/source release. Mandatory lookup stays OFF until provider rights and UAT pass.
ALTER TABLE gds_withdrawal_settings ADD COLUMN account_verification_required BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE gds_account_verifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 bank_code VARCHAR(32) NOT NULL CHECK(bank_code ~ '^[A-Za-z0-9_-]{2,32}$'),
 bank_bin VARCHAR(6) NOT NULL CHECK(bank_bin ~ '^[0-9]{6}$'),
 bank_name VARCHAR(200) NOT NULL, bank_short_name VARCHAR(80) NOT NULL,
 account_number VARCHAR(34) NOT NULL CHECK(account_number ~ '^[0-9]{6,34}$'),
 account_holder VARCHAR(160) NOT NULL CHECK(length(trim(account_holder)) BETWEEN 2 AND 160),
 normalized_account_holder VARCHAR(160) NOT NULL CHECK(length(normalized_account_holder)>0),
 provider VARCHAR(24) NOT NULL CHECK(provider='vietqr'), provider_reference VARCHAR(160),
 purpose VARCHAR(16) NOT NULL CHECK(purpose IN ('CREATE','TRANSFER')),
 withdrawal_id UUID REFERENCES gds_withdrawals(id) ON DELETE RESTRICT,
 verified_at TIMESTAMP(3) NOT NULL, expires_at TIMESTAMP(3) NOT NULL,
 CHECK(expires_at>verified_at AND expires_at<=verified_at+INTERVAL '15 minutes'),
 CHECK((purpose='CREATE' AND withdrawal_id IS NULL AND owner_id=actor_id) OR (purpose='TRANSFER' AND withdrawal_id IS NOT NULL AND actor_id<>owner_id))
);
CREATE INDEX gds_account_verification_withdrawal_idx ON gds_account_verifications(withdrawal_id,expires_at);
CREATE INDEX gds_account_verification_owner_idx ON gds_account_verifications(owner_id,expires_at);
ALTER TABLE gds_withdrawals ADD COLUMN verification_id UUID UNIQUE REFERENCES gds_account_verifications(id) ON DELETE RESTRICT,
 ADD COLUMN bank_bin VARCHAR(6), ADD COLUMN bank_name VARCHAR(200), ADD COLUMN bank_short_name VARCHAR(80), ADD COLUMN account_verified_at TIMESTAMP(3);
CREATE TRIGGER gds_account_verification_immutable BEFORE UPDATE OR DELETE ON gds_account_verifications FOR EACH ROW EXECUTE FUNCTION gds_internal_journal_no_mutation();

CREATE FUNCTION gds_normalize_bank_name(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT trim(upper(regexp_replace(translate(normalize(trim(value), NFC),
 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD'), '\s+', ' ', 'g')));
$$;
CREATE FUNCTION gds_account_verification_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.verified_at>clock_timestamp()+INTERVAL '1 second' OR NEW.expires_at<=clock_timestamp()
  OR NEW.normalized_account_holder<>gds_normalize_bank_name(NEW.account_holder)
 THEN RAISE EXCEPTION 'GDS verification time or name invalid'; END IF;
 IF NEW.purpose='TRANSFER' AND NOT EXISTS(SELECT 1 FROM gds_withdrawals r WHERE r.id=NEW.withdrawal_id
  AND r.owner_id=NEW.owner_id AND r.bank_code=NEW.bank_code AND r.account_number=NEW.account_number
  AND gds_normalize_bank_name(r.account_holder)=NEW.normalized_account_holder
  AND r.status IN ('PENDING','APPROVED','PROCESSING')) THEN RAISE EXCEPTION 'GDS verification request mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_account_verification_source_guard BEFORE INSERT ON gds_account_verifications FOR EACH ROW EXECUTE FUNCTION gds_account_verification_source_guard();
CREATE FUNCTION gds_withdrawal_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof RECORD;
BEGIN
 IF NEW.verification_id IS NULL THEN
  IF (SELECT account_verification_required FROM gds_withdrawal_settings WHERE id='global') THEN
   RAISE EXCEPTION 'GDS recipient verification required'; END IF;
  IF NEW.bank_bin IS NOT NULL OR NEW.bank_name IS NOT NULL OR NEW.bank_short_name IS NOT NULL OR NEW.account_verified_at IS NOT NULL THEN RAISE EXCEPTION 'GDS verification snapshot without proof'; END IF;
 ELSE
  -- Proof rows are immutable; no row lock or runtime UPDATE privilege is needed.
  SELECT * INTO proof FROM gds_account_verifications WHERE id=NEW.verification_id;
  IF NOT FOUND OR proof.purpose<>'CREATE' OR proof.owner_id<>NEW.owner_id OR proof.actor_id<>NEW.owner_id
   OR proof.bank_code<>NEW.bank_code OR proof.account_number<>NEW.account_number OR proof.account_holder<>NEW.account_holder
   OR proof.expires_at<=clock_timestamp() OR proof.bank_bin IS DISTINCT FROM NEW.bank_bin
   OR proof.bank_name IS DISTINCT FROM NEW.bank_name OR proof.bank_short_name IS DISTINCT FROM NEW.bank_short_name
   OR proof.verified_at IS DISTINCT FROM NEW.account_verified_at THEN RAISE EXCEPTION 'GDS recipient verification binding invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_verification_guard BEFORE INSERT ON gds_withdrawals FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_verification_guard();
CREATE FUNCTION gds_withdrawal_transfer_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.to_status='PROCESSING' AND ((SELECT account_verification_required FROM gds_withdrawal_settings WHERE id='global') OR
  EXISTS(SELECT 1 FROM gds_withdrawals WHERE id=NEW.withdrawal_id AND verification_id IS NOT NULL)) AND
  NOT EXISTS(SELECT 1 FROM gds_account_verifications p JOIN gds_withdrawals r ON r.id=p.withdrawal_id
   WHERE r.id=NEW.withdrawal_id AND p.purpose='TRANSFER' AND p.actor_id=NEW.actor_id AND p.owner_id=r.owner_id
    AND p.bank_code=r.bank_code AND p.account_number=r.account_number AND p.expires_at>clock_timestamp()
    AND p.normalized_account_holder=gds_normalize_bank_name(r.account_holder))
  THEN RAISE EXCEPTION 'GDS transfer recipient requires fresh matching verification'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gds_withdrawal_transfer_verification_guard BEFORE INSERT ON gds_withdrawal_events FOR EACH ROW EXECUTE FUNCTION gds_withdrawal_transfer_verification_guard();
