# Coordinate refresh and revoke-all

Refresh rotation could consume a predecessor, then insert a successor after a
concurrent revoke-all statement had taken its snapshot. All issuers and account,
MFA and Admin revoke-all paths now acquire the same parameterized PostgreSQL
user-row `FOR NO KEY UPDATE` fence before authoritative reads/writes. This mode
remains compatible with foreign-key key-share locks for audit actors/identities.
Admin retains its whole-operation Serializable retry and last-admin protection.

Central issuance rechecks current roles/status/deletedAt. Local login also checks
the exact password hash proven before its transaction; bcrypt proof stays outside
that transaction. Firebase rereads identity binding before updating an existing
account and preserves403 ACCOUNT_BLOCKED. MFA issuance locks before reading its
factor revision. Transactions keep their existing timeouts and token lifetimes.

Four pre-fix regressions reproduced stale password/account/role issuance. Final
local auth/Admin verification:20 suites/154 tests, Nest build and diff/syntax
checks passed. Runtime audit:zero high/critical, unchanged one low/thirteen
moderate. Fresh-context review caught the Firebase error-shape regression; its
correction and explicit regression test are included. Cross-model CLI skipped
in autonomous context.

Real replay exposed an additional commit-time adapter conflict in overlapping
last-admin mutations. Admin's P2034-only retry did not recognize the native
DriverAdapterError/TransactionWriteConflict. The existing wallet serialization
classifier is now shared at the Prisma layer; Admin retries that exact conflict
family within its existing three-attempt whole-Serializable boundary. The wallet
wrapper keeps its existing additional P2002 behavior; Admin does not retry unique,
timeout, authentication or invariant errors. Its native-adapter regression failed
before correction; focused30 classifier/Admin/wallet tests and build passed.

The guarded disposable full-schema PostgreSQL replay runs forced lock waits for
both orders of refresh against password, provider-password, MFA confirm/disable/
recovery, Admin role and status revocation. It also exercises old-password proof
crossing a password change, inverse Admin mutations and overlapping last-admin
counts. It checks committed token state, independent accounts,30-day expiry and
unchanged purchased grants. Actual remote results remain pending.

No schema, financial term, role assignment policy, session format or production
MFA/account mutation is introduced. An application revert needs no data reversal,
but restores the race and should be used only for an observed regression.

Remaining original requirements: full-token binding/session families and atomic
MFA proof/mutation plus issuance with a primary-authentication security epoch.
This fence does not close the separate gap between those two committed MFA
transactions or invalidate already-issued provisional access after password
revocation. Keep these explicit in the full-plan completion audit.
