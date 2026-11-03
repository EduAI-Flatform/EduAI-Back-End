# Revenue sharing release ? 2026-11-03

## Scope and deployment

- Includes the ten GDS migrations from dev plus revenue-sharing migration.
- Production runner pins the eleven release SQL artifacts by SHA256. Unknown pending migrations and changed artifacts still fail closed; receipt approval rules remain separate.
- Run Prisma generation, the production migration runner, runtime-role verification, build, and process restart through the existing deployment workflow.
- Runtime grants are reapplied idempotently on upgrades. Revenue history grants allow SELECT/INSERT only, with UPDATE/DELETE revoked.
- Retail revenue starts only after an administrator creates a policy. Legacy orders are not backfilled. Membership plans managed by revenue policies must be edited through revenue configuration.

## Verification

- Backend: 190 unit suites / 1,574 tests; full embedded PostgreSQL suite: 35 suites / 238 tests passed. Two tests in one pre-existing optional suite are skipped by the repository configuration.
- Frontend: 104 unit files / 468 tests; build/type-check; 14 revenue browser tests and 48 checkout/membership/GDS browser regressions passed.
- Actual Prisma adapter reproduced unsupported PostgreSQL void locks before the fix and passed after integer projection. CI replays 65 baseline migrations plus all eleven release migrations, then tests checkout and advisory locks with actual Prisma/PostgreSQL.
- Configured Neon database: checked all 75 applied migration checksums, applied only the pending revenue migration, confirmed all 76 migrations current. Counts of all 124 pre-existing tables were unchanged after migration.
- Confirmed effective eduai_runtime privileges meet the existing least-privilege verifier after the grants.
- Production dependency audits found no high/critical findings. Existing moderate findings remain: 13 backend and 2 frontend; framework major upgrades are outside this release.

## Recovery

Keep additive tables and financial history if reverting application code. Do not reset the database, drop revenue tables, or mutate immutable ledger history. Pause creating new revenue policies while investigating a failed release; use the previous known-good application revision and the normal deployment workflow. Re-run the migration runner and privilege verification on retry.
