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

## Signed settlement reconciliation (2026-11-03)

PayOS can return a QR virtual account on create and a different physical
receiving account in its signed webhook and authenticated GET transaction.
These are distinct provider facts. The QR account hash remains immutable.
The physical account hash is bound once, per immutable link, only after the
signed webhook and an independent SDK-signature-verified GET agree on exact
link/order, VND amount, full payment, one bank reference, receiver and timestamp.
Any explicit signed virtual account must still match the original QR hash.
This applies AntiFake's transaction/link identity model while retaining EduAI's
stronger signature, per-transfer, lifetime and cross-ledger checks.

Migration `20261103020000_add_gds_payos_settlement_reconciliation` adds the
physical binding and append-only reconciliation evidence, and permits bounded
alphanumeric signed account identifiers. Apply it only to the isolated UAT DB
before starting this source revision. It does not rewrite existing balances,
QR hashes or signed inbox records. Database guards require matching evidence
before a signed-inbox topup can become verified/credited. Application writes
proof, binds the receiver, and posts the balanced unique journal atomically.

The UAT worker and open-QR UI now poll every three seconds. Failed provider
queries remain pending/retry; mismatches remain REVIEW. No browser redirect or
screenshot authorizes credit.

Historical REVIEW due to `SIGNED_IDENTITY_OR_TERMINAL_CONFLICT` is recovered
explicitly with `processReviewed`; the original REVIEW row is retained. A new
proof resolves it and shares the original event/topup credit identity. Unrelated
review reasons, cancelled intents, split/overpaid transfers and recipient changes
cannot use this path.

After build and migration, this bounded operator command defaults to dry-run:

```sh
node scripts/reconcile-gds-reviewed-topups.cjs --uat --memo <MEMO_A> --memo <MEMO_B> --expected-amount 10000 --max-total 20000
```

Only after every scoped lookup passes, rerun with `--apply`. The script requires
a non-production local Node environment, exact applied migration checksum, at
most two exact intents belonging to one buyer, expected amount and total cap.
It uses the configured isolated UAT database and merchant credentials; the
`--uat` argument explicitly classifies this bounded operator run. It does not
edit environment files or change running service flags. Every apply re-queries
PayOS and calls the normal guarded service; there is no balance-update SQL.
A replay verifies existing proof/journal and performs no write. Logs contain
only aggregate statuses and amounts; never accounts, QR, credentials or refs.


## Payment completion popup (dev/UAT)

The wallet starts with an empty amount and explicit presets. Creating a QR opens
an accessible dialog; closing it does not cancel or create another intent.
GET /wallet/gds?topupId=<UUID> returns only the authenticated buyer's intent
status, without bank details. CREDITED requires persisted reconciliation evidence
and the matching TOPUP_CREDIT journal, never a balance increase alone.
The UI matches intent ID, VND amount and credit evidence before removing the QR,
stopping polling and showing wallet/course/membership navigation. Expiry hides
the QR but keeps following delayed settlement until the user leaves that intent.
Errors and review states do not assert credit. No schema or merchant changes.
Regression verification uses mocked APIs and creates no real payment.


### Learner cancellation

POST /wallet/gds/topups/:topupId/cancel is student-owned and uses the same UAT
gates as QR creation. Before cancellation, authenticated PayOS GET must match
link, order and exact amount with zero paid and no transactions. The cancel
response must independently match those facts and report CANCELLED.
A conditional serializable update changes only the local pending status; newly
arrived signed inbox, reconciliation or journal evidence prevents that update.
Provider errors retain the intent and polling. A prior remote cancellation can
be recovered without another remote cancel. No receiving-account, journal or
balance changes are made. The dialog requires explicit learner confirmation.
Provider contract: https://payos.vn/docs/api/ (cancel payment link).


### UAT course for checkout verification

Created course 86573544-6fe6-469b-b12e-87128b4cf53a, slug
kiem-thu-thanh-toan-10000-uat, fixed price 10000 VND, published/public, active
commerce product and one protected article lesson. It is clearly labelled UAT.
Creation used existing course, lesson, publication and commerce services with
the existing demo instructor/admin, without changing roles or existing courses.
No orders, payments, enrollments, grants or wallet entries were created.

The bounded script scripts/create-payw-uat-course.cjs defaults to dry-run and
requires --uat --expected-db-fingerprint <reviewed-host-and-db-fingerprint>.
Use --apply only for the reviewed isolated UAT database. It refuses conflicting
existing fixtures before writes; a verified repeat returns changed:false.
Checks: guard tests PASS; live public course API HTTP200 with price
{amountMinor:10000,currency:VND}; repeated apply changed:false.


### GDS course and membership checkout source-validator fix

The historical commerce_validate_settlement trigger classified wallet_capture
as external provider_collection and rejected it despite valid GDS journal proof.
The additive 20261103030000 migration adds a separate guarded GDS branch,
preserving existing provider and zero-payable checks. It requires the exact
order owner, captured hold, immutable CAPTURE journal, VND amount/reference,
pending order and no competing external attempt or settlement.
Regression now installs the actual historical source trigger: the old isolated
fixture omitted it. Tests cover valid capture and adversarial proof failures.
The migration replay workflow additionally runs real course/membership services
against its disposable PostgreSQL database, including concurrent replay.
No existing customer order is paid by deployment or migration.
