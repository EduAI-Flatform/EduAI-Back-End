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

The award service is intentionally not registered with a worker or exposed through a controller yet. Existing point accrual activation remains blocked. The migration has not been applied outside disposable PGlite tests and is not yet included in production migration authorization or runtime grants. The new redemption code selects the new sequence column, so it must not be deployed before that migration.

Remaining before release:

1. Extend integration verification for expiry/redemption/refund boundaries, all-native refunds and idempotent retries using real PostgreSQL. The source implementation and focused regression coverage are present; real transaction rollback and concurrency remain unproven at this checkpoint.
2. Complete reserved-ledger/source guards so orphan activity postings cannot bypass receipt provenance. Validate the full Prisma migration chain and exact runtime privileges in real PostgreSQL, including concurrent workers, redemption and rollback/retry.
3. Register a bounded canonical-completion/expiry worker only after the above paths are safe. Disabled accrual must not prevent existing expiry. No school API is needed for native course completion.
4. Add the separately reviewed migration authorization, checksummed artifact, backup/preflight/postflight and bounded runtime SELECT/INSERT grants; preserve historical migration authorizations.
5. Complete Admin supported-rule choices, readiness and policy impact/provenance visibility; then run affected browser checks, review/CI, controlled deployment and post-deploy verification.

Verification at this checkpoint: 43 affected source tests, 10 isolated PostgreSQL migration tests, Prisma generation and Nest build passed. PGlite coverage is not a substitute for the remaining restricted-role real PostgreSQL integration tests. No production policy or balance was changed.
