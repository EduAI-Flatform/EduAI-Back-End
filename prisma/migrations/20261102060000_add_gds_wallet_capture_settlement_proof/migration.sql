-- Source-only PAYW-04C; NOT approved for production migration.
-- GDS is an internal balance capture, NOT an external provider payment event.
-- Preserve all existing provider and zero-payable settlement invariants.
ALTER TABLE "commerce_settlements" DROP CONSTRAINT "commerce_settlements_shape_check";
ALTER TABLE "commerce_settlements" ADD CONSTRAINT "commerce_settlements_shape_check" CHECK (
  (
    "kind" = 'provider_collection'
    AND "disposition" IN ('matched', 'duplicate_collection', 'late_collection')
    AND "payment_attempt_id" IS NOT NULL
    AND "payment_event_id" IS NOT NULL
    AND "provider" IS NOT NULL
    AND "provider_settlement_reference" IS NOT NULL
    AND "amount_minor" > 0
  ) OR (
    "kind" = 'no_payment_required'
    AND "disposition" = 'internal'
    AND "payment_attempt_id" IS NULL
    AND "payment_event_id" IS NULL
    AND "provider" IS NULL
    AND "provider_settlement_reference" IS NULL
    AND "amount_minor" = 0
  ) OR (
    "kind" = 'wallet_capture'
    AND "disposition" = 'internal'
    AND "payment_attempt_id" IS NULL
    AND "payment_event_id" IS NULL
    AND "provider" = 'gds'
    AND "provider_settlement_reference" LIKE 'gds:order:%'
    AND "amount_minor" > 0
  )
);
