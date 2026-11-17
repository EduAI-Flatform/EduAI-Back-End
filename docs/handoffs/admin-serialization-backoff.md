# Bounded Admin serialization recovery

Main replay43869231907 failed in the existing inverse-Admin auth fixture before
the point suite, with Prisma P2034 at audit insertion. Source review confirmed
three complete Serializable attempts were already present; immediate retries can
overlap the still-running peer again. The exact repeated schedule was not logged.

Admin mutations now yield25/50ms outside rolled-back transactions before retrying.
The three-attempt limit, subject locks, last-Admin safeguard, transactional audit
and session revocation remain intact. Exhausted recognized conflicts return409;
unrelated errors are unchanged. The fixture now prints sanitized attempt counts
on failure and retains every concurrency assertion.

Two regressions failed before the fix;13 focused Admin tests, build and script
syntax passed. Independent review found no substantive issue. Recovery must be
confirmed by the changed revision's disposable PostgreSQL replay; neither a
rerun of unchanged main nor local mocked tests is represented as that evidence.
