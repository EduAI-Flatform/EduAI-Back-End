import { Prisma } from '../../../generated/prisma/client';

export const CARD_QUOTA_SCHEMA_MIGRATION = '20261113100000_card_service_limit_provenance';
export const CARD_QUOTA_SCHEMA_SHA256 = '48A43E3EBF07A5B9F9A7066C277EE85DCDDC8E9CCDA6ADEB2A5BC15373B170DF';

export async function readCardServiceReadiness(client: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  try {
    const [state] = await client.$queryRaw<Array<{ migrationVerified: boolean; guardsVerified: boolean;
      schemaVerified: boolean; runtimeVerified: boolean }>>(Prisma.sql`
      SELECT
        (SELECT count(*)=1 FROM public._prisma_migrations WHERE migration_name=${CARD_QUOTA_SCHEMA_MIGRATION}
          AND upper(checksum)=${CARD_QUOTA_SCHEMA_SHA256} AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationVerified",
        (SELECT count(*)=11 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
          AND t.tgenabled IN ('O','A') AND (c.relname,t.tgname) IN (
            ('service_entitlement_grants','membership_card_grant_provenance_immutable'),
            ('service_entitlement_grants','membership_card_grant_validate'),
            ('platform_policy_revisions','membership_card_policy_facts_immutable'),
            ('service_entitlement_definitions','service_entitlement_definitions_immutable'),
            ('service_entitlement_grants','service_entitlement_grants_validate'),
            ('service_entitlement_grants','service_entitlement_grants_immutable'),
            ('service_entitlement_usage','service_entitlement_usage_validate'),
            ('service_entitlement_usage','service_entitlement_usage_append_only'),
            ('service_entitlement_grants','receipt_quota_grant_validate'),
            ('service_entitlement_quota_pools','receipt_quota_pool_validate'),
            ('service_entitlement_quota_pools','receipt_quota_pool_immutable'))) AS "guardsVerified",
        ((SELECT count(*)=4 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.service_entitlement_grants')
          AND attname IN ('card_policy_revision_id','card_tier_code','card_source_digest','card_qualification') AND NOT attisdropped)
          AND (SELECT count(*)=2 FROM pg_catalog.pg_constraint WHERE conrelid=to_regclass('public.service_entitlement_grants')
            AND conname IN ('membership_card_policy_fk','membership_card_grant_provenance_check') AND convalidated)
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=to_regclass('public.membership_card_grant_context_key')
            AND i.indrelid=to_regclass('public.service_entitlement_grants') AND i.indisunique AND i.indisvalid AND i.indisready
            AND i.indnkeyatts=6 AND i.indpred IS NOT NULL
            AND pg_get_indexdef(i.indexrelid,1,true)='user_id' AND pg_get_indexdef(i.indexrelid,2,true)='definition_id'
            AND pg_get_indexdef(i.indexrelid,3,true)='card_policy_revision_id' AND pg_get_indexdef(i.indexrelid,4,true)='card_tier_code'
            AND pg_get_indexdef(i.indexrelid,5,true)='starts_at'
            AND pg_get_indexdef(i.indexrelid,6,true) LIKE 'COALESCE(ends_at,%infinity%'
            AND pg_get_expr(i.indpred,i.indrelid) LIKE '%source_type%MEMBERSHIP_CARD%')) AS "schemaVerified",
        ((SELECT count(*)=2 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname IN ('service_entitlement_grants','service_entitlement_usage')
            AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
            AND c.relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
          AND (SELECT count(*)=4 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname IN ('users','platform_policy_revisions','service_entitlement_definitions','service_entitlement_grants')
              AND has_table_privilege(current_user,c.oid,'SELECT') AND has_any_column_privilege(current_user,c.oid,'UPDATE'))
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND NOT rolsuper AND NOT rolbypassrls)) AS "runtimeVerified"
    `);
    if (state?.migrationVerified && state.guardsVerified && state.schemaVerified && state.runtimeVerified)
      return { ready: true, reason: null } as const;
  } catch { /* Missing schema or permissions never enable quotas or disclose connection details. */ }
  return { ready: false, reason: 'CARD_SERVICE_SCHEMA_NOT_VERIFIED' } as const;
}
