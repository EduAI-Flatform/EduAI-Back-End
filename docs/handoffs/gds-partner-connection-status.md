# Partner catalog connection status

The existing `partners` configuration accepts an optional `connectionStatus` per catalog item: `unconfigured`, `preparing`, `testing`, `connected` or `suspended`. It is Admin-recorded metadata, distinct from application review (`submitted`/`reviewing`/`contacted`/`accepted`/`rejected`). The existing draft, preview, approval, effective-date and audit lifecycle is retained.

Historical JSON without the field remains valid and is interpreted as unconfigured by the Admin form. Validation normalizes a copy; it does not rewrite immutable revisions. Explicit null, arbitrary statuses, credential fields and unsafe URLs are rejected. Existing response envelopes and item fields are unchanged. The public configuration endpoint exposes this non-secret metadata through its existing partners group; no credentials or provider endpoints are added.

Recording a state, including connected, does not activate an adapter, enable application intake, provision users, award points or modify purchased access. No school exists yet; actual API/SSO connections still require a partner contract, implementation and verification. No migration or dependency is added. Deploy backend before the new frontend. If UI rollback is needed, retain backend compatibility for revisions that already contain this additive field.

Verification includes historical/invalid-input unit coverage, VI/EN native Admin draft save/reload at seven widths, and the disposable real PostgreSQL policy lifecycle/reload scenario. CI results and release evidence are recorded separately in Workspace; the integration script is not proof until it has actually passed.
