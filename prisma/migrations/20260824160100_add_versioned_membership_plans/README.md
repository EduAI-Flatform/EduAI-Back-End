# Versioned membership plan migration recovery

This is an additive, forward-only migration. Before any membership version is
published or referenced by a Commerce product, rollback may remove the unused
objects. After publication or reference, rollback must preserve plan, version,
duration, audit, and Commerce history and use a later additive recovery
migration.

Application containment archives affected plans or blocks the affected route;
it never rewrites a published version or duration price. Payment-provider
activation remains independent and unchanged.
