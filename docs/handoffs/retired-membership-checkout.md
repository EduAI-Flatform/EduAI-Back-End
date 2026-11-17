# Retired package checkout cleanup

The HTTP sales/catalog boundaries were already retired. Their unreachable checkout
implementation and exclusive crypto/term/transaction helpers are removed; current()
retains historical subscription/grace reporting. Zero-consumer membership-product
creation and membership-change rules are removed; course products, archival and
historical pricing/calendar helpers remain.

Disposable checkout and receipt scripts now seed canonical historical product,
pending order, original purchase intent and membership line behind their existing
local CI database guards, including normal draft-to-active product transition.
They still execute actual downstream payment, settlement, fulfillment, receipt
conversion, revoke/restore, grant and spent-quota behavior with DB guards enabled.
Restored terms are additionally checked against the original seeded intent.

Revenue tests retain owner/immutable-price and snapshot replay checks using capture
of a historical order rather than invoking retired sales creation.

Verification:64 focused/retained tests, build, script syntax and independent review
passed. Actual disposable PostgreSQL/full-source CI remains required before merge.
No migration, production write, table deletion or historical rights change occurs.
