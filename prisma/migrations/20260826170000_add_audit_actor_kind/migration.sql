CREATE TYPE "audit_actor_kind" AS ENUM ('USER', 'SYSTEM', 'PROVIDER');

ALTER TABLE "audit_logs"
  ADD COLUMN "actor_kind" "audit_actor_kind" NOT NULL DEFAULT 'USER',
  ALTER COLUMN "actor_id" DROP NOT NULL;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_shape_check" CHECK (
    ("actor_kind" = 'USER' AND "actor_id" IS NOT NULL)
    OR ("actor_kind" IN ('SYSTEM', 'PROVIDER') AND "actor_id" IS NULL)
  );
