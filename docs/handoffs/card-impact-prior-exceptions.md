# Membership impact comparison exceptions

Switching a card policy from top-ups to spending could report a complete preview
even when the current policy's top-up proof was unavailable. Candidate results
were valid, but change counts silently excluded the affected account.

The read-only preview now retains `previousEvaluation` on each row and propagates
an unavailable evaluation on either side to the page status, reason and completeness.
Additive `comparedUsersOnPage` and `incomparableUsersOnPage` distinguish known
comparisons from exceptions. Counts remain page-local; cursor and bounded scan
semantics are unchanged. Candidate-only calls require no previous evaluation.

Two behavior regressions failed before the fix and now pass with all15 source
tests. Backend build passed. Independent review found no substantive issue.
No schema, policy activation, entitlement, transaction or balance mutation changed.
