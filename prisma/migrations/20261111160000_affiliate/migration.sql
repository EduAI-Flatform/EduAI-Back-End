CREATE TABLE "affiliate_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" UUID NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affiliate_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_identity_kind_check" CHECK ("kind" IN ('general', 'instructor')),
  CONSTRAINT "affiliate_identity_status_check" CHECK ("status" IN ('active', 'suspended')),
  CONSTRAINT "affiliate_identities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "affiliate_identities_code_key" ON "affiliate_identities"("code");
CREATE UNIQUE INDEX "affiliate_identities_owner_id_kind_key" ON "affiliate_identities"("owner_id", "kind");
CREATE TABLE "affiliate_visits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token_hash" VARCHAR(64) NOT NULL,
  "identity_id" UUID NOT NULL,
  "policy_revision_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "affiliate_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_visit_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "affiliate_visits_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "affiliate_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_visits_policy_revision_id_fkey" FOREIGN KEY ("policy_revision_id") REFERENCES "platform_policy_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "affiliate_visits_token_hash_key" ON "affiliate_visits"("token_hash");
CREATE INDEX "affiliate_visits_expires_at_idx" ON "affiliate_visits"("expires_at");
CREATE TABLE "affiliate_attributions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "buyer_id" UUID NOT NULL,
  "visit_id" UUID NOT NULL,
  "policy_revision_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affiliate_attributions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_attributions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_attributions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "affiliate_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_attributions_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_attributions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "affiliate_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_attributions_policy_revision_id_fkey" FOREIGN KEY ("policy_revision_id") REFERENCES "platform_policy_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "affiliate_attributions_order_id_key" ON "affiliate_attributions"("order_id");
CREATE INDEX "affiliate_attributions_identity_id_created_at_idx" ON "affiliate_attributions"("identity_id", "created_at");
CREATE TABLE "affiliate_accruals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attribution_id" UUID NOT NULL,
  "source_digest" VARCHAR(64) NOT NULL,
  "delta_minor" BIGINT NOT NULL,
  "qualifying_amount_minor" BIGINT NOT NULL,
  "commission_bps" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "hold_until" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affiliate_accruals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_accrual_amount_check" CHECK ("qualifying_amount_minor" >= 0 AND "commission_bps" BETWEEN 0 AND 10000 AND "currency" = 'VND'),
  CONSTRAINT "affiliate_accruals_attribution_id_fkey" FOREIGN KEY ("attribution_id") REFERENCES "affiliate_attributions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "affiliate_accruals_attribution_id_source_digest_key" ON "affiliate_accruals"("attribution_id", "source_digest");
CREATE INDEX "affiliate_accruals_attribution_id_created_at_idx" ON "affiliate_accruals"("attribution_id", "created_at");
CREATE FUNCTION "affiliate_immutable_record"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Affiliate attribution and accrual history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "affiliate_attribution_immutable" BEFORE UPDATE OR DELETE ON "affiliate_attributions"
FOR EACH ROW EXECUTE FUNCTION "affiliate_immutable_record"();
CREATE TRIGGER "affiliate_accrual_immutable" BEFORE UPDATE OR DELETE ON "affiliate_accruals"
FOR EACH ROW EXECUTE FUNCTION "affiliate_immutable_record"();
