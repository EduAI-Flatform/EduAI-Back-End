-- Source-only PAYW-04C; NOT approved for production migration.
-- PostgreSQL requires committing an enum addition before using the new value.
ALTER TYPE "commerce_settlement_kind" ADD VALUE IF NOT EXISTS 'wallet_capture';
