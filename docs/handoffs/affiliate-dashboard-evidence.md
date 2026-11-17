# Affiliate dashboard read-model acceptance

New guarded CI-only Prisma acceptance invokes actual AffiliateService and
PlatformSettingsService against disposable historical fixtures. It verifies three
owners, positive/negative correction totals, attributed-order counts rather than
visits/accrual counts, identity isolation, actual QR generation, missing public URL,
disabled money reads and unchanged history/audit/wallet counts after reads.

These synthetic pending orders and manual historical accruals are read-model
fixtures, not evidence of commission eligibility. No reconciliation/provider/wallet
posting occurs. Strict CI/local host/protocol/user/database/query/hash guards run
before runtime imports and refuse unsafe targets; no .env is loaded.

Script syntax, five replay/guard tests (nine unsafe targets) and independent review
passed. Actual full-schema PostgreSQL replay is required before release. The new
step is included in the existing migration replay with every previous gate retained.
