# SPR25-007 reconciliation hardening recovery

This is a **Forward-only** production migration. It backfills only rows whose
reconciliation `source_key` is NULL, enforces that identity, and strengthens
the existing acknowledgement constraint trigger. Existing non-NULL source keys
are immutable and are preserved verbatim, including older
provider-fact-mismatch keys that include a reason-specific suffix. There is no
transformation of an existing source key. The migration must not delete or
rewrite orders, payments, attempts, webhook facts, settlements, refunds,
fulfillment, reconciliation history, or financial audit evidence. It must not drop
a permanent Commerce table, column, index, enum, or trigger.

If a pre-hardening case already has `status=resolved` and
`resolution=acknowledged`, the migration adds one immutable row to
`commerce_reconciliation_legacy_acknowledgements`. That row records only that
the historical acknowledgement existed under the old implementation; it is
not a payment confirmation, failure, fulfillment decision, or new financial
resolution. The marker is additive, keyed by the reconciliation case, and
protected against update/delete. A new or still-open case cannot use the
marker.

## Required preflight

Before applying the migration, run a read-only transaction against the
configured migration database and record only aggregate counts. The preflight
must prove that every null `source_key` row has a payment-attempt identity,
that every duplicate/late row has a settlement identity, that the deterministic
key formula for null rows produces no duplicate groups, that it does not
collide with an existing non-null key, and that every derived key is at most
160 characters. Record the count of existing non-NULL keys that do not match
the null-row formula by kind; that count is preserved evidence, not a
transformation target. A changed non-NULL key count or value is a failure.
For each existing acknowledged financial case, the preflight must also prove
immutable legacy provenance: resolved timestamp, resolver, status operation
identity, and the matching open -> resolved lifecycle event with
`OPERATOR_ACKNOWLEDGED`. Stop and leave `SPR25-007` in `WAITING_MANUAL` if any
structural, collision, provenance, or marker-consistency count is non-zero.

For null rows, the migration derives `payment_attempt_id:kind`, with
`:settlement_id` for `duplicate_collection`, `late_payment`, and
`paid_not_fulfilled` cases. Existing non-NULL keys are not required to match
that derivation because the deployed Backend also preserves a historical
reason-specific provider-fact-mismatch identity. Those existing values remain
immutable and unique.

## Apply and recovery

Apply only through `npm run prisma:migrate:production`, after reviewing the
exact SQL and the preflight evidence. The SQL repeats the collision,
provenance, and marker-consistency checks inside the migration transaction so
a changed production shape fails closed. Its postflight must show one
matching immutable legacy marker for every pre-existing acknowledged
financial case and zero unmarked or mismatched markers.
The existing reconciliation update guard remains active and permits only a
null-to-derived-key transition that matches the formula; an existing non-NULL
source key cannot change. All other source facts remain immutable. Postflight
must confirm that every source key is non-NULL, duplicate and collision counts
are zero, the preflight non-NULL key count is unchanged, and every historical
acknowledgement has one matching immutable legacy marker.

If the migration fails before Prisma records it as applied, the transaction is
rolled back. Preserve the failure evidence, inspect `_prisma_migrations`, and
do not mark the migration applied manually. If an application rollback is
needed after the migration succeeds, keep the migration and its legacy markers
applied and deploy a Backend revision compatible with non-null `source_key`; do
not run a destructive down migration. Use Provider-specific controls to disable
new PayOS requests
and webhook/reconciliation traffic while preserving all records, then recover
with a reviewed additive migration or compatible application deployment.

Provider-specific controls and traffic/routing controls may contain new
activity, but they must not delete financial history. Any reconciliation
follow-up must use the supported authenticated application path; never repair
these tables with ad-hoc SQL.
