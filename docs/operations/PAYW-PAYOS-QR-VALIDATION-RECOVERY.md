# PAYW PayOS QR validation and retry guard (2026-11-03)

## Evidence and behavior

`GDS_TOPUP_INVALID_PAYOS_LINK` previously combined UUID, pending status,
beneficiary, link identity and QR checks. The provider accepted account strings
up to 128 characters and QR strings up to 8192, while GDS required 6-32 numeric
account digits and capped QR at 4096. An SDK-shaped alphanumeric virtual-account
fixture reproduces the reported error. The precise production/UAT branch for
correlation `27deac07-f535-4650-a489-e770b5b61e48` is still unconfirmed because
runtime logs have not been accessed.

The provider, preview and persistence service now share bounded account,
identity, QR and checkout-host validation. An account remains an exact opaque
identifier; no trimming, numeric conversion or merchant-account fallback occurs.
The authenticated SDK create response is the only first-binding source. Amount,
orderCode, VND, immutable beneficiary, link identity, namespace locking and
cross-ledger collision checks remain enforced. Webhook/reconciliation and wallet
credit behavior are unchanged.

Diagnostic events contain fixed reason codes only, never SDK responses, account
numbers, QR payloads, checkout URLs, credentials or raw provider errors.

## Recovery boundary

A repeated unlinked intent queries its original orderCode instead of calling
create again. Lookup failures are not treated as absence. Non-pending, paid,
mismatched or malformed results cannot authorize a new link or wallet credit.

Installed `@payos/node` 2.0.5 `paymentRequests.get()` returns `PaymentLink` status
facts; it does **not** return currency, accountNumber, qrCode or checkoutUrl.
An existing pending link therefore returns HTTP 409
`GDS_TOPUP_RECOVERY_REQUIRES_PAYOS_QR`; lookup failures return HTTP 503
`GDS_TOPUP_PAYOS_RECOVERY_UNAVAILABLE`. No beneficiary is inferred or rebound.
This prevents duplicate outbound create requests but does not fully restore the
old QR after a lost create response. A future durable authenticated create-receipt
recovery design is required for that case. A retry after a crash before the first
PayOS call also stops safely rather than assuming it is safe to create.

Do not generate a fresh idempotency key automatically to bypass these errors.
Do not cancel, transfer funds, rotate PayOS channel credentials, change merchant
bank details, or credit GDS to repair an orphaned link.

## Release gate

Use the existing isolated dev/UAT service only. Check the exact deployed SHA,
health and one authenticated 10,000 VND QR creation, without transferring money
or crediting GDS. No PR or main merge until UAT passes. No database migration is
needed for this patch. Roll back source to the previous dev SHA if needed;
existing account hashes and payment links must be retained.

References: https://payos.vn/docs/api/ and
https://payos.vn/docs/cau-hoi-thuong-gap/; installed SDK sources under
`node_modules/@payos/node/lib/resources/v2/payment-requests/`.
