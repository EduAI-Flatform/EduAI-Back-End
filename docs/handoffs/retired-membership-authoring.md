# Retired package-authoring cleanup

Legacy package create/version/publish/configuration routes already returned410.
Their unreachable service implementations and exclusive normalizers are removed.
The available-courses authoring route now returns the same guarded retirement
response. Compatibility route signatures and Admin authorization remain.

Historical list/serialization/pricing, version/plan archival locks and audit,
Commerce product archival and reusable service definitions remain. Purchased
course grants, quotas, fulfillment, refunds, revenue jobs and tables are unchanged.

The disposable advisory-lock probe now calls retained archiveVersion with a
missing version and expects domain NotFound, proving lock decoding before mutation.

Verification:13 focused membership Admin tests, build, script syntax and independent
adversarial review passed. Removed service-method names remain only on retired
controller compatibility routes/tests. Full CI/PostgreSQL replay remain required.

Checkout creation retained by financial fixtures is a separate cleanup slice.
No schema deletion or completion of the full GDS plan is claimed by this change.
