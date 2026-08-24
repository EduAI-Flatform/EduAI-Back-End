const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const RUNTIME_ENV_FILE = '.env';
const ASSESSMENT_KEYS = [
  'commerceTablesPresent',
  'runtimeRoleSuperuser',
  'runtimeRoleHasBypassRlsAttribute',
  'runtimeRoleOwnsCommerceTables',
  'runtimeRoleCanAssumeCommerceOwner',
  'runtimeRoleCanBypassCommerceGuards',
  'runtimeRoleCanDisableCommerceTriggers',
  'runtimeRoleLeastPrivilegeReady',
];

const RUNTIME_ROLE_QUERY = `
WITH runtime_role AS (
  SELECT oid, rolsuper, rolbypassrls
  FROM pg_roles
  WHERE rolname = current_user
), commerce_tables AS (
  SELECT relation.relowner
  FROM pg_class AS relation
  INNER JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND left(relation.relname, 9) = 'commerce_'
), capabilities AS (
  SELECT
    EXISTS (SELECT 1 FROM commerce_tables) AS commerce_tables_present,
    COALESCE((SELECT rolsuper FROM runtime_role), true) AS runtime_role_superuser,
    COALESCE((SELECT rolbypassrls FROM runtime_role), true)
      AS runtime_role_has_bypass_rls_attribute,
    EXISTS (
      SELECT 1
      FROM commerce_tables, runtime_role
      WHERE commerce_tables.relowner = runtime_role.oid
    ) AS runtime_role_owns_commerce_tables,
    EXISTS (
      SELECT 1
      FROM commerce_tables
      WHERE pg_has_role(current_user, commerce_tables.relowner, 'MEMBER')
         OR pg_has_role(current_user, commerce_tables.relowner, 'USAGE')
    ) AS runtime_role_can_assume_commerce_owner
)
SELECT
  commerce_tables_present AS "commerceTablesPresent",
  runtime_role_superuser AS "runtimeRoleSuperuser",
  runtime_role_has_bypass_rls_attribute AS "runtimeRoleHasBypassRlsAttribute",
  runtime_role_owns_commerce_tables AS "runtimeRoleOwnsCommerceTables",
  runtime_role_can_assume_commerce_owner AS "runtimeRoleCanAssumeCommerceOwner"
FROM capabilities
`;

function loadRuntimeDatabaseUrl(rootDirectory) {
  let parsed;
  try {
    parsed = dotenv.parse(
      readFileSync(join(rootDirectory, RUNTIME_ENV_FILE)),
    );
  } catch {
    throw new Error('Production runtime environment is unavailable');
  }

  const value = parsed.DATABASE_URL?.trim();
  if (!value) {
    throw new Error('Production runtime database configuration is unavailable');
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
      !url.username
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('Production runtime database configuration is invalid');
  }

  return value;
}

function assessRuntimeRole(row) {
  const commerceTablesPresent = requiredBoolean(
    row.commerceTablesPresent,
  );
  const runtimeRoleSuperuser = requiredBoolean(row.runtimeRoleSuperuser);
  const runtimeRoleHasBypassRlsAttribute = requiredBoolean(
    row.runtimeRoleHasBypassRlsAttribute,
  );
  const runtimeRoleOwnsCommerceTables = requiredBoolean(
    row.runtimeRoleOwnsCommerceTables,
  );
  const runtimeRoleCanAssumeCommerceOwner = requiredBoolean(
    row.runtimeRoleCanAssumeCommerceOwner,
  );
  const runtimeRoleCanBypassCommerceGuards =
    runtimeRoleSuperuser ||
    runtimeRoleHasBypassRlsAttribute ||
    runtimeRoleOwnsCommerceTables ||
    runtimeRoleCanAssumeCommerceOwner;
  const runtimeRoleCanDisableCommerceTriggers =
    runtimeRoleSuperuser ||
    runtimeRoleOwnsCommerceTables ||
    runtimeRoleCanAssumeCommerceOwner;

  return {
    commerceTablesPresent,
    runtimeRoleSuperuser,
    runtimeRoleHasBypassRlsAttribute,
    runtimeRoleOwnsCommerceTables,
    runtimeRoleCanAssumeCommerceOwner,
    runtimeRoleCanBypassCommerceGuards,
    runtimeRoleCanDisableCommerceTriggers,
    runtimeRoleLeastPrivilegeReady:
      commerceTablesPresent &&
      !runtimeRoleCanBypassCommerceGuards &&
      !runtimeRoleCanDisableCommerceTriggers,
  };
}

function requiredBoolean(value) {
  if (typeof value !== 'boolean') {
    throw new Error('Runtime database role metadata is incomplete');
  }
  return value;
}

function assertRuntimeRoleReady(assessment) {
  if (assessment.runtimeRoleLeastPrivilegeReady !== true) {
    throw new Error(
      'Production runtime database role is not least-privilege ready',
    );
  }
}

function logAssessment(assessment) {
  for (const key of ASSESSMENT_KEYS) {
    console.log(`${key}: ${assessment[key] === true}`);
  }
}

async function run() {
  const client = new Client({
    application_name: 'eduai-runtime-role-verifier',
    connectionString: loadRuntimeDatabaseUrl(process.cwd()),
    connectionTimeoutMillis: 10000,
    options: '-c default_transaction_read_only=on',
    query_timeout: 10000,
    statement_timeout: 10000,
  });

  try {
    await client.connect();
    const result = await client.query(RUNTIME_ROLE_QUERY);
    if (result.rowCount !== 1) {
      throw new Error('Runtime database role metadata is incomplete');
    }

    const assessment = assessRuntimeRole(result.rows[0]);
    logAssessment(assessment);
    assertRuntimeRoleReady(assessment);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch(() => {
    console.error('Production runtime database-role verification failed');
    process.exitCode = 1;
  });
}

module.exports = {
  RUNTIME_ROLE_QUERY,
  assessRuntimeRole,
  assertRuntimeRoleReady,
  loadRuntimeDatabaseUrl,
};
