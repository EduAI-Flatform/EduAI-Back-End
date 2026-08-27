const { Client } = require('pg');

const MEMBERSHIP_RUNTIME_TABLES = Object.freeze([
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
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('Runtime membership privilege grant failed');
  } finally {
    await client.end().catch(() => undefined);
  }
}

module.exports = {
  MEMBERSHIP_RUNTIME_TABLES,
  buildRuntimePrivilegeStatement,
  grantRuntimeMembershipPrivileges,
};
