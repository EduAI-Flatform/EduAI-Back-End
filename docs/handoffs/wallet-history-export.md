# Filtered wallet history Excel export

GET /wallet/gds/transactions/export accepts the same filter enum as history.
Existing JWT/learner-instructor guards derive the owner, and wallet read capability
is required. The endpoint is limited to five requests per authenticated user/minute.

It reads the existing shared SQL history inside RepeatableRead, with an exclusive
asOf event bound. Withdrawal lifecycle deduplication and account masking are shared,
not reimplemented. A technical2000-row limit probes one extra row; overflow returns
GDS_HISTORY_EXPORT_LIMIT_EXCEEDED and no partial file. Disabled wallets return
GDS_WALLET_UNAVAILABLE. Filter validation retains GDS_HISTORY_INVALID_QUERY.

Response: filename, contentType, dataBase64, exported, scope=filtered_history,
complete=true, filter and asOf. It exports all bounded matching history, not just
the currently displayed page. Amounts are exact minor-unit strings; all workbook
cells are inline text, including formula-like bank labels. Accounts remain masked.
The existing affiliate XLSX writer is reused through a shared text-workbook utility;
its public API and workbook columns remain unchanged. No dependency/schema change.

Regression-first tests failed for the missing API. Final focused Jest: three files,
seven tests passed. Actual SQL integration in isolated PGlite: seven tests passed,
including owner isolation, filters, future exclusion, masking, lifecycle dedup and
unchanged journal row counts after export. Source/controller tests also cover
capability refusal, cap overflow without a file, rate/role/guard metadata, UTF8,
control-character cleanup, BigInt precision and formula-safe text cells.

No production data, posting, audit history or provider was changed. Combined build,
remote CI, native Prisma release checks and frontend download acceptance are root
release gates; these isolated tests are not a production financial activation.
The existing guarded disposable-PostgreSQL withdrawal replay now also invokes
the actual export service through its restricted runtime role, checks owner
isolation/masking and asserts unchanged wallet/withdrawal/journal/audit state.
That added native scenario has not been run locally; its CI result remains required.
