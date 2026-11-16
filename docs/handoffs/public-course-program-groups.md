# Public course program groups

Course-policy categories gain a stable optional-on-input `id`. Defaults identify
online, k12, vocational, higher-education, joint-programs and scholarships. Admin
may rename, reorder, remove or add groups through the existing revision workflow.
Only `online` binds the existing native course catalog. Other ids remain truthful
unconnected program destinations until a real integration supplies program data.
This does not repurpose Course.categorySlug or change voucher/scholarship scopes.

Historical label-only revisions are accepted without mutation. Known original
English labels resolve to default ids independently of array order. Unknown
labels receive distinct legacy ids and never imply native catalog connectivity.
Explicit ids are preserved, validated as unique safe slugs, and new Admin forms
keep them when changing translations/order. Invalid explicit ids, extra fields
and empty labels are rejected. No migration or business policy activation occurs.

Frontend provides a desktop sidebar/mobile native select, URL-driven group and
filter state, truthful unavailable states and the existing partner-onboarding
destination. The successful native catalog is cached; clamping waits for loaded
data so Back to a pending page2 cannot become page1. Discrete filters push history;
continuous search typing retains the existing replace behavior.

Local evidence: backend build and64 focused policy tests passed; frontend14
targeted tests and4 Chromium scenarios cover both locales, historical/current
configuration and seven widths each. Chrome DevTools observed official assets,
Be Vietnam Pro, no overflow at320/1440 and no page errors on the inspected view.
Scoped independent review found history/clamp issues, corrected with regressions;
second review found no remaining substantive issue. Cross-model CLI was skipped
in this autonomous context. Final CI, release and deployed acceptance are pending.
