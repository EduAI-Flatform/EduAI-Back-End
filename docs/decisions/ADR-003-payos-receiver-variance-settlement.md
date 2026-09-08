# ADR-003: Treat PayOS receiver variance as non-authoritative evidence

## Status

Accepted

## Date

2026-09-08

## Context

PayOS can confirm a payment as `PAID` while the receiving account reported
by a transaction differs from the account fingerprint captured when the
payment request was created. The PayOS SDK response and webhook signature
still authenticate the provider facts, but receiving-account equality is not
stable enough to be a settlement invariant.

Using that equality as a blocker leaves an otherwise canonical payment in
`PENDING_PAYMENT` and prevents reconciliation recovery. Removing all checks,
however, could weaken payment identity, amount, currency, order, reservation,
or idempotency protections.

## Decision

Keep receiving-account fingerprints as sanitized telemetry only. A stored
fingerprint mismatch is recorded as
`PROVIDER_RECEIVING_ACCOUNT_VARIANCE` using HMAC fingerprints and a boolean;
raw receiving-account values are never persisted, logged, or returned in
public errors. The mismatch must not block a settlement that passes all
canonical checks.

Webhook settlement still requires SDK signature verification, a valid
settlement provider code, matching payment identity and order code, exact
amount and currency facts, canonical local order/buyer/reservation integrity,
idempotency, and a valid state transition.

PAID reconciliation still requires an SDK-integrity-verified response with
matching identity and order code, exact `amount`, `amountPaid`, and zero
`amountRemaining`, plus an exact-amount transaction with a valid reference
and timestamp. Recovery feeds the reconstructed event through the same
verified webhook ingestion pipeline; it never directly marks the database
paid.

## Alternatives Considered

### Keep receiver equality as a settlement invariant

Rejected: production evidence shows a valid PayOS `PAID` payment can report a
different receiving account even when payment identity, order code, amount,
and paid totals all match.

### Remove receiver fingerprints entirely

Rejected: the fingerprint remains useful for sanitized anomaly monitoring and
does not need to be an authenticity root.

### Accept any provider `PAID` response

Rejected: this would bypass canonical identity, amount, order, integrity,
signature, and idempotency guards.

## Consequences

- Valid signed/canonical PayOS settlements can recover despite receiver
  variance.
- Receiver variance remains observable without exposing bank-account data.
- PayOS SDK signature and response-integrity verification remain mandatory.
- Existing duplicate, collision, canonical-order, reservation, and lifecycle
  protections remain authoritative.
- Production recovery still requires the official reconciliation flow after
  the fixed code is deployed.
