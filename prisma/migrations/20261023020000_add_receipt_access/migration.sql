-- Synthetic-only full access decisions remain separate from canonical payment/fulfillment.
ALTER TYPE course_access_source_type ADD VALUE IF NOT EXISTS 'unverified_receipt_access';
CREATE TABLE commerce_receipt_access_generations (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES commerce_orders(id),
 claim_id uuid NOT NULL REFERENCES commerce_bank_receipt_claims(id), buyer_id uuid NOT NULL REFERENCES users(id),
 created_by_id uuid NOT NULL REFERENCES users(id), generation integer NOT NULL CHECK(generation>0),
 status varchar(24) NOT NULL DEFAULT 'ACCESS_UNVERIFIED' CHECK(status IN('ACCESS_UNVERIFIED','REVOKED','VERIFIED_PAID')),
 access_starts_at timestamp(3) NOT NULL, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 closed_at timestamp(3), settlement_id uuid REFERENCES commerce_settlements(id), UNIQUE(order_id,generation),
 CHECK((status='ACCESS_UNVERIFIED' AND closed_at IS NULL AND settlement_id IS NULL)
 OR (status='REVOKED' AND closed_at IS NOT NULL AND settlement_id IS NULL)
 OR (status='VERIFIED_PAID' AND closed_at IS NOT NULL AND settlement_id IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_receipt_access_one_active_order ON commerce_receipt_access_generations(order_id) WHERE status='ACCESS_UNVERIFIED';
CREATE INDEX commerce_receipt_access_generations_buyer_id_status_idx ON commerce_receipt_access_generations(buyer_id,status);
CREATE TABLE commerce_receipt_access_effects (
 id uuid PRIMARY KEY, generation_id uuid NOT NULL REFERENCES commerce_receipt_access_generations(id),
 order_line_id uuid NOT NULL REFERENCES commerce_order_lines(id),
 effect_kind varchar(32) NOT NULL CHECK(effect_kind IN('COURSE_ACCESS','MEMBERSHIP_COURSE','MEMBERSHIP_GRACE','MEMBERSHIP_TERM','MEMBERSHIP_SERVICE')),
 resource_type varchar(32) NOT NULL CHECK(resource_type IN('course_access_grant','membership_subscription','service_entitlement_grant')),
 resource_id uuid NOT NULL UNIQUE, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX commerce_receipt_access_effects_generation_id_effect_kind_idx ON commerce_receipt_access_effects(generation_id,effect_kind);
CREATE TABLE commerce_receipt_access_events (
 id uuid PRIMARY KEY, generation_id uuid NOT NULL REFERENCES commerce_receipt_access_generations(id),
 actor_id uuid NOT NULL REFERENCES users(id), action varchar(24) NOT NULL CHECK(action IN('GRANTED','REVOKED','RESTORED','VERIFIED_PAID')),
 operation_key_hash varchar(64) NOT NULL CHECK(operation_key_hash ~ '^[a-f0-9]{64}$'),
 request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 reason_digest varchar(64) NOT NULL CHECK(reason_digest ~ '^[a-f0-9]{64}$'), reason varchar(300) NOT NULL CHECK(length(reason) BETWEEN 8 AND 300),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(actor_id,operation_key_hash)
);
CREATE FUNCTION receipt_access_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'receipt access ledger is append only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER receipt_access_effect_immutable BEFORE UPDATE OR DELETE ON commerce_receipt_access_effects FOR EACH ROW EXECUTE FUNCTION receipt_access_append_only();
CREATE TRIGGER receipt_access_event_immutable BEFORE UPDATE OR DELETE ON commerce_receipt_access_events FOR EACH ROW EXECUTE FUNCTION receipt_access_append_only();

CREATE FUNCTION receipt_access_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior commerce_receipt_access_generations%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'receipt access ledger is append only' USING ERRCODE='23514'; END IF;
 PERFORM id FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_bank_receipt_claims c ON c.order_id=o.id JOIN users u ON u.id=o.buyer_id
   WHERE o.id=NEW.order_id AND o.buyer_id=NEW.buyer_id AND c.id=NEW.claim_id AND c.buyer_id=NEW.buyer_id
   AND c.status='MATCHED_CLAIM' AND o.status='pending_payment' AND u.status='active' AND u.deleted_at IS NULL) THEN
   RAISE EXCEPTION 'receipt access owner must match pending order and matched claim' USING ERRCODE='23514'; END IF;
  SELECT * INTO prior FROM commerce_receipt_access_generations WHERE order_id=NEW.order_id ORDER BY generation DESC LIMIT 1;
  IF NEW.status<>'ACCESS_UNVERIFIED' OR NEW.generation<>coalesce(prior.generation,0)+1 THEN
   RAISE EXCEPTION 'invalid receipt access generation' USING ERRCODE='23514'; END IF;
  IF prior.id IS NULL THEN
   IF NEW.created_by_id<>NEW.buyer_id THEN RAISE EXCEPTION 'initial receipt access requires buyer' USING ERRCODE='23514'; END IF;
  ELSE
   IF prior.status<>'REVOKED' OR NEW.access_starts_at<>prior.access_starts_at OR NOT EXISTS(
    SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
    WHERE u.id=NEW.created_by_id AND u.status='active' AND u.deleted_at IS NULL AND r.name='platform_admin') THEN
    RAISE EXCEPTION 'receipt access restore requires revoked provenance and active admin' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF ROW(NEW.id,NEW.order_id,NEW.claim_id,NEW.buyer_id,NEW.created_by_id,NEW.generation,NEW.access_starts_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.claim_id,OLD.buyer_id,OLD.created_by_id,OLD.generation,OLD.access_starts_at,OLD.created_at) THEN
   RAISE EXCEPTION 'receipt access provenance is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status='ACCESS_UNVERIFIED' AND NEW.status IN('REVOKED','VERIFIED_PAID')) OR (OLD.status='REVOKED' AND NEW.status='VERIFIED_PAID')) THEN
   RAISE EXCEPTION 'invalid receipt access transition' USING ERRCODE='23514'; END IF;
  IF NEW.status=OLD.status AND ROW(NEW.closed_at,NEW.settlement_id) IS DISTINCT FROM ROW(OLD.closed_at,OLD.settlement_id) THEN
   RAISE EXCEPTION 'receipt access closure is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status='VERIFIED_PAID' AND NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_settlements s ON s.id=o.confirmed_settlement_id
   WHERE o.id=NEW.order_id AND o.status='confirmed' AND s.id=NEW.settlement_id AND s.order_id=o.id AND s.kind='provider_collection'
   AND s.disposition='matched' AND s.amount_minor=o.payable_amount_minor AND s.currency=o.currency) THEN
   RAISE EXCEPTION 'receipt verified access requires canonical settlement' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER receipt_access_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce_receipt_access_generations FOR EACH ROW EXECUTE FUNCTION receipt_access_generation_guard();

CREATE FUNCTION receipt_access_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g commerce_receipt_access_generations%ROWTYPE; line commerce_order_lines%ROWTYPE; source text;
BEGIN
 SELECT * INTO g FROM commerce_receipt_access_generations WHERE id=NEW.generation_id;
 SELECT * INTO line FROM commerce_order_lines WHERE id=NEW.order_line_id;
 IF g.status<>'ACCESS_UNVERIFIED' OR line.order_id IS DISTINCT FROM g.order_id THEN
  RAISE EXCEPTION 'receipt effect must bind active generation and exact order line' USING ERRCODE='23514'; END IF;
 source:=g.id::text||':'||line.id::text;
 IF NEW.effect_kind='MEMBERSHIP_GRACE' THEN source:=source||':grace'; END IF;
 IF NEW.resource_type='course_access_grant' AND NEW.effect_kind IN('COURSE_ACCESS','MEMBERSHIP_COURSE','MEMBERSHIP_GRACE') THEN
  IF (NEW.effect_kind='COURSE_ACCESS' AND line.product_type<>'course') OR (NEW.effect_kind<>'COURSE_ACCESS' AND line.product_type<>'membership')
   OR NOT EXISTS(SELECT 1 FROM course_access_grants c WHERE c.id=NEW.resource_id AND c.user_id=g.buyer_id
   AND c.source_type::text='unverified_receipt_access' AND c.source_id=source AND c.status='active'
   AND (NEW.effect_kind<>'COURSE_ACCESS' OR c.course_id=line.product_reference_id)) THEN
   RAISE EXCEPTION 'receipt course effect requires exact unverified resource' USING ERRCODE='23514'; END IF;
 ELSIF NEW.resource_type='membership_subscription' AND NEW.effect_kind='MEMBERSHIP_TERM' AND line.product_type='membership' THEN
  IF NOT EXISTS(SELECT 1 FROM membership_subscriptions s WHERE s.id=NEW.resource_id AND s.user_id=g.buyer_id AND s.source_order_line_id IS NULL AND s.status='active') THEN
   RAISE EXCEPTION 'receipt membership effect requires isolated subscription' USING ERRCODE='23514'; END IF;
 ELSIF NEW.resource_type='service_entitlement_grant' AND NEW.effect_kind='MEMBERSHIP_SERVICE' AND line.product_type='membership' THEN
  IF NOT EXISTS(SELECT 1 FROM service_entitlement_grants s WHERE s.id=NEW.resource_id AND s.user_id=g.buyer_id AND s.source_type='UNVERIFIED_RECEIPT_ACCESS' AND s.source_id=source AND s.status='active') THEN
   RAISE EXCEPTION 'receipt service effect requires exact unverified resource' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'unsupported receipt effect resource' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER receipt_access_effect_guard BEFORE INSERT ON commerce_receipt_access_effects FOR EACH ROW EXECUTE FUNCTION receipt_access_effect_guard();

CREATE FUNCTION receipt_access_require_grant_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource text; expected_source text;
BEGIN
 IF TG_TABLE_NAME='course_access_grants' THEN
  IF NEW.source_type::text<>'unverified_receipt_access' THEN RETURN NEW; END IF;
  resource:='course_access_grant';
 ELSE
  IF NEW.source_type<>'UNVERIFIED_RECEIPT_ACCESS' THEN RETURN NEW; END IF;
  resource:='service_entitlement_grant';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_receipt_access_effects e JOIN commerce_receipt_access_generations g ON g.id=e.generation_id
  WHERE e.resource_type=resource AND e.resource_id=NEW.id AND g.buyer_id=NEW.user_id
  AND NEW.source_id=g.id::text||':'||e.order_line_id::text||CASE WHEN e.effect_kind='MEMBERSHIP_GRACE' THEN ':grace' ELSE '' END) THEN
  RAISE EXCEPTION 'unverified receipt grant requires exact access ledger' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER receipt_course_grant_ledger AFTER INSERT ON course_access_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receipt_access_require_grant_ledger();
CREATE CONSTRAINT TRIGGER receipt_service_grant_ledger AFTER INSERT ON service_entitlement_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receipt_access_require_grant_ledger();
