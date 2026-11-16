# Auth session V2 schema foundation

This additive prerequisite does not change authentication behavior. Existing
passwords, refresh tokens, revocations, expiry dates and purchased rights remain
unchanged. Runtime epoch checks, full-token binding and device-family logout are
still required before the original GDS session requirement is complete.

## Schema and integrity

`20261116090000_auth_session_v2_foundation` adds `users.auth_revision` (required
integer, default zero, nonnegative check), nullable UUID
`refresh_tokens.session_family_id`, and its nonunique user/family index. Existing
sessions retain a null family until the later explicit runtime cutover.

The migration compares all pre-existing auth columns before and after DDL inside
one transaction. Digest checks never authenticate credentials. Table locks prevent
ordinary login churn from producing false preservation failures; lock acquisition
is bounded to five seconds and each statement to sixty seconds. Large datasets
may exceed that bound: investigate duration/size rather than removing the check or
blindly retrying. Any failure rolls back the additive DDL.

## Release and recovery

Pause automatic CD before merging the pending migration. Use the existing manual
production workflow with `authorize_production=true` and
`authorize_auth_session_schema_migrations=true`; preserve financial switches and
leave unrelated migration authorizations false. The runner accepts only the exact
pinned artifact after all preceding reviewed migrations, checks it in both
preflights and again before apply, and rejects unknown suffixes or altered bytes.

The workflow takes an existing private database backup before migration. After
migration/grants/build, `node scripts/verify-auth-session-schema.cjs` checks the
successful ledger checksum, exact column/check/index metadata and required runtime
column privileges before PM2 restart. It outputs booleans, never user values.
Verify health and an existing retained session before restoring automatic CD.

On failure keep the old runtime serving and investigate the specific failed step.
If the migration committed, retain the additive columns and migration ledger;
the previous runtime is compatible with them. Do not reverse history or drop
columns as an automatic rollback. A later V2 runtime release must define its own
minimum-compatible rollback and old-instance drain; rolling back to legacy token
acceptance after that cutover must not be permitted.

## Validation

PGlite covers exact old-column preservation, new defaults/checks and full rollback
when credential/revocation drift is injected. Release tests cover independent
authorization, pinned bytes, prerequisites, repeated preflight and deployment
ordering. The real PostgreSQL CI replay seeds legacy auth evidence at the original
65-migration baseline, applies all 25 pending migrations, verifies old-row digests,
new schema/privileges and rolled-back revision/family writes. Synthetic fixture
digests are private runner-temp files, not production exports.

Local auth regression: 19 suites/151 tests passed. Independent foundation review
found no remaining actionable issue; real PostgreSQL replay must pass on the final
PR head before merge. No production acceptance is claimed by this document yet.

## Next runtime contract

- Signed access/refresh V2 claims bind subject, auth revision and stable device
  family; refresh additionally binds its exact row ID and full-token digest.
- Refresh checks the signed revision under the subject fence. It never upgrades a
  stale primary session to the current revision.
- Credential/account revocation increments the revision under that same boundary.
  MFA enrollment/disable and proof/issuance recheck caller revision/family inside
  their mutation transaction, not only in a preceding HTTP guard.
- Logout revokes the caller's family, including successors of a proven rotated
  predecessor, while preserving other devices. Legacy bcrypt ambiguity requires
  explicit one-time reauthentication at cutover, without an unrestricted fallback.
- Drain legacy application instances before declaring cutover complete; rollback
  must remain V2-compatible. Schema deployment alone does not satisfy this gate.
