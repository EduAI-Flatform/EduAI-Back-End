# Affiliate summary read model

GET /affiliate/me adds summary while retaining legacy fields. Identities,
attributed-order count, lifetime signed commission, UTC day/month sums and
canonical referred revenue share a RepeatableRead snapshot. The legacy commission
string aliases that snapshot lifetime sum. Existing wallet capability behavior is
unchanged; no reconciliation, posting, provider call or audit write is introduced.

Revenue uses verified fulfilled settlements and recorded refunds through the
existing evaluator. Attribution/visit chronology and exclusive asOf boundaries
are checked. Separate order/refund resource probes return an unavailable total
on overflow, never a partial figure. Pending/future settlements do not contribute.
Ranking is explicitly unconfigured and sub-affiliates disabled; null is not a fake
rank/count. No ranking business policy is implemented by this change.

Regression-first helper/state tests:27 passed across two suites. Nest build,
script syntax and whitespace checks passed. The guarded disposable Prisma fixture
also checks period sums against immutable source rows and legacy/lifetime equality;
its CI execution is still required before merge. Fresh independent source review
found no blocker. A separate fixture now exercises actual fulfillment and partial
refund services with canonical stored synthetic payment evidence, then checks
1000000 ->750000 referred revenue and immutable read snapshots. This is not a
provider certification; the full native CI has not yet run. No schema or historical
data migration is included. Frontend/source release gates remain outstanding.
