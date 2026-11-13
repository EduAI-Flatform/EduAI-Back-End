# GDS request integration acceptance

The migration replay workflow now exercises the real platform settings/request services through Prisma and PostgreSQL with a temporary restricted runtime role. The probe refuses any database except the disposable localhost CI replay database; it never loads environment files or calls an external service.

Coverage: disabled intake, normalized private PNG upload, owner-only image/detail/reply access, truncated lists, reply pagination, Admin response/status changes, closed-ticket rejection, invalid/oversized uploads, normalized partner applications with effective-policy provenance, and audit metadata excluding private content. Invoice acceptance reuses an earlier checkout replay's canonical settled synthetic order, verifies ownership and idempotent requests, and confirms the order/settlement remain unchanged. Disabling intake preserves historical reads.

The synthetic operations policy is confined to the disposable database. Production support/invoice/partner settings are not enabled by this change. The existing checkout replay must run before this probe. All temporary database grants are dropped in cleanup. No application API, schema, dependency or production configuration changes.

Local verification: Node syntax check and the four platform-request Jest suites (23 tests) passed. Real PostgreSQL execution is a separate required migration-replay CI gate; local unit results do not claim that gate passed.
