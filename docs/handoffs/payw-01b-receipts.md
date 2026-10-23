# PAYW-01B private receipt intake (synthetic source only)

The new receipt path is disabled by default and always refuses production/staging. It never creates settlement, paid status, order fulfillment or entitlements. Existing bank statements/dual financial approval, PayOS, VNPay and TMI are unchanged.

## Isolated runtime only

Use an independently disposable local/test database and synthetic users/orders/images. The additive migration is source only, not production-authorized. The existing production migration runner must continue to reject unreviewed pending migration sets. Do not execute it to enable this feature.

Set process configuration (never commit real .env): NODE_ENV=test/development; BANK_TRANSFER_SANDBOX_ENABLED=true; BANK_RECEIPT_SANDBOX_ENABLED=true; BANK_RECEIPT_SYNTHETIC_BUYER_IDS=comma-separated synthetic buyer UUIDs; BANK_TRANSFER_SANDBOX_OPERATOR_IDS=authorized synthetic Admin UUIDs. Default flags/empty buyer list deny access. The bank QR receiver remains synthetic; Admin recipient preview is separate.

BANK_RECEIPT_STORAGE_ROOT is optional, absolute and private outside the application directory. Omit for a per-OS-user temp location. POSIX ownership/mode0700, file0600 and ancestor symlink checks apply; Windows uses the user's temp security boundary. This adapter is intentionally not a production storage backend. Images expire after24h; independent minute scheduler deletes at most20 per run and records audit. No-store authorized retrieval prevents public URL sharing. Synthetic metadata remains immutable; real-user metadata retention/privacy needs separate release design.

BANK_RECEIPT_OCR_DATA_PATH must be an absolute LOCAL directory with eng.traineddata and vie.traineddata. Runtime never downloads models or uploads images to a cloud service. Use operator-vetted model assets; official source: https://github.com/tesseract-ocr/tessdata_fast . Test fixture model hashes are recorded in Workspace evidence. Missing models/busy engine/low-confidence/timeout fail closed. No bank secrets are needed.

## API contract

- POST /api/v1/payments/orders/:orderId/receipts: student/owner, Idempotency-Key8–128 safe characters, one multipart field image (JPEG/PNG<=5MiB), no verdict/other fields. Max3 claims/order; API rate limit6 uploads/hour/actor.
- GET /api/v1/payments/orders/:orderId/receipts: owner claims/status.
- GET /api/v1/payments/receipts/:receiptId/image: owner-only private canonical PNG, audit/no-store/nosniff.
- Admin GET /api/v1/admin/commerce/receipt-claims and /:receiptId plus /:receiptId/image: current active allowlisted platform_admin. Separate namespace avoids shadowing existing bank-transfer request routes.

Decode/reencode capped12MP/8192px edge; strip metadata/trailing data; original and canonical SHA prevent exact/recompressed image replay. Similar/cropped/edited/forged images can evade hashes and matching; never assert image authenticity. OCR uses labelled fields only, exact canonical VND/reference/account/payee/time, explicit timezone and optional transaction ID. Ambiguous/missing required fields require review. A scoped bank/account/transaction hash detects reused claim codes but is not bank evidence. A matching forged synthetic receipt still has financialProof=false.

States PROCESSING -> MATCHED_CLAIM/REVIEW_REQUIRED/OCR_FAILED are terminal assessment records, with processing lease5min and expiry/cancel/buyer-state recheck. Same key+same image/order returns existing claim; changed payload409. No payment-confirmation action exists on this controller. No full-access feature is claimed by B; D owns that separate ledger.

## Verification

Run npm test -- --runInBand modules/payments/bank-transfer and npm run test:demo-data -- --runInBand bank-receipt-migration.spec.ts bank-transfer-migration.spec.ts. Existing CI PostgreSQL transaction script now includes four receipt race scenarios and nonfinancial assertions; its disposable DB guard must never be bypassed.

For actual local OCR: build, set NODE_ENV=test and BANK_RECEIPT_OCR_DATA_PATH to vetted local models, then node scripts/test-bank-receipt-ocr.cjs. It renders only a synthetic receipt in memory, asserts seven extracted fields, logs score/warnings, and performs no transfer/order/DB operation. It does not download models.

No deployment, production migration/env edit, real image intake, money collection or GO-LIVE acceptance is implied. Dependency audit findings predate this change; no automatic major framework/toolchain upgrade was applied.

## Subphase D: synthetic unverified access (source implementation)

Two additional environment names (actual `.env` is untouched):
- `BANK_RECEIPT_EARLY_ACCESS_ENABLED`: default `false`; set `true` only in an isolated development/test environment after additive migrations and explicit synthetic fixtures.
- `BANK_RECEIPT_SYNTHETIC_SELLER_IDS`: comma-separated synthetic seller UUIDs. Every order line must belong to this allowlist; the buyer must already be in `BANK_RECEIPT_SYNTHETIC_BUYER_IDS`.

A matched, unexpired receipt can create full learning access through the existing course grant/enrollment/progress boundary. Membership access creates the real term, included course grants, bounded grace grants and configured service entitlements. These writes never confirm the order, create settlement, or mark payment PAID. The separate immutable effect ledger records `UNVERIFIED_RECEIPT_ACCESS`, generation, claim and exact resource IDs. Active readers require the synthetic capability and exact active ledger provenance. A new image never restores a revoked generation.

Student `GET /payments/receipts/:receiptId/access` reads the owned access state. Admin `GET /admin/commerce/receipt-claims/:receiptId/access` reads its state; `POST .../:receiptId/revoke` and `POST .../:receiptId/restore` require an active allowlisted platform administrator, `Idempotency-Key`, a reason of 8–300 characters and `expectedGeneration >= 1`. Revocation remains available with the early-grant switch off while the receipt review sandbox itself is enabled. Restore creates a new generation with original windows, rather than reactivating terminal grants. Financial bank approval routes and their two-person rules remain unchanged.

Canonical settlement conversion runs in the existing fulfillment transaction after financial proof. It retires only exact receipt resources and creates normal paid resources; a concurrent Admin revocation cannot remove another source's paid access. Membership emergency course revocation includes receipt membership effects, excluding independent receipt course purchases. The current-membership API identifies pending reconciliation explicitly.

### Decision: preserve consumed quota through restore and paid conversion

Service quota previously belonged to a grant ID. Because revoked grants are terminal, restoring or converting to paid creates a different grant; copying the initial quota would refill consumed units. An immutable `(orderLineId, definitionId)` pool therefore binds the original snapshot and period. Each receipt generation and its eventual paid grant points to the same pool at creation. Usage remains append-only on its original grant and is aggregated across all pool grants, including revoked grants. SQL locks the pool during consumption and enforces remaining quota and exact period boundaries. Calendar resets retain their existing semantics. Legacy grants with no pool retain existing behavior. Paid pooling is independent of the early-access switch.

Rejected alternatives: reopening revoked grants (breaks terminal provenance), fabricated carry-forward usage (obscures the audit trail), resetting quota on each generation (over-allocation). Production deployment requires reviewed additive migrations `20261023020000_add_receipt_access` and `20261023021000_add_receipt_quota_pools` before this source revision; disabled flags do not eliminate the schema requirement. No production migration or deployment has been performed.

Known boundary: existing membership overlap/change rules remain in force; an unsupported overlapping term requires review and does not silently grant. Admin browser confirmation, responsive UI and end-to-end website evidence belong to E/F and are not established by these Backend tests.
## Subphase E: review interface contract

Admin list/detail now adds protected buyer/order/line facts through one bounded batched order query. Buyer receipt responses remain unchanged. Admin access details include up to200 ordered immutable access events with actor, generation, reason and timestamp. Current membership returns pending purchase/renewal orders as well as upgrade/downgrade so the website can link to the existing checkout after reload. No automatic new order is created by that recovery.

Bank checkout returns `receiptReviewEnabled` for eligible synthetic receipt users even after the payment window closes; `receiptUploadEnabled` remains pending-window-only. Image retention and ownership checks still apply. Existing bank approval accepts an optional8–300character reason, written into the existing audit metadata; source/amount/reference/digest/account checks and two distinct currently-authorized Admin approvals are unchanged. This is additive compatibility for older clients.

Review fix: an authorized Admin can inspect/revoke the isolated source of a buyer who has since been disabled; grant/restore still requires the buyer to be active. This does not permit buyer reads or rights restoration for a disabled buyer.

Frontend route: `/admin/dashboard/receipt-review`. Private PNGs load via authenticated no-store fetch and short-lived object URLs, never public file URLs. Financial approval selects pre-existing bank-source evidence; the UI cannot convert customer OCR into bank evidence. New source ingestion and a one-operator substitute remain outside this change. Customer can use the existing support/appeal request in QR checkout; access-state notices identify the affected order/source. No new outbound notification channel or production delivery is enabled.