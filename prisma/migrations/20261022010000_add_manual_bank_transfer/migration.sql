-- Additive PAYW-01 sandbox infrastructure. No production activation or data backfill.
CREATE TABLE commerce_bank_transfer_requests (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES commerce_orders(id),
 payment_attempt_id uuid NOT NULL UNIQUE REFERENCES commerce_payment_attempts(id),
 bank_name varchar(80) NOT NULL, bank_bin varchar(6) NOT NULL,
 account_number varchar(19) NOT NULL, beneficiary_name varchar(160) NOT NULL,
 transfer_content varchar(25) NOT NULL UNIQUE, amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 status varchar(24) NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','UNDER_REVIEW','NEEDS_SUPPORT','PAID','CANCELLED','EXPIRED')),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at timestamp(3) NOT NULL,
 CHECK(expires_at > created_at), CHECK(account_number = '0000000000' AND bank_bin = '970422')
);
CREATE TABLE commerce_bank_statement_evidence (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES commerce_bank_transfer_requests(id),
 bank_bin varchar(6) NOT NULL, account_number varchar(19) NOT NULL,
 transaction_id varchar(100) NOT NULL CHECK(transaction_id ~ '^[A-Z0-9._:-]{1,100}$'),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), transfer_content varchar(160) NOT NULL,
 occurred_at timestamp(3) NOT NULL, statement_reference varchar(160) NOT NULL,
 statement_sha256 varchar(64) NOT NULL CHECK(statement_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_by_id uuid NOT NULL REFERENCES users(id), recorded_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 exception_reason varchar(40), UNIQUE(bank_bin, account_number, transaction_id)
);
CREATE INDEX commerce_bank_statement_evidence_request_id_idx ON commerce_bank_statement_evidence(request_id);
CREATE TABLE commerce_bank_approvals (
 evidence_id uuid NOT NULL REFERENCES commerce_bank_statement_evidence(id),
 actor_id uuid NOT NULL REFERENCES users(id), approved_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(evidence_id, actor_id)
);
CREATE TABLE commerce_bank_support_requests (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES commerce_bank_transfer_requests(id),
 actor_id uuid NOT NULL REFERENCES users(id), reason varchar(300) NOT NULL CHECK(length(reason) BETWEEN 8 AND 300),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, operation_key_hash varchar(64) NOT NULL,
 UNIQUE(actor_id,operation_key_hash)
);
CREATE INDEX commerce_bank_support_requests_request_id_idx ON commerce_bank_support_requests(request_id);
CREATE FUNCTION commerce_bank_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'bank financial evidence is append only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER bank_statement_immutable BEFORE UPDATE OR DELETE ON commerce_bank_statement_evidence
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_append_only();
CREATE TRIGGER bank_approval_immutable BEFORE UPDATE OR DELETE ON commerce_bank_approvals
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_append_only();
CREATE TRIGGER bank_support_immutable BEFORE UPDATE OR DELETE ON commerce_bank_support_requests
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_append_only();
CREATE FUNCTION commerce_bank_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank requests cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.order_id,NEW.payment_attempt_id,NEW.bank_name,NEW.bank_bin,NEW.account_number,
 NEW.beneficiary_name,NEW.transfer_content,NEW.amount_minor,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.payment_attempt_id,OLD.bank_name,OLD.bank_bin,OLD.account_number,
 OLD.beneficiary_name,OLD.transfer_content,OLD.amount_minor,OLD.created_at,OLD.expires_at) THEN
 RAISE EXCEPTION 'bank request snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
 OLD.status IN('PENDING','UNDER_REVIEW','NEEDS_SUPPORT') AND NEW.status IN('UNDER_REVIEW','NEEDS_SUPPORT','PAID','EXPIRED','CANCELLED')) THEN
 RAISE EXCEPTION 'invalid bank request transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='PAID' AND NOT EXISTS(SELECT 1 FROM commerce_settlements s WHERE s.payment_attempt_id=NEW.payment_attempt_id
 AND s.provider='bank_transfer' AND s.disposition='matched') THEN
 RAISE EXCEPTION 'paid bank request requires canonical settlement' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_request_immutable BEFORE UPDATE OR DELETE ON commerce_bank_transfer_requests
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_request_guard();
CREATE FUNCTION commerce_bank_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'PENDING' OR NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id
 WHERE a.id=NEW.payment_attempt_id AND a.order_id=NEW.order_id AND a.provider='bank_transfer' AND a.status='pending'
 AND a.amount_minor=NEW.amount_minor AND a.currency='VND' AND o.status='pending_payment'
 AND o.payable_amount_minor=NEW.amount_minor AND a.provider_payment_identity=NEW.id::text) THEN
 RAISE EXCEPTION 'bank request must bind pending matching attempt and order' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_request_initial_state BEFORE INSERT ON commerce_bank_transfer_requests
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_request_insert();
CREATE FUNCTION commerce_bank_validate_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.provider = 'bank_transfer' AND NOT EXISTS (
 SELECT 1 FROM commerce_bank_transfer_requests r
 JOIN commerce_bank_statement_evidence e ON e.request_id=r.id
 JOIN commerce_payment_attempts a ON a.id=r.payment_attempt_id
 JOIN commerce_payment_events event ON event.id=NEW.payment_event_id
 JOIN commerce_orders o ON o.id=r.order_id
 WHERE r.order_id=NEW.order_id AND r.payment_attempt_id=NEW.payment_attempt_id
 AND r.status='UNDER_REVIEW' AND r.expires_at>CURRENT_TIMESTAMP AND o.status='pending_payment'
 AND o.payable_amount_minor=r.amount_minor AND o.confirmed_settlement_id IS NULL
 AND e.id::text=NEW.provider_settlement_reference AND e.exception_reason IS NULL
 AND e.bank_bin=r.bank_bin AND e.account_number=r.account_number
 AND e.amount_minor=r.amount_minor AND NEW.amount_minor=r.amount_minor
 AND e.transfer_content=r.transfer_content AND e.occurred_at>=r.created_at AND e.occurred_at<r.expires_at
 AND e.occurred_at<=e.recorded_at AND e.recorded_at<=CURRENT_TIMESTAMP
 AND a.provider='bank_transfer' AND a.order_id=r.order_id AND a.status='pending'
 AND a.amount_minor=r.amount_minor AND a.currency='VND'
 AND event.provider='bank_transfer' AND event.payment_attempt_id=a.id
 AND event.provider_settlement_reference=e.id::text AND event.amount_minor=e.amount_minor
 AND event.next_status='paid' AND event.provider_occurred_at=e.occurred_at
 AND NEW.settled_at=e.occurred_at
 AND NEW.kind='provider_collection' AND NEW.disposition='matched' AND NEW.currency='VND'
 AND (SELECT count(DISTINCT p.actor_id) FROM commerce_bank_approvals p JOIN users u ON u.id=p.actor_id
 JOIN user_roles ur ON ur.user_id=u.id JOIN roles role ON role.id=ur.role_id
 WHERE p.evidence_id=e.id AND u.status='active' AND u.deleted_at IS NULL AND role.name='platform_admin')>=2
 ) THEN RAISE EXCEPTION 'bank settlement requires matching dual approved statement evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_settlement_provenance BEFORE INSERT ON commerce_settlements
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_validate_settlement();

CREATE FUNCTION commerce_bank_approval_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles role ON role.id=ur.role_id
 WHERE u.id=NEW.actor_id AND u.status='active' AND u.deleted_at IS NULL AND role.name='platform_admin') THEN
 RAISE EXCEPTION 'bank approval requires active platform admin' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_approval_authority BEFORE INSERT ON commerce_bank_approvals
 FOR EACH ROW EXECUTE FUNCTION commerce_bank_approval_authority();
