# TMI adjustment-key payload binding

An administrative adjustment retry previously matched only user/key and returned
the new request's amount/direction even when no matching posting existed. A changed
amount, direction or reason now receives409. Identical retries return the stored
amount/direction and current server-derived balance without a second posting/audit.

The existing per-user lock and Serializable retry boundary remain. Ledger rows and
their audits are immutable; no migration or historical rewrite is introduced.
Exact reason text participates in payload matching, preserving original metadata.

Three conflict regressions reproduced the bug. Final31 redemption/expiry tests,
build and syntax checks passed. Independent review found no substantive issue.
The checked-in restricted-role PostgreSQL replay script adds concurrent identical
and conflicting requests, unchanged history/audit after409, debit replay and audit
failure rollback. Its actual database result must pass remote CI before release;
the local run does not claim a disposable PostgreSQL execution.
