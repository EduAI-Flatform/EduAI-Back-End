# Receipt contention recovery — verifying

Point rollout remains held: merged main `61f0318` passed point migration replay and source/build, but post-merge bank-concurrency run `43217642512` failed with `RECEIPT_CONCURRENT_OPERATION`; one targeted retry reproduced it. Production point migration has not run and backend auto-CD remains temporarily false.

Diagnostic PR 37 initially passed ten scoped replay races. Increasing the unchanged assertions to forty reproduced the failure in job `131187816896` on `cc5914e`; the stack identifies receipt claim creation (`BankReceiptService.upload`, compiled line 48), rather than OCR finalization.

The proposed correction removes the broad pre-insert image OR query. Existing database UNIQUE constraints on both image digests remain authoritative, including competing transactions, and P2002 still maps to `RECEIPT_ALREADY_USED`. Ownership checks, the three-claim cap, Serializable isolation, retry bounds, review for reused bank transaction codes and all financial guards remain unchanged. PostgreSQL documents that sequential scans require relation-level predicate locks and serialization failures require full transaction retries: [PostgreSQL 16 transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).

Thirty focused receipt-service tests passed, including a regression for the broad predicate conflict and database uniqueness rejection without storage/OCR side effects. The forty-race real PostgreSQL test must pass on the correction before this is treated as verified. Do not keep retrying the failed main job without new evidence, skip assertions or relax isolation/duplicate protection.

After final PR checks/review/merge and post-merge verification, resume the existing scoped point rollout. Restore backend auto-CD to its prior true value only after verified deployment. The full GDS plan, authenticated production UAT and legacy entitlement migration remain open.
