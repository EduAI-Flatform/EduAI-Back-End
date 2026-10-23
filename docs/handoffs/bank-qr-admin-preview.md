# PAYW-01B — Admin bank QR preview (read-only, not GO-LIVE)

This endpoint helps an authorized `platform_admin` scan a QR **without** opening real payment collection or changing the sandbox settlement model.

## VPS-only configuration (performed by the owner)

Set these Backend environment variables privately after reviewing the company's receiving bank account:

```dotenv
BANK_TRANSFER_PREVIEW_ENABLED=true
BANK_TRANSFER_RECEIVER_BANK_NAME="MB Bank"
BANK_TRANSFER_RECEIVER_BANK_BIN=970422
BANK_TRANSFER_RECEIVER_ACCOUNT_NUMBER=<company_receiving_account>
BANK_TRANSFER_RECEIVER_NAME="<exact_bank_beneficiary_name>"
```

The values above are **not** required for deploy and should remain disabled until the owner deliberately enables preview. Never commit any production `.env` to Git. Apply/restart through the approved production process, then turn preview off if it is no longer needed. Do not set the sandbox transfer flag in production; it cannot enable the payment method.

An authenticated Admin calls `GET /api/v1/admin/commerce/bank-transfers/qr-preview`. The JSON returns `qrCodeDataUrl`, `bankBin`, `accountNumber`, `beneficiaryName`, exact `amountMinor=1000`, and `transferContent=EDUAIPREVIEW`. The bank app may resolve its **own** registered beneficiary name; compare that to the company's verified legal name. **Do not submit a transfer.** A bank scan establishes only that the QR routes to the displayed recipient, not company collection authority, receipt of funds, or automatic settlement.

`BANK_TRANSFER_PREVIEW_ENABLED=false` responds with `BANK_QR_PREVIEW_DISABLED` and the endpoint never creates a payment attempt, order, settlement, financial transaction or course entitlement. Existing `bank_transfer` checkout remains unavailable in production; `PAYW-01B` release gates and `SPR25-007` are unchanged.

## Changing the receiving account in the future

Change **all four** `BANK_TRANSFER_RECEIVER_*` fields together through an approved rollout and verify by a **new** QR scan. To change banks, also supply its correct 6-digit bank BIN and display name, not just a new account number. A future live implementation must snapshot bank BIN, account and beneficiary on each order; changing the global receiver cannot mutate historical bank-transfer requests or paid evidence. Current PAYW-01 sandbox requests already snapshot their synthetic receiver. This preview endpoint does not itself constitute the future live receiver configuration or a historical-order migration.
