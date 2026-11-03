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
  GDS_RUNTIME_TABLES,
  GDS_RUNTIME_UPDATES,
  buildRuntimeGdsPrivilegeStatement,
  MEMBERSHIP_RUNTIME_TABLES,
  REVENUE_APPEND_ONLY_TABLES,
  buildRuntimeRevenuePrivilegeStatement,
  LEGACY_RECONCILIATION_MARKER_TABLE,
  buildRuntimePrivilegeStatement,
  buildRuntimeLegacyMarkerRevokeStatement,
  grantRuntimeMembershipPrivileges,
  revokeRuntimeLegacyMarkerPrivileges,
};
