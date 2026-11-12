-- Additive provenance only. Does not enable accrual or alter existing point history.
CREATE TABLE point_activity_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('course.completed')),
  source_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  policy_revision_id UUID NOT NULL REFERENCES platform_policy_revisions(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK(outcome IN ('awarded','disabled','no_rule','daily_cap','expired_before_award')),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  occurred_at TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL CHECK(expires_at > occurred_at),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ledger_entry_id UUID UNIQUE REFERENCES tmi_ledger_entries(id) ON DELETE RESTRICT,
  UNIQUE(event_type,source_id),
  CHECK((outcome='awarded' AND amount>0 AND ledger_entry_id IS NOT NULL)
    OR (outcome<>'awarded' AND amount=0 AND ledger_entry_id IS NULL)),
  CHECK(created_at >= occurred_at)
);
CREATE INDEX point_activity_receipts_user_day_idx ON point_activity_receipts(user_id,occurred_at);
CREATE TABLE point_expiry_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  credit_entry_id UUID NOT NULL UNIQUE REFERENCES tmi_ledger_entries(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK(amount >= 0),
  settled_at TIMESTAMP(3) NOT NULL,
  ledger_entry_id UUID UNIQUE REFERENCES tmi_ledger_entries(id) ON DELETE RESTRICT,
  CHECK((amount=0 AND ledger_entry_id IS NULL) OR (amount>0 AND ledger_entry_id IS NOT NULL))
);
CREATE INDEX point_expiry_settlements_user_idx ON point_expiry_settlements(user_id);
CREATE INDEX tmi_activity_expiry_idx ON tmi_ledger_entries(expires_at,user_id)
WHERE source_type IN ('platform_activity','platform_activity_refund');

CREATE FUNCTION point_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Point receipt is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER point_activity_receipts_immutable BEFORE UPDATE OR DELETE ON point_activity_receipts
FOR EACH ROW EXECUTE FUNCTION point_receipt_immutable();
CREATE TRIGGER point_expiry_settlements_immutable BEFORE UPDATE OR DELETE ON point_expiry_settlements
FOR EACH ROW EXECUTE FUNCTION point_receipt_immutable();

CREATE FUNCTION point_activity_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source RECORD; policy RECORD; posting RECORD; p JSONB;
  months INTEGER; cap INTEGER; requested INTEGER; used BIGINT; expected INTEGER; expected_outcome TEXT;
BEGIN
  PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
  SELECT * INTO source FROM enrollments WHERE id=NEW.source_id;
  SELECT * INTO policy FROM platform_policy_revisions WHERE id=NEW.policy_revision_id;
  IF source.user_id IS DISTINCT FROM NEW.user_id OR source.status IS DISTINCT FROM 'completed'
    OR source.completed_at IS DISTINCT FROM NEW.occurred_at OR policy."group" IS DISTINCT FROM 'points'
    OR policy.status IS DISTINCT FROM 'scheduled' OR policy.effective_at IS NULL OR policy.effective_at>NEW.occurred_at
    OR NEW.occurred_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Point activity source or policy mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.created_at>clock_timestamp() OR EXISTS(SELECT 1 FROM platform_policy_revisions other
    WHERE other."group"='points' AND other.status='scheduled' AND other.effective_at<=NEW.occurred_at
      AND (other.effective_at,other.version)>(policy.effective_at,policy.version))
  THEN RAISE EXCEPTION 'Point activity policy selection mismatch' USING ERRCODE='23514'; END IF;
  p:=policy.content;
  IF jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'rules') IS DISTINCT FROM 'array'
    OR COALESCE(p->>'expireAfterMonths','') !~ '^[0-9]+$' OR COALESCE(p->>'maxDaily','') !~ '^[0-9]+$'
  THEN RAISE EXCEPTION 'Point policy invalid' USING ERRCODE='23514'; END IF;
  months:=(p->>'expireAfterMonths')::integer; cap:=(p->>'maxDaily')::integer;
  IF months NOT BETWEEN 1 AND 120 OR cap NOT BETWEEN 0 AND 1000000 OR jsonb_array_length(p->'rules')>1
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rules') r WHERE r->>'event' IS DISTINCT FROM 'course.completed'
      OR COALESCE(r->>'points','') !~ '^[0-9]+$' OR (r->>'points')::numeric NOT BETWEEN 0 AND 1000000)
    OR NEW.expires_at IS DISTINCT FROM NEW.occurred_at+make_interval(months=>months)
  THEN RAISE EXCEPTION 'Point policy or expiry invalid' USING ERRCODE='23514'; END IF;
  SELECT (r->>'points')::integer INTO requested FROM jsonb_array_elements(p->'rules') r WHERE r->>'event'=NEW.event_type;
  SELECT COALESCE(sum(amount),0) INTO used FROM point_activity_receipts WHERE user_id=NEW.user_id
    AND occurred_at>=date_trunc('day',NEW.occurred_at) AND occurred_at<date_trunc('day',NEW.occurred_at)+INTERVAL '1 day';
  expected:=0;
  IF p->>'enabled'='false' THEN expected_outcome:='disabled';
  ELSIF COALESCE(requested,0)=0 THEN expected_outcome:='no_rule';
  ELSIF NEW.expires_at<=NEW.created_at THEN expected_outcome:='expired_before_award';
  ELSE
    expected:=CASE WHEN cap=0 THEN requested ELSE LEAST(requested,GREATEST(0,cap-used)) END;
    expected_outcome:=CASE WHEN expected>0 THEN 'awarded' ELSE 'daily_cap' END;
  END IF;
  IF NEW.outcome<>expected_outcome OR NEW.amount<>expected
  THEN RAISE EXCEPTION 'Point activity policy outcome mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT * INTO posting FROM tmi_ledger_entries WHERE id=NEW.ledger_entry_id;
    IF posting.user_id IS DISTINCT FROM NEW.user_id OR posting.kind::text IS DISTINCT FROM 'earn'
      OR posting.source_type IS DISTINCT FROM 'platform_activity' OR posting.source_id IS DISTINCT FROM NEW.source_id::text
      OR posting.amount IS DISTINCT FROM NEW.amount OR posting.expires_at IS DISTINCT FROM NEW.expires_at
      OR posting.occurred_at IS DISTINCT FROM NEW.created_at OR posting.occurred_at>=NEW.expires_at
    THEN RAISE EXCEPTION 'Point activity ledger mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_activity_source_guard BEFORE INSERT ON point_activity_receipts
FOR EACH ROW EXECUTE FUNCTION point_activity_source_guard();

CREATE FUNCTION point_expiry_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit RECORD; posting RECORD;
BEGIN
  PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
  SELECT * INTO credit FROM tmi_ledger_entries WHERE id=NEW.credit_entry_id;
  IF credit.user_id IS DISTINCT FROM NEW.user_id OR credit.source_type NOT IN ('platform_activity','platform_activity_refund')
    OR credit.kind::text NOT IN ('earn','refund') OR credit.expires_at IS NULL
    OR NEW.settled_at<credit.expires_at OR NEW.settled_at>clock_timestamp() OR NEW.amount>credit.amount
  THEN RAISE EXCEPTION 'Point expiry credit mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT * INTO posting FROM tmi_ledger_entries WHERE id=NEW.ledger_entry_id;
    IF posting.user_id IS DISTINCT FROM NEW.user_id OR posting.kind::text IS DISTINCT FROM 'expiry'
      OR posting.source_type IS DISTINCT FROM 'platform_activity_expiry' OR posting.source_id IS DISTINCT FROM NEW.credit_entry_id::text
      OR posting.amount IS DISTINCT FROM NEW.amount OR posting.occurred_at IS DISTINCT FROM NEW.settled_at
    THEN RAISE EXCEPTION 'Point expiry ledger mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_expiry_source_guard BEFORE INSERT ON point_expiry_settlements
FOR EACH ROW EXECUTE FUNCTION point_expiry_source_guard();
REVOKE ALL ON FUNCTION point_receipt_immutable(),point_activity_source_guard(),point_expiry_source_guard() FROM PUBLIC;
