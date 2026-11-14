# Preserve MFA revision during renewal

An old refresh session could previously acquire the current MFA revision after
factor replacement or disablement. Renewal now rejects a different revision
with401; a missing legacy revision counts as0. A fresh primary login still takes
the current revision. Same-revision provisional/verified state and original
primary-authentication time are preserved.

Central AuthService issuance supplies its existing transaction's MFA reader,
instead of independently reading through root Prisma. A stale rejection aborts
the predecessor CAS and successor creation together. No schema, token format,
lifetime, rate limit, password proof, purchased right or financial setting changes.

Regression tests reproduced three incorrect successful renewals before the fix.
Local auth verification:17 suites/138 tests and Nest build passed. Runtime audit:
zero high/critical findings; existing one low/thirteen moderate unchanged.
Fresh-context adversarial review found no issue in this scoped contract.
External cross-model CLI skipped in autonomous context.

The guarded disposable PostgreSQL checkout replay additionally checks actual
same-revision renewal/auth time, stale enabled/disabled rejection, exact token-row
rollback and unchanged purchased grants. Its remote result remains pending.

This is not a complete revocation-concurrency fix: common refresh/revoker fencing,
atomic MFA proof plus issuance, primary-authentication epoch, exact full-token
binding and per-device rotation-family logout still require separate work.
No production MFA or account mutation is required for this release.

Rollback is an application revert, requiring no data/schema reversal; it restores
the old stale-revision weakness and should be reserved for an observed regression.
