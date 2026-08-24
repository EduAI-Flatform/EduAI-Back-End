# Commerce persistence migration recovery

This is a **Forward-only** production migration. Before application code begins
writing commerce records, rollback may remove the unused additive objects. Once
any order, settlement, refund, reservation, or lifecycle record exists, rollback
must not drop these tables, enums, indexes, constraints, or trigger functions.

Application rollback keeps permanent Commerce entry points and records intact.
Provider-specific controls stop new provider/webhook/worker activity. If a
checkout defect requires containment, approved traffic/routing controls stop
the affected write route while every financial and lifecycle record is retained
and in-flight collection continues through reconciliation.
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
