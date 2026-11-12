const { Client } = require('pg');

const MEMBERSHIP_RUNTIME_TABLES = Object.freeze([
  'revenue_participations',
  'revenue_plan_policies',
  'revenue_retail_policies',
  'commerce_fulfillment_effects',
  'commerce_notification_outbox',
  'course_access_grants',
  'membership_checkout_intents',
  'membership_duration_options',
  'membership_plan_entitlements',
  'membership_plan_included_courses',
  'membership_plan_versions',
  'membership_plans',
  'membership_removed_course_snapshots',
  'membership_subscriptions',
  'service_entitlement_definitions',
  'service_entitlement_grants',
  'service_entitlement_usage',
]);
const REVENUE_APPEND_ONLY_TABLES = Object.freeze([
  'revenue_terms',
  'revenue_participation_events',
  'revenue_order_snapshots',
  'revenue_earning_periods',
  'revenue_ledger_entries',
]);

const GDS_RUNTIME_TABLES = Object.freeze([
  'gds_internal_wallets', 'gds_internal_topups', 'gds_internal_holds',
  'gds_internal_journal', 'gds_internal_payos_inbox', 'gds_internal_payos_reconciliations',
]);
const GDS_RUNTIME_UPDATES = Object.freeze({
  gds_internal_wallets: ['updated_at'],
  gds_internal_topups: ['status', 'payment_link_id', 'receiving_account_hash', 'settlement_receiving_account_hash', 'collection_reference', 'signature_verified_at', 'provider_reconciled_at', 'credited_at', 'updated_at'],
  gds_internal_payos_inbox: ['status', 'attempt_count', 'next_attempt_at', 'review_reason', 'processed_at'],
});

// Owner-approved application-role permissions for the additive GDS tables.
// SELECT/INSERT support application requests. UPDATE is lifecycle-only.
const PLATFORM_RUNTIME_UPDATES = Object.freeze({
  platform_policy_revisions: Object.freeze(['status', 'approved_by_id', 'approved_at', 'effective_at']),
  platform_support_tickets: Object.freeze(['status', 'updated_at']),
  platform_support_replies: Object.freeze([]),
  platform_partner_applications: Object.freeze(['status', 'updated_at']),
  user_mfa: Object.freeze(['revision', 'enabled', 'secret_encrypted', 'pending_secret_encrypted', 'pending_expires_at', 'last_used_step', 'recovery_code_hashes', 'enabled_at', 'updated_at']),
  affiliate_identities: Object.freeze([]),
  affiliate_visits: Object.freeze([]),
  affiliate_attributions: Object.freeze([]),
  affiliate_accruals: Object.freeze([]),
});
const PLATFORM_RUNTIME_TABLES = Object.freeze(Object.keys(PLATFORM_RUNTIME_UPDATES));
const PLATFORM_RUNTIME_SCHEMA_QUERY = `
  SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
    AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  GROUP BY c.relname
`;

function buildRuntimePlatformPrivilegeStatement(runtimeUrl, availableTables) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const statements = [];
  for (const { name, columns } of availableTables) {
    if (!PLATFORM_RUNTIME_TABLES.includes(name) || !Array.isArray(columns) || columns.length === 0
      || columns.some(column => typeof column !== 'string' || !column.length)) {
      throw new Error('Unexpected GDS application table metadata');
    }
    const table = quoteIdentifier('public') + '.' + quoteIdentifier(name);
    // Clear former column-level grants too: table REVOKE does not remove them.
    statements.push('REVOKE ALL PRIVILEGES ON TABLE ' + table + ' FROM ' + role + ', PUBLIC');
    statements.push('REVOKE ALL PRIVILEGES (' + columns.map(quoteIdentifier).join(', ') + ') ON TABLE ' + table + ' FROM ' + role + ', PUBLIC');
    statements.push('GRANT SELECT, INSERT ON TABLE ' + table + ' TO ' + role);
    const updates = PLATFORM_RUNTIME_UPDATES[name].filter(column => columns.includes(column));
    if (updates.length) {
      statements.push('GRANT UPDATE (' + updates.map(quoteIdentifier).join(', ') + ') ON TABLE ' + table + ' TO ' + role);
    }
  }
  return statements.join('; ');
}

function buildRuntimeGdsPrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const table = name => quoteIdentifier('public') + '.' + quoteIdentifier(name);
  const all = GDS_RUNTIME_TABLES.map(table).join(', ');
  const statements = [
    'REVOKE ALL PRIVILEGES ON TABLE ' + all + ' FROM ' + role + ', PUBLIC',
    'GRANT SELECT ON TABLE ' + all + ' TO ' + role,
    'GRANT INSERT ON TABLE public.gds_internal_wallets TO ' + role,
    'GRANT INSERT ON TABLE public.gds_internal_topups, public.gds_internal_journal, public.gds_internal_payos_inbox, public.gds_internal_payos_reconciliations TO ' + role,
    'REVOKE EXECUTE ON FUNCTION public.gds_internal_apply_journal() FROM ' + role + ', PUBLIC',
  ];
  for (const [name, columns] of Object.entries(GDS_RUNTIME_UPDATES)) {
    statements.push('GRANT UPDATE (' + columns.map(quoteIdentifier).join(', ') + ') ON TABLE ' + table(name) + ' TO ' + role);
  }
  return statements.join('; ');
}

// Separate from legacy grants so pre-withdrawal schemas remain supported.
function buildRuntimeGdsWithdrawalPrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const tables = ['gds_withdrawal_settings','gds_withdrawals','gds_withdrawal_events','gds_revenue_projections','gds_revenue_effects']
    .map(name => 'public.' + quoteIdentifier(name)).join(', ');
  return [
    'REVOKE ALL PRIVILEGES ON TABLE ' + tables + ' FROM ' + role + ', PUBLIC',
    'GRANT SELECT ON TABLE ' + tables + ' TO ' + role,
    'GRANT INSERT ON TABLE public.gds_withdrawals, public.gds_withdrawal_events, public.gds_revenue_projections, public.gds_revenue_effects TO ' + role,
    'GRANT UPDATE (minimum_minor, maximum_minor, version, admission_enabled, processing_enabled, updated_at) ON public.gds_withdrawal_settings TO ' + role,
    'GRANT UPDATE (historical_paid_minor, review_required, reviewed_by_id, reviewed_at, review_reason) ON public.gds_revenue_projections TO ' + role,
    'REVOKE EXECUTE ON FUNCTION public.gds_withdrawal_new(), public.gds_withdrawal_event_apply(), public.gds_extended_journal_apply(), public.gds_revenue_effect_apply() FROM ' + role + ', PUBLIC',
  ].join('; ');
}

// Applied only after the additive recipient-verification migration exists.
function buildRuntimeGdsVerificationPrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  return [
    'REVOKE ALL PRIVILEGES ON public.gds_account_verifications FROM ' + role + ', PUBLIC',
    'GRANT SELECT, INSERT ON public.gds_account_verifications TO ' + role,
    'GRANT UPDATE (account_verification_required) ON public.gds_withdrawal_settings TO ' + role,
  ].join('; ');
}

// Kept additive so grant recovery still supports schemas before affiliate posting.
function buildRuntimeAffiliateWalletPrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  return [
    'REVOKE ALL PRIVILEGES ON public.affiliate_wallet_effects FROM ' + role + ', PUBLIC',
    'GRANT SELECT, INSERT ON public.affiliate_wallet_effects TO ' + role,
    'REVOKE EXECUTE ON FUNCTION public.affiliate_wallet_apply(), public.affiliate_wallet_lock(), public.gds_spending_debt_guard() FROM ' + role + ', PUBLIC',
  ].join('; ');
}

const LEGACY_RECONCILIATION_MARKER_TABLE =
  'commerce_reconciliation_legacy_acknowledgements';

function runtimeRoleFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') ||
      !parsed.username
    ) {
      throw new Error();
    }
    return decodeURIComponent(parsed.username);
  } catch {
    throw new Error('DATABASE_URL must identify a PostgreSQL runtime role');
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildRuntimePrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const tables = MEMBERSHIP_RUNTIME_TABLES.map(
    (table) => `${quoteIdentifier('public')}.${quoteIdentifier(table)}`,
  ).join(', ');
  return `GRANT SELECT, INSERT, UPDATE ON TABLE ${tables} TO ${role}`;
}

function buildRuntimeRevenuePrivilegeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const tables = REVENUE_APPEND_ONLY_TABLES.map(
    (table) => quoteIdentifier('public') + '.' + quoteIdentifier(table),
  ).join(', ');
  return 'GRANT SELECT, INSERT ON TABLE ' + tables + ' TO ' + role +
    '; REVOKE UPDATE, DELETE ON TABLE ' + tables + ' FROM ' + role;
}

function buildRuntimeLegacyMarkerRevokeStatement(runtimeUrl) {
  const role = quoteIdentifier(runtimeRoleFromUrl(runtimeUrl));
  const table = `${quoteIdentifier('public')}.${quoteIdentifier(
    LEGACY_RECONCILIATION_MARKER_TABLE,
  )}`;
  return `REVOKE INSERT, UPDATE, DELETE ON TABLE ${table} FROM ${role}`;
}

async function grantRuntimeMembershipPrivileges(
  migrationUrl,
  runtimeUrl,
  ClientConstructor = Client,
) {
  const client = new ClientConstructor({
    application_name: 'eduai-membership-runtime-grant',
    connectionString: migrationUrl,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(buildRuntimePrivilegeStatement(runtimeUrl));
    await client.query(buildRuntimeRevenuePrivilegeStatement(runtimeUrl));
    await client.query(buildRuntimeGdsPrivilegeStatement(runtimeUrl));
    const withdrawalSchema = await client.query("SELECT to_regclass('public.gds_withdrawals') IS NOT NULL AS ready");
    if (withdrawalSchema?.rows?.[0]?.ready) {
      await client.query(buildRuntimeGdsWithdrawalPrivilegeStatement(runtimeUrl));
      // Activation verifies only the approved migration's public metadata.
      await client.query('GRANT SELECT (migration_name, checksum, finished_at, rolled_back_at) ON public._prisma_migrations TO ' + quoteIdentifier(runtimeRoleFromUrl(runtimeUrl)));
      const verificationSchema = await client.query("SELECT to_regclass('public.gds_account_verifications') IS NOT NULL AS ready");
      if (verificationSchema?.rows?.[0]?.ready) {
        await client.query(buildRuntimeGdsVerificationPrivilegeStatement(runtimeUrl));
      }
    }
    const affiliateSchema = await client.query("SELECT to_regclass('public.affiliate_wallet_effects') IS NOT NULL AS ready");
    if (affiliateSchema?.rows?.[0]?.ready) {
      await client.query(buildRuntimeAffiliateWalletPrivilegeStatement(runtimeUrl));
    }
    // Only named table metadata is inspected. Older schemas skip absent tables.
    const platformSchema = await client.query(PLATFORM_RUNTIME_SCHEMA_QUERY, ['public', PLATFORM_RUNTIME_TABLES]);
    const platformTables = (platformSchema?.rows ?? []).filter(row => typeof row.name === 'string');
    const platformStatement = buildRuntimePlatformPrivilegeStatement(runtimeUrl, platformTables);
    if (platformStatement) await client.query(platformStatement);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('Runtime membership privilege grant failed');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function revokeRuntimeLegacyMarkerPrivileges(
  migrationUrl,
  runtimeUrl,
  ClientConstructor = Client,
) {
  const client = new ClientConstructor({
    application_name: 'eduai-reconciliation-marker-revoke',
    connectionString: migrationUrl,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(buildRuntimeLegacyMarkerRevokeStatement(runtimeUrl));
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('Runtime legacy marker privilege correction failed');
  } finally {
    await client.end().catch(() => undefined);
  }
}

module.exports = {
  PLATFORM_RUNTIME_TABLES,
  PLATFORM_RUNTIME_UPDATES,
  PLATFORM_RUNTIME_SCHEMA_QUERY,
  buildRuntimePlatformPrivilegeStatement,
  buildRuntimeAffiliateWalletPrivilegeStatement,
  GDS_RUNTIME_TABLES,
  GDS_RUNTIME_UPDATES,
  buildRuntimeGdsPrivilegeStatement,
  buildRuntimeGdsWithdrawalPrivilegeStatement,
  buildRuntimeGdsVerificationPrivilegeStatement,
  MEMBERSHIP_RUNTIME_TABLES,
  REVENUE_APPEND_ONLY_TABLES,
  buildRuntimeRevenuePrivilegeStatement,
  LEGACY_RECONCILIATION_MARKER_TABLE,
  buildRuntimePrivilegeStatement,
  buildRuntimeLegacyMarkerRevokeStatement,
  grantRuntimeMembershipPrivileges,
  revokeRuntimeLegacyMarkerPrivileges,
};
