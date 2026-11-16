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

## Draft core CI and cutover controls

Draft PR55 core head `49a9a9eabd1ed56a1506e22779aca657076e470a` passed
[quality/concurrency43796826346](https://github.com/EduAI-Flatform/EduAI-Back-End/actions/runs/43796826346)
and [PostgreSQL replay43796826360](https://github.com/EduAI-Flatform/EduAI-Back-End/actions/runs/43796826360).
The new exact-family/two-lock-order/five-stale-MFA markers passed in ordinary and
production-classified disposable runs, with purchased grants unchanged. Those
results cover the core head, not later uncommitted cutover controls.

The cutover implementation generates version/revision metadata with each build,
caches it once per server process and exposes only that identity in public health.
Production startup rejects missing/legacy metadata. The protected restart path
requires explicit first-cutover authorization, persists a private fsynced floor in
`.git/auth-session-minimum-version.json`, verifies one managed Node fork with
matching entry/cwd and watch disabled, stops it and observes old-PID exit before
installation/start, then requires replacement PID and exact revision/version
health before PM2 save. Failure retains the floor and never restores legacy code.

Independent review reproduced two operational gaps in the first implementation:
in-place build could expose V2 to an automatic legacy-process restart before the
gate, and PM2 interpreter/cwd checks were missing. Corrected deployment compiles
into `.git/auth-session-candidate/dist` and promotes it only after floor + drain;
local real compilation proved live auth bytes unchanged. Denied authorization
keeps the legacy live entry intact. Negative Node/cwd/watch checks now precede
marker/process mutation. Old generated dist is retained inside staging only as
an artifact, never automatically restarted, and is cleared by the next verified
staging build. This does not delete application data or the durable floor.

A second review found point readiness still imported the live artifact before
promotion. The strict `--staged` loader and deployment wiring now select candidate
code; distinct live-failing/candidate-ready implementations prove that boundary.
Final scoped review found no remaining substantive issue in the corrected
supported-path design. This is not a claim that a host administrator cannot run
arbitrary historical scripts outside current protected orchestration. Final-head
CI, explicit production cutover authorization and actual acceptance remain open.

Local corrected-cutover validation passed199 integrated auth/Admin/health/own-quota
HTTP tests across26 suites,32 focused release/verifier checks, regular build and
an actual staged build with unchanged live auth-module digest. First-cutover
denial, malformed artifact/floor, stop/start/health failure, lingering old PID,
unsupported interpreter/cwd/watch and staged point implementation are covered.
The supported PM2 layout is deliberately strict: one Node fork at this checkout's
`dist/src/main[.js]`, matching cwd, no watch. An observed unsupported production
layout must be investigated before the floor or process is changed.

Cutover-control head `062b04e7916c8375464b3c34709051cf60198252` additionally passed
[replay43799405489](https://github.com/EduAI-Flatform/EduAI-Back-End/actions/runs/43799405489).
The subsequent CI check runs a real staged compilation on Linux and compares the
live entry/auth-module/metadata digests before and after, asserting exact candidate
revision. The same check passed locally. Dependency audit remains zero high/critical,
with existing1 low/13 moderate and no new dependency. Final source is still held
in draft pending exact-head remote gates and the one-time production cutover.

## First production attempt stopped safely

PR55 merged as `bd63f105018317f70d11b3824f24a1a400448911` after final-head
quality43799705676/replay43799705684 passed, including Linux staged-build
isolation. The initial approval-service usage-limit failure did not execute the
merge; normal reviewed recovery after the owner resumed succeeded. Auto-CD was
paused and verified before merging.

Controlled deployment43819198120 passed its full validation job and staged the
candidate, then failed with `AUTH_SESSION_PROCESS_LAYOUT_UNSUPPORTED`. That error
site precedes floor establishment, stop and artifact promotion. Public health
remained200 with legacy runtime identity; no V2 login/MFA production UAT was run.
Do not rerun blindly or weaken the guard. The diagnostic follow-up emits only
predicate booleans, recognized command-kind enums and managed-process count;
paths, raw arguments and PM2 environment stay private. Actual floor presence and
which process predicate differs will be observed before selecting a compatible
transition. Keep the overall release uncompleted and auto-CD paused meanwhile.
