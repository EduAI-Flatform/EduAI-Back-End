-- Synthetic-only non-financial intake; existing settlement controls remain unchanged.
CREATE TABLE commerce_bank_receipt_claims (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES commerce_bank_transfer_requests(id),
 order_id uuid NOT NULL REFERENCES commerce_orders(id), buyer_id uuid NOT NULL REFERENCES users(id),
 operation_key_hash varchar(64) NOT NULL CHECK(operation_key_hash ~ '^[a-f0-9]{64}$'),
 original_sha256 varchar(64) NOT NULL UNIQUE CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 image_sha256 varchar(64) NOT NULL UNIQUE CHECK(image_sha256 ~ '^[a-f0-9]{64}$'),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 8192), height integer NOT NULL CHECK(height BETWEEN 1 AND 8192),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 5242880), CHECK(width::bigint*height<=12000000),
 status varchar(24) NOT NULL DEFAULT 'PROCESSING' CHECK(status IN('PROCESSING','MATCHED_CLAIM','REVIEW_REQUIRED','OCR_FAILED')),
 fields_json jsonb, warnings text[] NOT NULL DEFAULT '{}', confidence integer CHECK(confidence BETWEEN 0 AND 100),
 transaction_key_hash varchar(64) UNIQUE CHECK(transaction_key_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, processing_expires_at timestamp(3) NOT NULL,
 assessed_at timestamp(3), expires_at timestamp(3) NOT NULL, image_deleted_at timestamp(3),
 UNIQUE(buyer_id,operation_key_hash),
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '24 hours'),
 CHECK(processing_expires_at>created_at AND processing_expires_at<=created_at+INTERVAL '5 minutes'),
 CHECK((status='PROCESSING' AND assessed_at IS NULL) OR (status<>'PROCESSING' AND assessed_at IS NOT NULL)),
 CHECK(fields_json IS NULL OR jsonb_typeof(fields_json)='object'),
 CHECK(status<>'MATCHED_CLAIM' OR (confidence IS NOT NULL AND confidence>=70 AND fields_json IS NOT NULL)),
 CHECK(image_deleted_at IS NULL OR image_deleted_at>=created_at)
);
CREATE INDEX commerce_bank_receipt_claims_order_id_created_at_idx ON commerce_bank_receipt_claims(order_id,created_at);
CREATE INDEX commerce_bank_receipt_claims_expires_at_image_deleted_at_idx ON commerce_bank_receipt_claims(expires_at,image_deleted_at);
CREATE FUNCTION commerce_bank_receipt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN users u ON u.id=o.buyer_id
 JOIN commerce_bank_transfer_requests r ON r.order_id=o.id WHERE o.id=NEW.order_id AND o.buyer_id=NEW.buyer_id
 AND r.id=NEW.request_id AND u.status='active' AND u.deleted_at IS NULL) THEN
 RAISE EXCEPTION 'receipt owner must match active order buyer' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_bank_transfer_requests r ON r.order_id=o.id
 WHERE o.id=NEW.order_id AND o.status='pending_payment' AND r.status IN('PENDING','UNDER_REVIEW','NEEDS_SUPPORT') AND r.expires_at>CURRENT_TIMESTAMP) THEN
 RAISE EXCEPTION 'receipt requires pending unexpired bank request' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM commerce_bank_receipt_claims WHERE order_id=NEW.order_id)>=3 THEN
 RAISE EXCEPTION 'receipt upload limit reached' USING ERRCODE='23514'; END IF;
 IF NEW.status<>'PROCESSING' OR NEW.fields_json IS NOT NULL OR NEW.confidence IS NOT NULL
 OR cardinality(NEW.warnings)<>0 OR NEW.transaction_key_hash IS NOT NULL OR NEW.image_deleted_at IS NOT NULL THEN
 RAISE EXCEPTION 'receipt must start unassessed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_receipt_insert BEFORE INSERT ON commerce_bank_receipt_claims FOR EACH ROW EXECUTE FUNCTION commerce_bank_receipt_insert_guard();
CREATE FUNCTION commerce_bank_receipt_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'receipt metadata is append only' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.request_id,NEW.order_id,NEW.buyer_id,NEW.operation_key_hash,NEW.original_sha256,NEW.image_sha256,
 NEW.width,NEW.height,NEW.bytes,NEW.created_at,NEW.expires_at,NEW.processing_expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.request_id,OLD.order_id,OLD.buyer_id,OLD.operation_key_hash,OLD.original_sha256,OLD.image_sha256,
 OLD.width,OLD.height,OLD.bytes,OLD.created_at,OLD.expires_at,OLD.processing_expires_at) THEN
 RAISE EXCEPTION 'receipt identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'PROCESSING' AND ROW(NEW.status,NEW.fields_json,NEW.warnings,NEW.confidence,NEW.transaction_key_hash,NEW.assessed_at)
 IS DISTINCT FROM ROW(OLD.status,OLD.fields_json,OLD.warnings,OLD.confidence,OLD.transaction_key_hash,OLD.assessed_at) THEN
 RAISE EXCEPTION 'receipt assessment is terminal' USING ERRCODE='23514'; END IF;
 IF OLD.status='PROCESSING' AND NEW.status='PROCESSING' AND ROW(NEW.fields_json,NEW.warnings,NEW.confidence,NEW.transaction_key_hash)
 IS DISTINCT FROM ROW(OLD.fields_json,OLD.warnings,OLD.confidence,OLD.transaction_key_hash) THEN
 RAISE EXCEPTION 'receipt assessment requires terminal state' USING ERRCODE='23514'; END IF;
 IF OLD.image_deleted_at IS NOT NULL AND NEW.image_deleted_at IS DISTINCT FROM OLD.image_deleted_at THEN
 RAISE EXCEPTION 'receipt image deletion is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bank_receipt_immutable BEFORE UPDATE OR DELETE ON commerce_bank_receipt_claims FOR EACH ROW EXECUTE FUNCTION commerce_bank_receipt_change_guard();
