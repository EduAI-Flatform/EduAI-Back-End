# GDS activity points — implementation in progress

This branch is not release-ready. The overall GDS plan remains open.

Implemented substrate:

- Internal `ActivityPointService.recordCourseCompletion` reads canonical enrollment facts, locks the source owner, selects the scheduled policy effective at the event time and atomically writes the award, immutable receipt and audit record. No public award endpoint exists.
- UTC-day limits include receipts across revisions. Zero outcomes have receipts without fake zero-value ledger entries. Delayed events cannot resurrect already-expired points. Calendar-month expiry clamps the day in UTC.
- Additive migration `20261112180000_activity_points` introduces activity receipts and expiry settlements. Source/policy/ledger ownership, immutable outcomes, event uniqueness, policy amounts, daily caps and expiry dates are checked in PostgreSQL. Fully spent grants can have zero-value expiry settlements without zero ledger postings.
- Prisma inverse relations retain source enrollments, policy revisions and ledger history through restrictive foreign keys.
- `PointLedgerService` is registered with redemption. Read-only wallet projection excludes due unspent native points without writing history; spending/adjustments/refunds settle expiry under the existing user lock. Refunds are split into legacy and native lots, retain original native expiry and immediately expire returned points whose original validity has ended. Contradictory settlement receipts fail closed.
- A database-generated `posting_sequence` disambiguates new ledger entries sharing a timestamp. It is internal and is not exposed in JSON responses. The additive migration now also requires bounded runtime usage on its sequence before deployment.
- Authorization and debit share one valuation timestamp under the user lock, preventing a slow transaction from authorizing just before expiry and then recording consumption after the cutoff. Both all-native and mixed refunds have replay coverage.

The award service and bounded lifecycle worker are now registered internally, with no public award endpoint. Expiry and completion scans run independently, at most 50 users/events per pass, and expiry posts at most 25 settlements per user transaction. Failed sources are retried in later scan cycles. Point accrual activation remains blocked. Runtime grant preparation now includes append-only receipt access and sequence USAGE without reset rights. The migration is not yet authorized for production. New code selects the sequence column, so it must not be deployed before that migration.

Remaining before release:

1. Extend integration verification for expiry/redemption/refund boundaries, all-native refunds and idempotent retries using real PostgreSQL. The source implementation and focused regression coverage are present; real transaction rollback and concurrency remain unproven at this checkpoint.
2. Reserved activity credits and expiry debits now require matching receipts at transaction commit, native ledger updates/deletes are rejected, and native refunds retain validated source ownership, debit identity and original expiry. The isolated database suite has 15 passing tests; the extended real-PostgreSQL assertions must pass again after these new guards.
3. Verify the registered bounded worker in real PostgreSQL, including disabled accrual and independent failing queues. No school API is needed for native course completion. CI now runs `scripts/test-activity-points-prisma.cjs` against the disposable migrated database with a restricted role; actual CI results remain pending at this checkpoint.
4. Add the separately reviewed migration authorization, checksummed artifact, backup/preflight/postflight and bounded runtime SELECT/INSERT grants; preserve historical migration authorizations.
5. Complete Admin supported-rule choices, readiness and policy impact/provenance visibility; then run affected browser checks, review/CI, controlled deployment and post-deploy verification.

Verification at this checkpoint: 55 point-module tests, 31 platform policy tests, 15 isolated PostgreSQL migration tests, Prisma generation and Nest build passed. On commit `4491506`, real PostgreSQL replay run `43210754599` passed the historical 65-migration baseline and 23 upgrades, restricted-role duplicate awards, competing redemptions, native refunds, audit rollback, concurrent worker expiry with disabled accrual and permission boundaries. Backend CI `43210754535` also passed. The subsequent provenance guards still require a fresh CI replay. No production policy or balance was changed.
