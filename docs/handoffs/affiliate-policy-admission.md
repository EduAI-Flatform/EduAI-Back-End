# Affiliate admission and retained-history recovery

New identities, visits, attribution and advertised readiness require an effective
version with supported terms and configured platform-fee funding. Admin may keep
an unfunded draft or disable participation, but cannot schedule an enabled unfunded
revision. Existing withdrawal policy and native GDS journal remain authoritative.

Positive accrual also verifies the frozen scheduled revision, matching visit policy
and identity, and effectiveness before that visit. Both accrual writers share this
guard. The canonical historical evaluator stays independent of current funding or
participation so recorded refunds can append negative corrections without changing
old rows. Positive wallet effects have a separate admission check.

Review exposed a service-first ordering case: a negative business adjustment was
already present but its wallet recovery was pending. The adapter now allows that
proven negative effect and preserves held funds; unsupported funded inconsistencies
throw to block cash-out. Composed tests exercise both writer orderings and replay.

Behavior regressions reproduced unsupported current/frozen admission and the
service-first missed recovery. Focused tests/build and independent two-cycle review
validate the correction. No schema, SQL posting guard, policy activation, historical
rewrite or production financial test write was introduced. Actual disposable
PostgreSQL/full-source CI remains required before release.
