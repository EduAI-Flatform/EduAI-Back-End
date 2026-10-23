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
