-- Support bounded administrative aggregates that exclude soft-deleted users.
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");
