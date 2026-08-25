const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const {
  MEMBERSHIP_RUNTIME_TABLES,
} = require('./membership-runtime-privileges.cjs');

const RUNTIME_ENV_FILE = '.env';
const VERIFICATION_STAGES = new Set([
  'configuration',
  'connection',
  'transaction',
  'metadata-query',
  'assessment',
  'assertion',
]);
const ASSESSMENT_KEYS = [
  'commerceTablesPresent',
  'membershipTablesPresent',
  'runtimeRoleCanUseMembershipTables',
  'runtimeRoleSuperuser',
  'runtimeRoleHasBypassRlsAttribute',
  'runtimeRoleOwnsCommerceTables',
  'runtimeRoleCanAssumeCommerceOwner',
  'runtimeRoleCanBypassCommerceGuards',
  'runtimeRoleCanDisableCommerceTriggers',
  'runtimeRoleLeastPrivilegeReady',
];

const membershipTableValues = MEMBERSHIP_RUNTIME_TABLES.map(
  (table) => `('${table}')`,
).join(', ');

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
), membership_tables(relation_name) AS (
  VALUES ${membershipTableValues}
), membership_capabilities AS (
  SELECT
    COUNT(*) = COUNT(to_regclass('public.' || relation_name))
      AS membership_tables_present,
    COALESCE(BOOL_AND(
      to_regclass('public.' || relation_name) IS NOT NULL
      AND has_table_privilege(current_user, 'public.' || relation_name, 'SELECT')
      AND has_table_privilege(current_user, 'public.' || relation_name, 'INSERT')
      AND has_table_privilege(current_user, 'public.' || relation_name, 'UPDATE')
    ), false) AS runtime_role_can_use_membership_tables
  FROM membership_tables
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
  membership_tables_present AS "membershipTablesPresent",
  runtime_role_can_use_membership_tables AS "runtimeRoleCanUseMembershipTables",
  runtime_role_superuser AS "runtimeRoleSuperuser",
  runtime_role_has_bypass_rls_attribute AS "runtimeRoleHasBypassRlsAttribute",
  runtime_role_owns_commerce_tables AS "runtimeRoleOwnsCommerceTables",
  runtime_role_can_assume_commerce_owner AS "runtimeRoleCanAssumeCommerceOwner"
FROM capabilities
CROSS JOIN membership_capabilities
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

function buildRuntimeClientConfig(connectionString) {
  return {
    application_name: 'eduai-runtime-role-verifier',
    connectionString,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  };
}

function assessRuntimeRole(row) {
  const commerceTablesPresent = requiredBoolean(
    row.commerceTablesPresent,
  );
  const membershipTablesPresent = requiredBoolean(
    row.membershipTablesPresent,
  );
  const runtimeRoleCanUseMembershipTables = requiredBoolean(
    row.runtimeRoleCanUseMembershipTables,
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
    membershipTablesPresent,
    runtimeRoleCanUseMembershipTables,
    runtimeRoleSuperuser,
    runtimeRoleHasBypassRlsAttribute,
    runtimeRoleOwnsCommerceTables,
    runtimeRoleCanAssumeCommerceOwner,
    runtimeRoleCanBypassCommerceGuards,
    runtimeRoleCanDisableCommerceTriggers,
    runtimeRoleLeastPrivilegeReady:
      commerceTablesPresent &&
      membershipTablesPresent &&
      runtimeRoleCanUseMembershipTables &&
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

function createSafeFailureDiagnostic(error, stage = 'unknown') {
  const safeStage = VERIFICATION_STAGES.has(stage) ? stage : 'unknown';
  const code =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : '';
  const message = error instanceof Error ? error.message : '';

  let failureClass;
  if (/unsupported startup parameter/i.test(message)) {
    failureClass = 'POOLED_STARTUP_PARAMETER_UNSUPPORTED';
  } else if (code === '28P01' || code === '28000') {
    failureClass = 'DATABASE_AUTHENTICATION_FAILED';
  } else if (code === '42501') {
    failureClass = 'DATABASE_METADATA_PERMISSION_DENIED';
  } else if (code === '57014' || message === 'Query read timeout') {
    failureClass = 'DATABASE_METADATA_QUERY_TIMEOUT';
  } else if (code.startsWith('42')) {
    failureClass = 'DATABASE_METADATA_QUERY_INVALID';
  } else if (code.startsWith('08') || /^E(?:CONN|HOST|PIPE|AI_)/.test(code)) {
    failureClass = 'DATABASE_CONNECTION_FAILED';
  } else if (message === 'Runtime database role metadata is incomplete') {
    failureClass = 'DATABASE_ROLE_METADATA_INCOMPLETE';
  } else if (
    message === 'Production runtime database role is not least-privilege ready'
  ) {
    failureClass = 'DATABASE_ROLE_NOT_LEAST_PRIVILEGE';
  } else if (safeStage === 'configuration') {
    failureClass = 'RUNTIME_DATABASE_CONFIGURATION_INVALID';
  } else if (safeStage === 'connection') {
    failureClass = 'DATABASE_CONNECTION_FAILED';
  } else if (safeStage === 'transaction' || safeStage === 'metadata-query') {
    failureClass = 'DATABASE_METADATA_QUERY_FAILED';
  } else {
    failureClass = 'UNKNOWN_VERIFICATION_FAILURE';
  }

  return { stage: safeStage, failureClass };
}

class RuntimeRoleVerificationError extends Error {
  constructor(stage, cause) {
    super('Production runtime database-role verification failed');
    this.name = 'RuntimeRoleVerificationError';
    this.stage = stage;
    this.cause = cause;
  }
}

async function run() {
  let stage = 'configuration';
  let client;
  let transactionOpen = false;

  try {
    const connectionString = loadRuntimeDatabaseUrl(process.cwd());
    client = new Client(buildRuntimeClientConfig(connectionString));

    stage = 'connection';
    await client.connect();

    stage = 'transaction';
    await client.query('BEGIN TRANSACTION READ ONLY');
    transactionOpen = true;

    stage = 'metadata-query';
    const result = await client.query(RUNTIME_ROLE_QUERY);
    if (result.rowCount !== 1) {
      throw new Error('Runtime database role metadata is incomplete');
    }

    stage = 'assessment';
    const assessment = assessRuntimeRole(result.rows[0]);

    stage = 'transaction';
    await client.query('COMMIT');
    transactionOpen = false;

    logAssessment(assessment);

    stage = 'assertion';
    assertRuntimeRoleReady(assessment);
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw new RuntimeRoleVerificationError(stage, error);
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    const diagnostic =
      error instanceof RuntimeRoleVerificationError
        ? createSafeFailureDiagnostic(error.cause, error.stage)
        : createSafeFailureDiagnostic(error);
    console.error('Production runtime database-role verification failed');
    console.error(`runtimeRoleVerificationStage: ${diagnostic.stage}`);
    console.error(
      `runtimeRoleVerificationFailureClass: ${diagnostic.failureClass}`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  RUNTIME_ROLE_QUERY,
  assessRuntimeRole,
  assertRuntimeRoleReady,
  buildRuntimeClientConfig,
  createSafeFailureDiagnostic,
  loadRuntimeDatabaseUrl,
};
