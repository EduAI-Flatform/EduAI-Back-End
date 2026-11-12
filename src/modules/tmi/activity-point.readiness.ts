import { Prisma } from '../../../generated/prisma/client';

export const POINT_SCHEMA_MIGRATION = '20261112180000_activity_points';
export const POINT_SCHEMA_SHA256 = '2CB0A2157FA15329AB0870ED46E30F3BFB3BAC4DB4B05498582B32185029A355';

export async function readActivityPointReadiness(client: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  try {
    const [state] = await client.$queryRaw<Array<{ migrationVerified: boolean; guardsVerified: boolean;
      schemaVerified: boolean; runtimeVerified: boolean }>>(Prisma.sql`
      SELECT
        (SELECT count(*)=1 FROM public._prisma_migrations WHERE migration_name=${POINT_SCHEMA_MIGRATION}
          AND upper(checksum)=${POINT_SCHEMA_SHA256} AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationVerified",
        (SELECT count(*)=7 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
          AND t.tgenabled='O' AND (c.relname,t.tgname) IN (
            ('point_activity_receipts','point_activity_receipts_immutable'), ('point_activity_receipts','point_activity_source_guard'),
            ('point_expiry_settlements','point_expiry_settlements_immutable'), ('point_expiry_settlements','point_expiry_source_guard'),
            ('tmi_ledger_entries','point_posting_receipt_required'), ('tmi_ledger_entries','point_native_ledger_immutable'),
            ('tmi_ledger_entries','point_native_refund_source_guard'))
          AND (t.tgname<>'point_posting_receipt_required' OR (t.tgdeferrable AND t.tginitdeferred))) AS "guardsVerified",
        (to_regclass('public.point_activity_receipts') IS NOT NULL AND to_regclass('public.point_expiry_settlements') IS NOT NULL
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.tmi_ledger_entries')
            AND attname='posting_sequence' AND attnotnull AND NOT attisdropped)) AS "schemaVerified",
        (CASE WHEN to_regclass('public.tmi_ledger_entries_posting_sequence_seq') IS NOT NULL
          THEN has_sequence_privilege(current_user,to_regclass('public.tmi_ledger_entries_posting_sequence_seq'),'USAGE')
            AND NOT has_sequence_privilege(current_user,to_regclass('public.tmi_ledger_entries_posting_sequence_seq'),'UPDATE')
          ELSE false END AND
          (SELECT count(*)=2 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname IN ('point_activity_receipts','point_expiry_settlements')
            AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
            AND NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE'))) AS "runtimeVerified"
    `);
    if (state?.migrationVerified && state.guardsVerified && state.schemaVerified && state.runtimeVerified)
      return { ready: true, reason: null } as const;
  } catch { /* Schema/permission failures must not expose connection details or enable accrual. */ }
  return { ready: false, reason: 'POINT_SCHEMA_NOT_VERIFIED' } as const;
}
