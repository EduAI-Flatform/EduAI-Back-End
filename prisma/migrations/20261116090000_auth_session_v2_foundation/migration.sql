-- Schema-only foundation. Legacy sessions and credentials remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.users, public.refresh_tokens IN ACCESS EXCLUSIVE MODE;

-- Compare every pre-existing column inside the same locked transaction.
-- Digests are integrity checks, never token/password authentication proofs.
CREATE TEMP VIEW auth_session_legacy_state AS
  SELECT 'users'::text AS source, count(*)::text AS row_count,
    md5(COALESCE(string_agg(md5((to_jsonb(u)-'auth_revision')::text), '' ORDER BY id), '')) AS hash
  FROM public.users u
  UNION ALL
  SELECT 'refresh_tokens', count(*)::text,
    md5(COALESCE(string_agg(md5((to_jsonb(r)-'session_family_id')::text), '' ORDER BY id), ''))
  FROM public.refresh_tokens r;
CREATE TEMP TABLE auth_session_legacy_snapshot ON COMMIT DROP AS
  SELECT * FROM auth_session_legacy_state;

ALTER TABLE public.users ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD CONSTRAINT users_auth_revision_nonnegative CHECK (auth_revision >= 0);
ALTER TABLE public.refresh_tokens ADD COLUMN session_family_id UUID;
CREATE INDEX refresh_tokens_user_id_session_family_id_idx
  ON public.refresh_tokens (user_id, session_family_id);

DO $$ BEGIN
  IF EXISTS (SELECT * FROM auth_session_legacy_state EXCEPT SELECT * FROM auth_session_legacy_snapshot)
    OR EXISTS (SELECT * FROM auth_session_legacy_snapshot EXCEPT SELECT * FROM auth_session_legacy_state) THEN
    RAISE EXCEPTION 'AUTH_SESSION_HISTORY_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE auth_revision <> 0)
    OR EXISTS (SELECT 1 FROM public.refresh_tokens WHERE session_family_id IS NOT NULL) THEN
    RAISE EXCEPTION 'AUTH_SESSION_FOUNDATION_INVALID';
  END IF;
END $$;
DROP VIEW auth_session_legacy_state;
COMMIT;
