# Commerce persistence migration recovery

This is a **Forward-only** production migration. Before application code begins
writing commerce records, rollback may remove the unused additive objects. Once
any order, settlement, refund, reservation, or lifecycle record exists, rollback
must not drop these tables, enums, indexes, constraints, or trigger functions.

Application rollback disables the Phase 3 commerce and provider feature flags,
stops new checkout/webhook/worker entry points, retains every financial and
lifecycle record, and continues reconciliation of any in-flight collection.
Forward recovery deploys a new additive migration; it never rewrites or deletes
settled financial history.

Verification must include Prisma schema validation, migration contract tests,
a diff against the configured schema, and execution on a dedicated disposable
PostgreSQL target before production deployment. The configured shared/non-local
database is read-only for this task and must not be used for migration testing.
The repository test applies the complete migration chain to an ephemeral
PGlite PostgreSQL instance and exercises the commerce guards. A native
disposable PostgreSQL target remains required at the pre-production gate.
The application role must not be a PostgreSQL superuser or table owner and must
not have permission to disable triggers; the database guards are defense in
depth for the service transaction and authorization boundaries.

This migration intentionally supports course products only. A later additive
membership migration adds the membership enum value and plan-version foreign
key together so Prisma never advertises a product variant the database rejects.
Voucher quota locking and legacy-redemption cutover are implemented by the
transactional pricing/order service task; this schema supplies reservations,
source uniqueness, immutable redemption history, and ownership indexes but does
not treat `redeemed_count` as quota authority.
