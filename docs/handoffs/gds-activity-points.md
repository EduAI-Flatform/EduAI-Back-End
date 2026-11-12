# GDS activity points — implementation in progress

This branch is not release-ready. The overall GDS plan remains open.

Implemented substrate:

- Internal `ActivityPointService.recordCourseCompletion` reads canonical enrollment facts, locks the source owner, selects the scheduled policy effective at the event time and atomically writes the award, immutable receipt and audit record. No public award endpoint exists.
- UTC-day limits include receipts across revisions. Zero outcomes have receipts without fake zero-value ledger entries. Delayed events cannot resurrect already-expired points. Calendar-month expiry clamps the day in UTC.
- Additive migration `20261112180000_activity_points` introduces activity receipts and expiry settlements. Source/policy/ledger ownership, immutable outcomes, event uniqueness, policy amounts, daily caps and expiry dates are checked in PostgreSQL. Fully spent grants can have zero-value expiry settlements without zero ledger postings.
- Prisma inverse relations retain source enrollments, policy revisions and ledger history through restrictive foreign keys.

The service is intentionally not registered with a worker or exposed through a controller yet. Existing point accrual activation remains blocked. The migration has not been applied outside disposable PGlite tests and is not yet included in production migration authorization or runtime grants.

Remaining before release:

1. Integrate expiry settlement and read-only balance projection with redemption, adjustments and refunds under the existing per-user lock. Refunds must retain original native-credit expiry; legacy credits retain their existing meaning. Resolve deterministic ordering for postings sharing a timestamp and verify allocations before recording zero settlements.
2. Complete reserved-ledger/source guards so orphan activity postings cannot bypass receipt provenance. Validate the full Prisma migration chain and exact runtime privileges in real PostgreSQL, including concurrent workers, redemption and rollback/retry.
3. Register a bounded canonical-completion/expiry worker only after the above paths are safe. Disabled accrual must not prevent existing expiry. No school API is needed for native course completion.
4. Add the separately reviewed migration authorization, checksummed artifact, backup/preflight/postflight and bounded runtime SELECT/INSERT grants; preserve historical migration authorizations.
5. Complete Admin supported-rule choices, readiness and policy impact/provenance visibility; then run affected browser checks, review/CI, controlled deployment and post-deploy verification.

Verification at this checkpoint: 18 focused source tests, 10 isolated PostgreSQL migration tests, Prisma generation and Nest build passed. PGlite coverage is not a substitute for the remaining restricted-role real PostgreSQL integration tests. No production policy or balance was changed.
