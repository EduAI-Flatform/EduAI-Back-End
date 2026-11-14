# Atomic MFA proof and session issuance

MFA confirm/verify/recovery replacement previously committed proof or factor
mutation before opening a second transaction for token issuance. Signing failure
could consume a code or replace recovery state without returning a session;
password revoke-all could also commit between proof and successor issuance.

AuthService now owns one subject-fenced transaction for each HTTP flow. It checks
fresh primary authentication and original MFA claims under the lock, invokes the
MFA operation with that transaction, and issues using its new factor revision and
original authTime. The issuer is private and requires the caller transaction.
MfaService reuses supplied transactions and opens a root transaction only for
standalone domain operations. Confirmation reads its setup under the same fence.

HTTP response shapes, guards/rate limits, token lifetimes and standalone domain
operations remain compatible. No schema, financial policy or production MFA/
account mutation is needed. Rollback is an application revert; no data reversal.
It would restore the split-commit weakness and should require an observed reason.

Regression-first PostgreSQL replay43578325892 at initial head
fac3edfb5b1eb39caeb2a74960c138195ff8d86e failed with a persisted TOTP lastUsedStep
after forced signing failure. Four local orchestration cases also failed before
correction. Final local auth verification:19 suites/151 tests and Nest build pass;
runtime audit:zero high/critical, existing one low/thirteen moderate unchanged.

The guarded disposable PostgreSQL probe covers access/refresh signing, hashing
and post-insert failures for TOTP/recovery verification, confirmation and recovery
replacement. It compares factor, token and audit state, then reuses proof, checks
verified claims/authTime/expiry and rejects replay. Three additional schedules
pause after proof and observe an actual password-revoker lock wait through
issuance. Bcrypt prework runs before the intentional pause; production/default
interactive transaction timeouts remain unchanged. Remote final results pending.

Fresh-context design/diff review completed; a probe timing issue was corrected.
External cross-model CLI skipped in autonomous context. Full-token binding,
session-family logout and a primary-authentication epoch remain original required
work: this atomicity correction does not reject a provisional primary session
presented after an already-completed password revocation.
