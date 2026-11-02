-- PAYW-04 sandbox projection only. No live partner configuration or funding.
CREATE TABLE "buyer_wallet_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "buyer_id" UUID NOT NULL,
  "partner_code" VARCHAR(48) NOT NULL,
  "partner_wallet_ref" VARCHAR(160) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'linked',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "buyer_wallet_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_wallet_links_status_check" CHECK ("status" IN ('linked', 'suspended', 'closed'))
);
CREATE UNIQUE INDEX "buyer_wallet_links_buyer_id_key" ON "buyer_wallet_links"("buyer_id");
CREATE UNIQUE INDEX "buyer_wallet_links_partner_code_partner_wallet_ref_key"
  ON "buyer_wallet_links"("partner_code", "partner_wallet_ref");
ALTER TABLE "buyer_wallet_links"
  ADD CONSTRAINT "buyer_wallet_links_buyer_id_fkey"
  FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "buyer_wallet_verified_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_link_id" UUID NOT NULL,
  "provider_event_id" VARCHAR(160) NOT NULL,
  "provider_transaction_id" VARCHAR(160) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
  "order_id" UUID,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buyer_wallet_verified_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_wallet_verified_events_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "buyer_wallet_verified_events_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "buyer_wallet_verified_events_kind_check" CHECK ("kind" IN (
    'FUNDS_CREDITED', 'PAYMENT_CAPTURED', 'REFUND_CREDITED', 'FUNDS_REVERSED'
  ))
);
CREATE UNIQUE INDEX "buyer_wallet_verified_events_provider_event_id_key"
  ON "buyer_wallet_verified_events"("provider_event_id");
CREATE UNIQUE INDEX "buyer_wallet_verified_events_provider_transaction_id_key"
  ON "buyer_wallet_verified_events"("provider_transaction_id");
CREATE INDEX "buyer_wallet_verified_events_wallet_link_id_occurred_at_idx"
  ON "buyer_wallet_verified_events"("wallet_link_id", "occurred_at");
ALTER TABLE "buyer_wallet_verified_events"
  ADD CONSTRAINT "buyer_wallet_verified_events_wallet_link_id_fkey"
  FOREIGN KEY ("wallet_link_id") REFERENCES "buyer_wallet_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A verified provider event must never be edited to 'fix' financial history.
-- Corrections are separately authenticated compensating events.
CREATE FUNCTION buyer_wallet_reject_event_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Verified wallet events are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER buyer_wallet_verified_events_immutable
  BEFORE UPDATE OR DELETE ON "buyer_wallet_verified_events"
  FOR EACH ROW EXECUTE FUNCTION buyer_wallet_reject_event_mutation();

CREATE TABLE "buyer_wallet_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_link_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "provider_reservation_id" VARCHAR(160) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "buyer_wallet_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buyer_wallet_reservations_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "buyer_wallet_reservations_status_check" CHECK ("status" IN (
    'RESERVED', 'UNKNOWN', 'CAPTURED', 'RELEASED'
  ))
);
CREATE UNIQUE INDEX "buyer_wallet_reservations_order_id_key" ON "buyer_wallet_reservations"("order_id");
CREATE UNIQUE INDEX "buyer_wallet_reservations_provider_reservation_id_key"
  ON "buyer_wallet_reservations"("provider_reservation_id");
CREATE INDEX "buyer_wallet_reservations_wallet_link_id_status_idx"
  ON "buyer_wallet_reservations"("wallet_link_id", "status");
ALTER TABLE "buyer_wallet_reservations"
  ADD CONSTRAINT "buyer_wallet_reservations_wallet_link_id_fkey"
  FOREIGN KEY ("wallet_link_id") REFERENCES "buyer_wallet_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "buyer_wallet_reservations"
  ADD CONSTRAINT "buyer_wallet_reservations_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
