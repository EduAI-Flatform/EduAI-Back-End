# ADR-004: Separate PayOS financial settlement from fulfillment

## Status

Accepted

## Date

2026-09-08

## Context

The verified PayOS webhook path previously performed entitlement fulfillment
inside the same serializable transaction as the authoritative financial
settlement. If downstream fulfillment failed, the transaction rolled back
the payment event, matched settlement, paid attempt, confirmed order,
reservation consumption, lifecycle evidence, and audit evidence. A provider
could therefore report PAID while the local order remained pending.

The existing schema already supports FAILED fulfillment, idempotent
fulfillment effects, notification outbox rows, and
PAID_NOT_FULFILLED reconciliation cases. A schema reset or manual production
state change is neither required nor safe.

## Decision

Use two application transaction phases for verified PayOS recovery:

1. The financial transaction verifies and persists the provider event,
   matched provider settlement, paid attempt, confirmed order and
   confirmedSettlementId, consumes reservations, and appends lifecycle and
   sanitized audit evidence. Receiver-account variance remains HMAC/boolean
   telemetry and does not weaken the other provider, identity, amount,
   currency, order, reservation, or idempotency guards.
2. After phase one commits, the webhook or reconciliation path invokes
   fulfillConfirmedPayment with the canonical order and settlement IDs.
   This entry point owns a separate serializable transaction, locks the
   order, revalidates the order-to-settlement-to-attempt-to-event chain, and
   delegates to the existing idempotent fulfillment implementation.

If phase two fails, the financial state remains committed. A separate
failure transaction records FAILED fulfillment and an idempotent
paid_not_fulfilled case with
PAID_ORDER_FULFILLMENT_RETRY_REQUIRED when the canonical chain is still
valid. Reconciliation is the fallback for a lost handoff or failure-recording
error. Financial persistence failures remain provider-fact-mismatch cases;
they are never mislabeled as paid-but-not-fulfilled.

retry_succeeded first validates the same canonical financial chain, runs
the settlement-scoped fulfillment entry point outside the case transaction,
then rechecks that chain and FULFILLED state before atomically resolving the
case with lifecycle and audit evidence. Notification dispatch remains
outbox-based and is not treated as entitlement failure.

## Alternatives considered

### Keep settlement and fulfillment in one transaction

Rejected: downstream failure rolls back authoritative financial evidence and
causes the local order to disagree with the provider.

### Mark payment state directly from reconciliation

Rejected: recovery must continue through SDK-integrity-verified PayOS facts
and the canonical webhook settlement path; reconciliation must not bypass
signature, identity, amount, currency, or idempotency guards.

### Add a new schema-backed fulfillment job in this change

Deferred: the existing paid-attempt scan, fulfillment state, effects, outbox,
and reconciliation case provide a durable recovery path without a migration.
An explicit job/lease model can be considered separately if operational
volume requires it.

## Consequences

- A fulfillment failure cannot roll back a committed PayOS settlement.
- Duplicate events and retries use the canonical settlement and existing
  idempotency keys, so grants and effects are not duplicated.
- Lost post-commit handoffs remain visible to the bounded reconciliation scan.
- Failure evidence is sanitized; raw provider payloads, receiving accounts,
  credentials, and exception causes are not persisted in recovery errors.
- Production recovery still requires the normal deployed reconciliation
  operation; this change does not authorize or perform that operation.
