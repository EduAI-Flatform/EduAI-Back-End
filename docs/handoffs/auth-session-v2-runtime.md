# Auth session V2 runtime (in progress)

The branch implements the remaining GDS session contract on the already-deployed
auth revision/family schema. This is a hard token-format transition: legacy access,
refresh and revision-less OAuth session tickets are rejected; users sign in once
again. No production cutover is claimed by this source checkpoint.

## Runtime contract

- Signed access and refresh purposes are distinct, including when test keys are
  equal. Both bind subject, version2, auth revision and a stable device-family UUID.
- Refresh additionally binds the exact row UUID and full UTF-8 token digest with
  `sha256:v2:` prefix. No password/bcrypt fallback or active-token scan exists.
- Rotation, family logout and revoke-all share the existing user-row fence.
  Rotation preserves family and original auth time. Logout accepts an exactly
  proven unexpired predecessor even after rotation/MFA revision change, revoking
  only that family. Retain revoked V2 rows through their expiration.
- Access requires current revision, eligible account and an active unexpired
  family. Password/provider revocation and actual Admin role/status changes
  advance the revision atomically; Admin no-ops do not.
- MFA enrollment, disablement and atomic proof/issuance validate original caller
  revision/family/factor/freshness under the mutation fence. A guard check alone
  cannot authorize a mutation after a competing revocation.
- Local proof and Firebase resolved-account snapshots cannot adopt a newer
  revision under the lock. OAuth session tickets capture revision when the app
  principal is resolved; redemption compares that revision under the issuance
  fence. Missing ticket revision fails closed. A genuinely new primary identity
  resolved after revocation may authenticate; this does not claim provider-side
  bearer-token revocation or read unverified provider hints.

## Evidence and remaining release work

Behavior-first regressions demonstrated missing V2 claims/binding, stale revision
acceptance, rotated-predecessor logout failure and absent access-purpose/family
checks before implementation. Local auth/Admin validation passed182 tests in22
suites; real JWT quota HTTP ownership passed6 tests. Build passed. Fresh-context
design review corrected an overbroad provider-proof assumption; a separate core
diff reviewer found no actionable issue. Cross-model CLI review was skipped in
this autonomous context; no external CLI was invoked.

Existing real PostgreSQL revocation/MFA probes are updated to use explicit V2
fixtures. Bcrypt-refresh failure injection is obsolete: native full-token hashing
has no password-provider hook. Existing proof rollback coverage now injects
before and after token-row insertion, retaining access/refresh signing failures.
The new guarded probe covers long shared JWT prefixes, repeated rotation,
idempotent predecessor logout, independent devices, both observed PostgreSQL
refresh/logout lock orders and stale MFA mutations after credential revocation,
with exact purchased-grant preservation. Remote execution remains pending.

Before merge/release, complete the explicit one-time cutover gate: schema-ready
preflight, candidate runtime version/revision metadata, durable minimum-version
marker, stop/verify old processes before start, exact health revision/version and
V2-compatible rollback through current protected orchestration. Never downgrade
the marker or automatically restart a legacy app on failure. Current workflow has
no automatic source rollback; these controls apply to the supported deployment
path, not unauthorized manual execution of arbitrary historical scripts.

Production MFA/multi-device/retained-session acceptance must reflect the deliberate
one-time legacy reauthentication. Keep the original GDS plan VERIFYING until all
remaining original requirements, not only this branch, have authoritative evidence.
