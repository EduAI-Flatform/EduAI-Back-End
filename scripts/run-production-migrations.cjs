const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const {
  grantRuntimeMembershipPrivileges,
} = require('./membership-runtime-privileges.cjs');

const MIGRATION_ENV_FILE = '.env.migration';
const EXPECTED_RECONCILIATION_MIGRATION =
  '20260916123000_harden_reconciliation_source_identity';
const EXPECTED_RECONCILIATION_MIGRATION_SHA256 =
  '03803E8EEF652CE73BEC38267E274650F45665ECBEF578749E1DAABA663CF53F';
const RECONCILIATION_FINANCIAL_KINDS = [
  'duplicate_collection',
  'late_payment',
  'provider_outage',
  'provider_fact_mismatch',
  'unknown_provider_status',
  'paid_not_fulfilled',
];
const RECONCILIATION_FINANCIAL_KIND_SQL = RECONCILIATION_FINANCIAL_KINDS
  .map((kind) => `'${kind}'`)
  .join(', ');
const RECONCILIATION_REQUIRED_TABLES = [
  'commerce_reconciliation_cases',
  'commerce_orders',
  'commerce_payment_attempts',
  'commerce_payment_events',
  'commerce_settlements',
  'commerce_fulfillment_effects',
  'commerce_refunds',
  'commerce_lifecycle_events',
  'audit_logs',
];
const RECONCILIATION_REQUIRED_FUNCTIONS = [
  'commerce_guard_initial_state',
  'commerce_guard_reconciliation_update',
  'commerce_require_status_lifecycle',
  'commerce_validate_reconciliation',
  'commerce_validate_reconciliation_resolution',
];
const RECONCILIATION_REQUIRED_TRIGGERS = [
  'commerce_reconciliation_cases_guard_initial_state',
  'commerce_reconciliation_cases_guard_update',
  'commerce_reconciliation_cases_no_delete',
  'commerce_reconciliation_cases_require_lifecycle',
  'commerce_reconciliation_cases_validate_resolution',
  'commerce_reconciliation_cases_validate_source',
];
const RECONCILIATION_FINANCIAL_ROW_COUNTS = Object.freeze({
  commerce_orders: 7,
  commerce_payment_attempts: 5,
  commerce_payment_events: 3,
  commerce_settlements: 3,
  commerce_fulfillment_effects: 3,
  commerce_refunds: 0,
  commerce_lifecycle_events: 24,
  audit_logs: 11805,
});

function databaseIdentity(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') ||
      !parsed.username
    ) {
      throw new Error();
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!database) throw new Error();

    return {
      username: decodeURIComponent(parsed.username),
      database,
    };
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL with an explicit role`);
  }
}

function verifyDatabaseRoleSeparation(runtimeUrl, migrationUrl) {
  const runtime = databaseIdentity(runtimeUrl, 'DATABASE_URL');
  const migration = databaseIdentity(
    migrationUrl,
    'MIGRATION_DATABASE_URL',
  );

  if (runtime.username === migration.username) {
    throw new Error(
      'DATABASE_URL and MIGRATION_DATABASE_URL must use distinct PostgreSQL roles',
    );
  }

  if (runtime.database !== migration.database) {
    throw new Error(
      'DATABASE_URL and MIGRATION_DATABASE_URL must target the same database',
    );
  }

  return {
    runtimeDatabaseConfigured: true,
    migrationDatabaseConfigured: true,
    databaseRolesSeparated: true,
  };
}

function loadMigrationDatabaseUrl(rootDirectory) {
  const migrationEnvPath = join(rootDirectory, MIGRATION_ENV_FILE);
  let stats;
  try {
    stats = statSync(migrationEnvPath);
  } catch {
    throw new Error('.env.migration is required');
  }

  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      '.env.migration must not be readable by group or other users',
    );
  }

  const parsed = dotenv.parse(readFileSync(migrationEnvPath));
  return parsed.MIGRATION_DATABASE_URL;
}

function classifyMigrationFailure(log) {
  const value = typeof log === 'string' ? log : '';
  if (/\.env\.migration is required|MIGRATION_DATABASE_URL is required|must be a PostgreSQL URL|must not be readable by group or other users|database .* does not exist|role .* does not exist/i.test(value)) {
    return 'MIGRATION_CONFIGURATION_INVALID';
  }
  if (/must use distinct PostgreSQL roles|must target the same database/i.test(value)) {
    return 'MIGRATION_ROLE_SEPARATION_INVALID';
  }
  if (/Failed migration metadata inspection/i.test(value)) {
    return 'MIGRATION_METADATA_INSPECTION_FAILED';
  }
  if (/password authentication failed|authentication failed|no pg_hba\.conf|connection refused|could not connect|can't reach database server|cannot reach database server|connection terminated unexpectedly|connect(?:ion)? timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(value)) {
    return 'MIGRATION_DATABASE_CONNECTION_FAILED';
  }
  if (/Runtime membership privilege grant failed/i.test(value)) {
    return 'RUNTIME_PRIVILEGE_GRANT_FAILED';
  }
  if (/failed migration requires reviewed recovery/i.test(value)) {
    return 'MIGRATION_REQUIRES_REVIEWED_RECOVERY';
  }
  if (/unsafe use of new value|must be committed before they can be used/i.test(value)) {
    return 'POSTGRES_ENUM_VALUE_NOT_COMMITTED';
  }
  if (/constraint .* does not exist/i.test(value)) {
    return 'EXPECTED_CONSTRAINT_MISSING';
  }
  if (/already exists/i.test(value)) return 'SCHEMA_OBJECT_ALREADY_EXISTS';
  if (/syntax error/i.test(value)) return 'MIGRATION_SQL_SYNTAX_INVALID';
  if (/permission denied|must be owner/i.test(value)) {
    return 'MIGRATION_ROLE_PERMISSION_DENIED';
  }
  if (/deadlock detected|could not serialize access/i.test(value)) {
    return 'MIGRATION_TRANSACTION_CONFLICT';
  }
  return 'UNKNOWN_SCHEMA_MIGRATION_FAILURE';
}

function extractSafeMigrationErrorCodes(log) {
  const value = typeof log === 'string' ? log : '';
  const prismaCode = value.match(/\bError:\s*(P\d{4})\b/i)?.[1]?.toUpperCase();
  const sqlState = (
    value.match(/\bDatabase error code:\s*([0-9A-Z]{5})\b/i)?.[1] ??
    value.match(/\bSQLSTATE\s*[:=]?\s*([0-9A-Z]{5})\b/i)?.[1]
  )?.toUpperCase();

  return {
    ...(prismaCode ? { prismaCode } : {}),
    ...(sqlState ? { sqlState } : {}),
  };
}

function emitMigrationFailure(failureClass, migrationName) {
  const migrationSuffix = migrationName ? `;migration=${migrationName}` : '';
  console.log(`migrationFailureClass: ${failureClass}`);
  console.error(
    `::error title=Production migration blocked::migrationFailureClass=${failureClass}${migrationSuffix}`,
  );
}

function safeMigrationName(value) {
  return typeof value === 'string' && /^\d{14}_[A-Za-z0-9_-]+$/.test(value)
    ? value
    : 'UNAVAILABLE';
}

function migrationPreflightFailure(failureClass = 'MIGRATION_PREFLIGHT_STATE_DRIFT') {
  const error = new Error('Production migration preflight failed');
  error.failureClass = failureClass;
  return error;
}

function numericCount(value, name) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    throw migrationPreflightFailure('MIGRATION_PREFLIGHT_INVALID_' + name);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw migrationPreflightFailure('MIGRATION_PREFLIGHT_INVALID_' + name);
  }
  return parsed;
}

function requiredBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw migrationPreflightFailure('MIGRATION_PREFLIGHT_INVALID_' + name);
  }
  return value;
}

function localMigrationNames(rootDirectory) {
  try {
    const migrationDirectories = readdirSync(join(rootDirectory, 'prisma', 'migrations'), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name));
    if (
      migrationDirectories.some(
        (entry) => !/^\d{14}_[A-Za-z0-9_-]+$/.test(entry.name),
      )
    ) {
      throw migrationPreflightFailure('MIGRATION_LOCAL_ARTIFACTS_UNAVAILABLE');
    }
    return migrationDirectories.map((entry) => entry.name).sort();
  } catch {
    throw migrationPreflightFailure('MIGRATION_LOCAL_ARTIFACTS_UNAVAILABLE');
  }
}

function assertReviewedMigrationFingerprint(rootDirectory) {
  let actualHash;
  try {
    actualHash = createHash('sha256')
      .update(
        readFileSync(
          join(
            rootDirectory,
            'prisma',
            'migrations',
            EXPECTED_RECONCILIATION_MIGRATION,
            'migration.sql',
          ),
        ),
      )
      .digest('hex')
      .toUpperCase();
  } catch {
    throw migrationPreflightFailure('MIGRATION_ARTIFACT_UNAVAILABLE');
  }

  if (actualHash !== EXPECTED_RECONCILIATION_MIGRATION_SHA256) {
    throw migrationPreflightFailure('MIGRATION_ARTIFACT_HASH_MISMATCH');
  }

  return actualHash;
}

function localMigrationChecksums(rootDirectory, migrationNames) {
  const names = Array.isArray(migrationNames)
    ? migrationNames
    : localMigrationNames(rootDirectory);
  const checksums = {};
  try {
    for (const name of names) {
      checksums[name] = createHash('sha256')
        .update(
          readFileSync(
            join(rootDirectory, 'prisma', 'migrations', name, 'migration.sql'),
          ),
        )
        .digest('hex')
        .toUpperCase();
    }
  } catch {
    throw migrationPreflightFailure('MIGRATION_LOCAL_ARTIFACTS_UNAVAILABLE');
  }
  return checksums;
}

function assertMigrationLedgerState({
  expectedMigrationName = EXPECTED_RECONCILIATION_MIGRATION,
  localMigrationNames: localNames,
  localMigrationChecksums: localChecksums,
  migrationRows,
}) {
  if (
    !Array.isArray(localNames) ||
    !Array.isArray(migrationRows) ||
    localNames.length === 0 ||
    new Set(localNames).size !== localNames.length
  ) {
    throw migrationPreflightFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }

  const applied = new Set();
  for (const row of migrationRows) {
    const rolledBack = row?.rolled_back_at !== null;
    if (
      !row ||
      typeof row.migration_name !== 'string' ||
      typeof row.checksum !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(row.checksum) ||
      row.rolled_back_at === undefined ||
      (rolledBack
        ? row.finished_at !== null
        : row.finished_at === null || row.finished_at === undefined)
    ) {
      throw migrationPreflightFailure('MIGRATION_LEDGER_STATE_DRIFT');
    }
    if (
      localChecksums &&
      (typeof localChecksums[row.migration_name] !== 'string' ||
        row.checksum.toUpperCase() !==
          localChecksums[row.migration_name].toUpperCase())
    ) {
      throw migrationPreflightFailure('MIGRATION_LEDGER_CHECKSUM_MISMATCH');
    }
    if (rolledBack) continue;
    if (applied.has(row.migration_name)) {
      throw migrationPreflightFailure('MIGRATION_LEDGER_STATE_DRIFT');
    }
    applied.add(row.migration_name);
  }

  if (
    [...applied].some((name) => !localNames.includes(name)) ||
    applied.has(expectedMigrationName) ||
    !localNames.includes(expectedMigrationName)
  ) {
    throw migrationPreflightFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }

  const pendingMigrationNames = localNames.filter((name) => !applied.has(name));
  if (
    pendingMigrationNames.length !== 1 ||
    pendingMigrationNames[0] !== expectedMigrationName
  ) {
    throw migrationPreflightFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }

  return {
    currentSchemaVersion:
      migrationRows.filter((row) => applied.has(row.migration_name)).at(-1)
        ?.migration_name ?? null,
    pendingMigrationNames,
    targetApplied: false,
  };
}

const RECONCILIATION_SCHEMA_QUERY = `
WITH required_tables(name) AS (
  VALUES ${RECONCILIATION_REQUIRED_TABLES.map((name) => "('" + name + "')").join(', ')}
), required_functions(name) AS (
  VALUES ${RECONCILIATION_REQUIRED_FUNCTIONS.map((name) => "('" + name + "')").join(', ')}
), required_triggers(name) AS (
  VALUES ${RECONCILIATION_REQUIRED_TRIGGERS.map((name) => "('" + name + "')").join(', ')}
), required_trigger_bindings(trigger_name, function_name) AS (
  VALUES
    ('commerce_reconciliation_cases_guard_initial_state', 'commerce_guard_initial_state'),
    ('commerce_reconciliation_cases_guard_update', 'commerce_guard_reconciliation_update'),
    ('commerce_reconciliation_cases_no_delete', 'commerce_reject_financial_delete'),
    ('commerce_reconciliation_cases_require_lifecycle', 'commerce_require_status_lifecycle'),
    ('commerce_reconciliation_cases_validate_resolution', 'commerce_validate_reconciliation_resolution'),
    ('commerce_reconciliation_cases_validate_source', 'commerce_validate_reconciliation')
)
SELECT
  (
    SELECT COALESCE(BOOL_AND(to_regclass('public.' || name) IS NOT NULL), false)
    FROM required_tables
  ) AS "requiredTablesPresent",
  (
    SELECT COUNT(*) = (SELECT COUNT(*) FROM required_functions)
    FROM pg_proc AS proc
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
      AND proc.proname IN (SELECT name FROM required_functions)
  ) AS "requiredFunctionsPresent",
  (
    SELECT COUNT(*) = (SELECT COUNT(*) FROM required_triggers)
    FROM pg_trigger AS trig
    INNER JOIN pg_class AS relation
      ON relation.oid = trig.tgrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'commerce_reconciliation_cases'
      AND trig.tgname IN (SELECT name FROM required_triggers)
      AND trig.tgenabled = 'O'
  ) AS "requiredTriggersPresent",
  (
    SELECT COUNT(*) = (SELECT COUNT(*) FROM required_trigger_bindings)
    FROM pg_trigger AS trig
    INNER JOIN pg_class AS relation
      ON relation.oid = trig.tgrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_proc AS proc
      ON proc.oid = trig.tgfoid
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'commerce_reconciliation_cases'
      AND trig.tgenabled = 'O'
      AND EXISTS (
        SELECT 1
        FROM required_trigger_bindings AS binding
        WHERE binding.trigger_name = trig.tgname
          AND binding.function_name = proc.proname
      )
  ) AS "requiredTriggerBindingsPresent",
  to_regclass('public.commerce_reconciliation_legacy_acknowledgements')
    IS NOT NULL AS "markerTablePresent",
  COALESCE((
    SELECT NOT attribute.attnotnull
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = to_regclass('public.commerce_reconciliation_cases')
      AND attribute.attname = 'source_key'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), false) AS "sourceKeyNullable",
  COALESCE((
    SELECT attribute.attnotnull
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = to_regclass('public.commerce_reconciliation_cases')
      AND attribute.attname = 'source_key'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), false) AS "sourceKeyNotNull",
  EXISTS (
    SELECT 1
    FROM pg_trigger AS trig
    INNER JOIN pg_class AS relation
      ON relation.oid = trig.tgrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'commerce_reconciliation_legacy_acknowledgements'
      AND trig.tgname = 'commerce_reconciliation_legacy_acknowledgements_immutable'
      AND trig.tgenabled = 'O'
  ) AS "markerTriggerPresent",
  EXISTS (
    SELECT 1
    FROM pg_trigger AS trig
    INNER JOIN pg_class AS relation
      ON relation.oid = trig.tgrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_proc AS proc
      ON proc.oid = trig.tgfoid
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'commerce_reconciliation_legacy_acknowledgements'
      AND trig.tgname = 'commerce_reconciliation_legacy_acknowledgements_immutable'
      AND proc.proname = 'commerce_guard_reconciliation_legacy_acknowledgement'
      AND trig.tgenabled = 'O'
  ) AS "markerTriggerBindingPresent",
  EXISTS (
    SELECT 1
    FROM pg_proc AS proc
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
      AND proc.proname = 'commerce_guard_reconciliation_legacy_acknowledgement'
  ) AS "markerGuardFunctionPresent",
  COALESCE((
    SELECT BOOL_AND(
      pg_get_functiondef(proc.oid) ILIKE
        '%financial reconciliation case cannot be acknowledged without canonical resolution%'
      AND pg_get_functiondef(proc.oid) ILIKE
        '%commerce_reconciliation_legacy_acknowledgements%'
    )
    FROM pg_proc AS proc
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
      AND proc.proname = 'commerce_validate_reconciliation_resolution'
  ), false) AS "hardenedResolutionGuard",
  COALESCE((
    SELECT BOOL_AND(
      pg_get_functiondef(proc.oid) ILIKE
        '%reconciliation source key backfill is not deterministic%'
    )
    FROM pg_proc AS proc
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
      AND proc.proname = 'commerce_guard_reconciliation_update'
  ), false) AS "hardenedSourceKeyGuard"
  ,COALESCE((
    SELECT format_type(attribute.atttypid, attribute.atttypmod) =
      'character varying(160)'
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = to_regclass('public.commerce_reconciliation_cases')
      AND attribute.attname = 'source_key'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), false) AS "sourceKeyTypeCompatible"
  ,EXISTS (
    SELECT 1
    FROM pg_index AS index_metadata
    INNER JOIN pg_class AS index_relation
      ON index_relation.oid = index_metadata.indexrelid
    INNER JOIN pg_attribute AS attribute
      ON attribute.attrelid = index_metadata.indrelid
     AND attribute.attnum = ANY(index_metadata.indkey)
    WHERE index_metadata.indrelid =
      'public.commerce_reconciliation_cases'::regclass
      AND index_relation.relname =
        'commerce_reconciliation_cases_source_key_key'
      AND index_metadata.indisunique
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND attribute.attname = 'source_key'
  ) AS "sourceKeyUniqueIndexPresent"
  ,EXISTS (
    SELECT 1
    FROM pg_trigger AS trig
    INNER JOIN pg_class AS relation
      ON relation.oid = trig.tgrelid
    WHERE relation.oid = to_regclass(
      'public.commerce_reconciliation_legacy_acknowledgements'
    )
      AND trig.tgname =
        'commerce_reconciliation_legacy_acknowledgements_immutable'
      AND trig.tgenabled = 'O'
      AND pg_get_triggerdef(trig.oid) ILIKE '%BEFORE%'
      AND pg_get_triggerdef(trig.oid) ILIKE '%UPDATE%'
      AND pg_get_triggerdef(trig.oid) ILIKE '%DELETE%'
      AND pg_get_triggerdef(trig.oid) ILIKE '%FOR EACH ROW%'
  ) AS "markerTriggerShapeCompatible"
  ,EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_metadata
    WHERE constraint_metadata.conrelid = to_regclass(
      'public.commerce_reconciliation_legacy_acknowledgements'
    )
      AND constraint_metadata.confrelid = to_regclass(
        'public.commerce_reconciliation_cases'
      )
      AND constraint_metadata.contype = 'f'
      AND constraint_metadata.conname =
        'commerce_reconciliation_legacy_acknowledgements_case_fkey'
  ) AS "markerForeignKeyPresent"
`;

const RECONCILIATION_CASE_STATE_QUERY = [
  `
WITH candidate_source_keys AS (
  SELECT
    review."id",
    concat_ws(
      ':',
      review."payment_attempt_id"::text,
      review."kind"::text,
      CASE
        WHEN review."kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
          THEN review."settlement_id"::text
      END
    ) AS derived_source_key
  FROM "commerce_reconciliation_cases" AS review
  WHERE review."source_key" IS NULL
), duplicate_groups AS (
  SELECT derived_source_key, COUNT(*) AS row_count
  FROM candidate_source_keys
  GROUP BY derived_source_key
  HAVING COUNT(*) > 1
), historical_cases AS (
  SELECT
    review."id",
    review."order_id",
    review."settlement_id",
    review."payment_attempt_id",
    review."status",
    review."resolution",
    review."kind",
    review."reason_code",
    review."source_key",
    review."status_operation_id",
    review."resolved_by_id",
    review."resolved_at",
    order_record."status" AS order_status,
    order_record."fulfillment_status" AS fulfillment_status,
    attempt."status" AS attempt_status,
    attempt."order_id" AS attempt_order_id,
    attempt."paid_at",
    attempt."closed_at"
  FROM "commerce_reconciliation_cases" AS review
  LEFT JOIN "commerce_orders" AS order_record
    ON order_record."id" = review."order_id"
  LEFT JOIN "commerce_payment_attempts" AS attempt
    ON attempt."id" = review."payment_attempt_id"
  WHERE review."kind" = 'unknown_provider_status'
    AND review."reason_code" = 'PROVIDER_STATUS_MALFORMED'
), historical_aggregate AS (
  `,
  `
  SELECT
    COUNT(*)::text AS "historicalCaseCount",
    COUNT(*) FILTER (
      WHERE historical."status" = 'resolved'
        AND historical."resolution" = 'acknowledged'
    )::text AS "historicalAmbiguityMatchCount",
    COUNT(*) FILTER (
      WHERE historical."source_key" IS NOT NULL
    )::text AS "historicalSourceKeyPresentCount",
    COUNT(*) FILTER (
      WHERE historical."source_key" IS NOT DISTINCT FROM concat_ws(
        ':',
        historical."payment_attempt_id"::text,
        historical."kind"::text,
        CASE
          WHEN historical."kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
            THEN historical."settlement_id"::text
        END
      )
    )::text AS "historicalCanonicalSourceKeyMatchCount",
    COUNT(*) FILTER (
      WHERE historical."resolved_at" IS NOT NULL
        AND historical."resolved_by_id" IS NOT NULL
        AND historical."status_operation_id" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM "commerce_lifecycle_events" AS lifecycle
          WHERE lifecycle."entity_type" = 'reconciliation'::"commerce_lifecycle_entity_type"
            AND lifecycle."entity_id" = historical."id"
            AND lifecycle."operation_id" = historical."status_operation_id"
            AND lifecycle."previous_status" = 'open'
            AND lifecycle."next_status" = 'resolved'
            AND lifecycle."actor_kind" = 'user'::"commerce_actor_kind"
            AND lifecycle."actor_id" = historical."resolved_by_id"
            AND lifecycle."reason_code" = 'OPERATOR_ACKNOWLEDGED'
        )
    )::text AS "historicalProvenanceMatchCount",
    COUNT(*) FILTER (
      WHERE historical."order_status" = 'pending_payment'
        AND historical."fulfillment_status" = 'not_started'
        AND historical."attempt_status" = 'pending'
        AND historical."attempt_order_id" = historical."order_id"
        AND historical."paid_at" IS NULL
        AND historical."closed_at" IS NULL
        AND historical."settlement_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "commerce_settlements" AS settlement
          WHERE settlement."payment_attempt_id" = historical."payment_attempt_id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "commerce_payment_events" AS payment_event
          WHERE payment_event."payment_attempt_id" = historical."payment_attempt_id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "commerce_fulfillment_effects" AS effect
          WHERE effect."order_id" = historical."order_id"
        )
    )::text AS "historicalFinancialFactMatchCount",
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM "commerce_settlements" AS settlement
        WHERE settlement."payment_attempt_id" = historical."payment_attempt_id"
      )
    )::text AS "historicalSettlementFactAbsentMatchCount",
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM "commerce_payment_events" AS payment_event
        WHERE payment_event."payment_attempt_id" = historical."payment_attempt_id"
      )
    )::text AS "historicalWebhookFactAbsentMatchCount",
    COUNT(*) FILTER (
      WHERE historical."order_status" = 'pending_payment'
        AND historical."fulfillment_status" = 'not_started'
        AND NOT EXISTS (
          SELECT 1
          FROM "commerce_fulfillment_effects" AS effect
          WHERE effect."order_id" = historical."order_id"
        )
    )::text AS "historicalFulfillmentAbsentMatchCount",
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM "audit_logs" AS audit
        WHERE audit."target_type" = 'commerce_reconciliation_case'
          AND audit."target_id" = historical."id"::text
          AND audit."action" = 'PAYMENT_RECONCILIATION_RESOLVED'
          AND audit."metadata_json"->>'resolution' = 'ACKNOWLEDGED'
      )
    )::text AS "historicalAuditTransitionMatchCount"
  FROM historical_cases AS historical
), reconciliation_aggregate AS (
`,
  `
  SELECT
    COUNT(*)::text AS "totalCaseCount",
    COUNT(*) FILTER (WHERE review."status" = 'open')::text AS "openCaseCount",
    COUNT(*) FILTER (
      WHERE review."status" = 'open'
        AND review."kind" = 'provider_outage'
    )::text AS "openProviderOutageCount",
    COUNT(*) FILTER (
      WHERE review."status" = 'open'
        AND review."kind" = 'provider_fact_mismatch'
    )::text AS "openProviderFactMismatchCount",
    COUNT(*) FILTER (
      WHERE review."status" = 'open'
        AND review."kind" = 'paid_not_fulfilled'
    )::text AS "openPaidNotFulfilledCount",
    COUNT(*) FILTER (
      WHERE review."source_key" IS NULL
    )::text AS "nullSourceKeyCount",
    COUNT(*) FILTER (
      WHERE review."source_key" IS NOT NULL
        AND review."source_key" IS DISTINCT FROM concat_ws(
          ':',
          review."payment_attempt_id"::text,
          review."kind"::text,
          CASE
            WHEN review."kind" IN ('duplicate_collection', 'late_payment', 'paid_not_fulfilled')
              THEN review."settlement_id"::text
          END
        )
    )::text AS "nonCanonicalExistingSourceKeyCount",
    COUNT(*) FILTER (
      WHERE review."source_key" IS NOT NULL
    )::text AS "sourceKeyNonNullCount",
    COUNT(*) FILTER (
      WHERE review."source_key" IS NOT NULL
        AND length(review."source_key") > 160
    )::text AS "oversizedSourceKeyCount",
    COUNT(*) FILTER (
      WHERE review."status" = 'resolved'
        AND review."resolution" = 'acknowledged'
        AND review."kind" IN (
          'duplicate_collection',
          'late_payment',
          'provider_outage',
          'provider_fact_mismatch',
          'unknown_provider_status',
          'paid_not_fulfilled'
        )
    )::text AS "acknowledgedFinancialCaseCount",
    COUNT(*) FILTER (
      WHERE review."status" = 'resolved'
        AND review."resolution" = 'acknowledged'
        AND review."kind" IN (
          'duplicate_collection',
          'late_payment',
          'provider_outage',
          'provider_fact_mismatch',
          'unknown_provider_status',
          'paid_not_fulfilled'
        )
        AND (
          review."resolved_at" IS NULL
          OR review."resolved_by_id" IS NULL
          OR review."status_operation_id" IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM "commerce_lifecycle_events" AS lifecycle
            WHERE lifecycle."entity_type" = 'reconciliation'::"commerce_lifecycle_entity_type"
              AND lifecycle."entity_id" = review."id"
              AND lifecycle."operation_id" = review."status_operation_id"
              AND lifecycle."previous_status" = 'open'
              AND lifecycle."next_status" = 'resolved'
              AND lifecycle."actor_kind" = 'user'::"commerce_actor_kind"
              AND lifecycle."actor_id" = review."resolved_by_id"
              AND lifecycle."reason_code" = 'OPERATOR_ACKNOWLEDGED'
          )
        )
    )::text AS "unprovenLegacyCaseCount"
  FROM "commerce_reconciliation_cases" AS review
), state_checks AS (
  `,
  `
  SELECT
    (SELECT COUNT(*)::text FROM candidate_source_keys) AS "candidateSourceKeyCount",
    (SELECT COUNT(*)::text
     FROM "commerce_reconciliation_cases"
     WHERE "source_key" IS NULL AND "payment_attempt_id" IS NULL
    ) AS "missingAttemptCount",
    (SELECT COUNT(*)::text
     FROM "commerce_reconciliation_cases"
     WHERE "source_key" IS NULL
       AND "kind" IN ('duplicate_collection', 'late_payment')
       AND "settlement_id" IS NULL
    ) AS "missingSettlementCount",
    (SELECT COUNT(*)::text FROM duplicate_groups) AS "duplicateGroupCount",
    (SELECT COALESCE(SUM(row_count - 1), 0)::text FROM duplicate_groups)
      AS "duplicateExtraRowCount",
    (SELECT COUNT(*)::text
     FROM candidate_source_keys AS candidate
     INNER JOIN "commerce_reconciliation_cases" AS existing
       ON existing."source_key" = candidate.derived_source_key
      AND existing."id" <> candidate."id"
    ) AS "existingCollisionCount",
    (SELECT COUNT(*)::text
     FROM candidate_source_keys
     WHERE length(derived_source_key) > 160
    ) AS "oversizedDerivedKeyCount",
    (SELECT COUNT(*)::text
     FROM candidate_source_keys
     WHERE derived_source_key IS NULL OR derived_source_key = ''
    ) AS "invalidDerivedKeyCount"
  FROM (SELECT 1) AS one
)
SELECT
  reconciliation_aggregate.*,
  state_checks.*,
  historical_aggregate.*
FROM reconciliation_aggregate
CROSS JOIN state_checks
CROSS JOIN historical_aggregate
`,
].join('\n');

const RECONCILIATION_FINANCIAL_DIGEST_QUERY = `
WITH table_digests AS (
  SELECT
    'commerce_orders' AS "tableName",
    COUNT(*)::text AS "rowCount",
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    ) AS digest
  FROM "commerce_orders" AS row_data
  UNION ALL
  SELECT
    'commerce_payment_attempts',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_payment_attempts" AS row_data
  UNION ALL
  SELECT
    'commerce_payment_events',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_payment_events" AS row_data
  UNION ALL
  SELECT
    'commerce_settlements',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_settlements" AS row_data
  UNION ALL
  SELECT
    'commerce_fulfillment_effects',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_fulfillment_effects" AS row_data
  UNION ALL
  SELECT
    'commerce_refunds',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_refunds" AS row_data
  UNION ALL
  SELECT
    'commerce_lifecycle_events',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "commerce_lifecycle_events" AS row_data
  UNION ALL
  SELECT
    'audit_logs',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(to_jsonb(row_data)::text, E'\\n' ORDER BY row_data."id"::text)),
      md5('')
    )
  FROM "audit_logs" AS row_data
  UNION ALL
  SELECT
    'reconciliation_immutable',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(
        jsonb_build_object(
          'id', row_data."id",
          'orderId', row_data."order_id",
          'settlementId', row_data."settlement_id",
          'paymentAttemptId', row_data."payment_attempt_id",
          'kind', row_data."kind",
          'reasonCode', row_data."reason_code",
          'status', row_data."status",
          'statusOperationId', row_data."status_operation_id",
          'resolution', row_data."resolution",
          'resolvedById', row_data."resolved_by_id",
          'openedAt', row_data."opened_at",
          'updatedAt', row_data."updated_at",
          'resolvedAt', row_data."resolved_at",
          'lastCheckedAt', row_data."last_checked_at",
          'checkCount', row_data."check_count"
        )::text,
        E'\\n' ORDER BY row_data."id"::text
      )), md5('')
    )
  FROM "commerce_reconciliation_cases" AS row_data
  UNION ALL
  SELECT
    'reconciliation_non_null_source_keys',
    COUNT(*)::text,
    COALESCE(
      md5(string_agg(
        jsonb_build_object(
          'id', row_data."id",
          'sourceKey', row_data."source_key"
        )::text,
        E'\\n' ORDER BY row_data."id"::text
      )), md5('')
    )
  FROM "commerce_reconciliation_cases" AS row_data
  WHERE row_data."source_key" IS NOT NULL
)
SELECT jsonb_object_agg(
  "tableName",
  jsonb_build_object('rowCount', "rowCount", 'digest', digest)
) AS "digests"
FROM table_digests;
`;

const RECONCILIATION_MARKER_QUERY = `
WITH acknowledged_financial_cases AS (
  SELECT review."id"
  FROM "commerce_reconciliation_cases" AS review
  WHERE review."status" = 'resolved'
    AND review."resolution" = 'acknowledged'
    AND review."kind" IN (${RECONCILIATION_FINANCIAL_KIND_SQL})
), marker_assessment AS (
  SELECT
    marker."reconciliation_case_id",
    marker."historical_status",
    marker."historical_resolution",
    marker."historical_reason_code",
    marker."preservation_reason",
    marker."migration_version",
    review."id" AS review_id,
    review."status"::text AS review_status,
    review."resolution"::text AS review_resolution,
    review."reason_code" AS review_reason_code,
    review."kind"::text AS review_kind
  FROM "commerce_reconciliation_legacy_acknowledgements" AS marker
  LEFT JOIN "commerce_reconciliation_cases" AS review
    ON review."id" = marker."reconciliation_case_id"
)
SELECT
  (SELECT COUNT(*)::text FROM "commerce_reconciliation_legacy_acknowledgements")
    AS "markerCount",
  (SELECT COUNT(*)::text FROM acknowledged_financial_cases)
    AS "acknowledgedFinancialCaseCount",
  (SELECT COUNT(*)::text
   FROM acknowledged_financial_cases AS review
   INNER JOIN "commerce_reconciliation_legacy_acknowledgements" AS marker
     ON marker."reconciliation_case_id" = review."id"
  ) AS "matchedMarkerCount",
  (SELECT COUNT(*)::text
   FROM acknowledged_financial_cases AS review
   WHERE NOT EXISTS (
     SELECT 1
     FROM "commerce_reconciliation_legacy_acknowledgements" AS marker
     WHERE marker."reconciliation_case_id" = review."id"
   )
  ) AS "unmarkedLegacyCaseCount",
  (SELECT COUNT(*)::text
   FROM marker_assessment AS assessment
   WHERE assessment.review_id IS NULL
      OR assessment.review_status IS DISTINCT FROM 'resolved'
      OR assessment.review_resolution IS DISTINCT FROM 'acknowledged'
      OR assessment.review_reason_code IS DISTINCT FROM assessment.historical_reason_code
      OR assessment.historical_status IS DISTINCT FROM 'resolved'
      OR assessment.historical_resolution IS DISTINCT FROM 'acknowledged'
      OR assessment.preservation_reason IS DISTINCT FROM
        'PRE_HARDENING_ACKNOWLEDGEMENT_NO_CANONICAL_RESOLUTION'
      OR assessment.migration_version IS DISTINCT FROM
        '20260916123000_harden_reconciliation_source_identity'
      OR assessment.review_kind NOT IN (${RECONCILIATION_FINANCIAL_KIND_SQL})
  ) AS "mismatchedLegacyMarkerCount",
  (SELECT COUNT(*)::text
   FROM marker_assessment AS assessment
   WHERE assessment.review_id IS NULL
  ) AS "orphanMarkerCount",
  (SELECT COUNT(*)::text
   FROM marker_assessment AS assessment
   WHERE assessment.review_id IS NOT NULL
     AND (
       assessment.review_status IS DISTINCT FROM 'resolved'
       OR assessment.review_resolution IS DISTINCT FROM 'acknowledged'
       OR assessment.review_kind NOT IN (${RECONCILIATION_FINANCIAL_KIND_SQL})
     )
  ) AS "unexpectedMarkerCount";
`;

const MIGRATION_LEDGER_QUERY = `
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY finished_at ASC NULLS LAST, started_at ASC;
`;

const SERVER_IDENTITY_QUERY = `
SELECT current_user AS "currentUser", current_database() AS "currentDatabase";
`;

const MIGRATION_PRIVILEGE_QUERY = `
WITH required_tables(name) AS (
  VALUES ${RECONCILIATION_REQUIRED_TABLES.map((name) => "('" + name + "')").join(', ')}
), table_capabilities AS (
  SELECT
    COUNT(*) = (SELECT COUNT(*) FROM required_tables) AS "requiredTablesPresent",
    COALESCE(BOOL_AND(
      pg_has_role(current_user, relation.relowner, 'USAGE')
    ), false) AS "canAlterRequiredTables",
    COALESCE(BOOL_AND(
      has_table_privilege(current_user, 'public.' || required_tables.name, 'SELECT')
    ), false) AS "canReadRequiredTables"
  FROM required_tables
  LEFT JOIN pg_class AS relation
    ON relation.oid = to_regclass('public.' || required_tables.name)
), required_functions(name) AS (
  VALUES ${RECONCILIATION_REQUIRED_FUNCTIONS.map((name) => "('" + name + "')").join(', ')}
), function_capabilities AS (
  SELECT
    COUNT(DISTINCT proc.proname) = (SELECT COUNT(*) FROM required_functions)
      AS "requiredFunctionsPresent",
    COALESCE(BOOL_AND(
      pg_has_role(current_user, proc.proowner, 'USAGE')
    ), false) AS "canAlterRequiredFunctions"
  FROM required_functions
  LEFT JOIN pg_proc AS proc
    ON proc.pronamespace = 'public'::regnamespace
   AND proc.proname = required_functions.name
)
SELECT
  has_schema_privilege(current_user, 'public', 'USAGE') AS "canUsePublicSchema",
  has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInPublicSchema",
  has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') AS "canReadMigrationLedger",
  has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') AS "canInsertMigrationLedger",
  has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') AS "canUpdateMigrationLedger",
  table_capabilities."requiredTablesPresent",
  table_capabilities."canAlterRequiredTables",
  table_capabilities."canReadRequiredTables",
  function_capabilities."requiredFunctionsPresent",
  function_capabilities."canAlterRequiredFunctions"
FROM table_capabilities
CROSS JOIN function_capabilities;
`;

const RUNTIME_FINANCIAL_GUARD_QUERY = `
SELECT
  to_regclass('public.commerce_reconciliation_legacy_acknowledgements')
    IS NOT NULL AS "markerTablePresent",
  COALESCE(has_table_privilege(
    current_user,
    'public.commerce_reconciliation_legacy_acknowledgements',
    'INSERT'
  ), false) AS "canInsertLegacyMarker",
  COALESCE(has_table_privilege(
    current_user,
    'public.commerce_reconciliation_legacy_acknowledgements',
    'UPDATE'
  ), false) AS "canUpdateLegacyMarker",
  COALESCE(has_table_privilege(
    current_user,
    'public.commerce_reconciliation_legacy_acknowledgements',
    'DELETE'
  ), false) AS "canDeleteLegacyMarker",
  COALESCE((
    SELECT pg_has_role(current_user, relation.relowner, 'USAGE')
    FROM pg_class AS relation
    WHERE relation.oid = to_regclass(
      'public.commerce_reconciliation_legacy_acknowledgements'
    )
  ), false) AS "canAssumeLegacyMarkerOwner";
`;

const FINANCIAL_DIGEST_KEYS = [
  'commerce_orders',
  'commerce_payment_attempts',
  'commerce_payment_events',
  'commerce_settlements',
  'commerce_fulfillment_effects',
  'commerce_refunds',
  'commerce_lifecycle_events',
  'audit_logs',
  'reconciliation_immutable',
  'reconciliation_non_null_source_keys',
];

const SAFE_DATABASE_CONNECTION_SOURCES = new Set([
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
]);

function safeDatabaseFailure(failureClass, databaseConnectionSource) {
  const error = migrationPreflightFailure(failureClass);
  if (SAFE_DATABASE_CONNECTION_SOURCES.has(databaseConnectionSource)) {
    error.databaseConnectionSource = databaseConnectionSource;
  }
  return error;
}

function buildDatabaseClientConfig(connectionString, applicationName) {
  return {
    application_name: applicationName,
    connectionString,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  };
}

function buildDatabaseClient(connectionString, applicationName) {
  return new Client(buildDatabaseClientConfig(connectionString, applicationName));
}

async function withReadOnlyTransaction(
  connectionString,
  applicationName,
  callback,
  databaseConnectionSource = 'MIGRATION_DATABASE_URL',
) {
  const client = buildDatabaseClient(connectionString, applicationName);
  let transactionOpen = false;
  try {
    try {
      await client.connect();
    } catch {
      throw safeDatabaseFailure(
        'MIGRATION_DATABASE_CONNECTION_FAILED',
        databaseConnectionSource,
      );
    }

    try {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      transactionOpen = true;
      await client.query('SET LOCAL search_path = public, pg_catalog');
      const value = await callback(client);
      await client.query('COMMIT');
      transactionOpen = false;
      return value;
    } catch (error) {
      if (error && error.failureClass) throw error;
      throw safeDatabaseFailure('MIGRATION_DATABASE_QUERY_FAILED');
    }
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function inspectServerIdentity(connectionString, expectedName) {
  const expected = databaseIdentity(connectionString, expectedName);
  const client = buildDatabaseClient(
    connectionString,
    'eduai-migration-role-identity',
  );
  try {
    try {
      await client.connect();
    } catch {
      throw safeDatabaseFailure(
        'MIGRATION_DATABASE_CONNECTION_FAILED',
        expectedName,
      );
    }

    let result;
    try {
      result = await client.query(SERVER_IDENTITY_QUERY);
    } catch {
      throw safeDatabaseFailure('MIGRATION_DATABASE_IDENTITY_QUERY_FAILED');
    }
    if (result.rowCount !== 1) {
      throw safeDatabaseFailure('MIGRATION_DATABASE_IDENTITY_INCOMPLETE');
    }

    const row = result.rows[0];
    if (
      row.currentUser !== expected.username ||
      row.currentDatabase !== expected.database
    ) {
      throw safeDatabaseFailure('MIGRATION_DATABASE_IDENTITY_MISMATCH');
    }

    return { roleIdentityVerified: true, databaseIdentityVerified: true };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyDatabaseRoleSeparationAtServer(runtimeUrl, migrationUrl) {
  const urlLevel = verifyDatabaseRoleSeparation(runtimeUrl, migrationUrl);
  const [runtimeIdentity, migrationIdentity] = await Promise.all([
    inspectServerIdentity(runtimeUrl, 'DATABASE_URL'),
    inspectServerIdentity(migrationUrl, 'MIGRATION_DATABASE_URL'),
  ]);

  if (!runtimeIdentity.roleIdentityVerified || !migrationIdentity.roleIdentityVerified) {
    throw safeDatabaseFailure('MIGRATION_DATABASE_IDENTITY_INCOMPLETE');
  }

  return {
    ...urlLevel,
    runtimeRoleIdentityVerified: true,
    migrationRoleIdentityVerified: true,
    databaseRolesSeparated: true,
  };
}

async function verifyMigrationRolePrivileges(migrationUrl) {
  return withReadOnlyTransaction(
    migrationUrl,
    'eduai-migration-role-privileges',
    async (client) => {
      let result;
      try {
        result = await client.query(MIGRATION_PRIVILEGE_QUERY);
      } catch {
        throw safeDatabaseFailure('MIGRATION_ROLE_PRIVILEGE_QUERY_FAILED');
      }
      if (result.rowCount !== 1) {
        throw safeDatabaseFailure('MIGRATION_ROLE_PRIVILEGE_METADATA_INCOMPLETE');
      }
      const requiredPrivileges = [
        'canUsePublicSchema',
        'canCreateInPublicSchema',
        'canReadMigrationLedger',
        'canInsertMigrationLedger',
        'canUpdateMigrationLedger',
        'requiredTablesPresent',
        'canAlterRequiredTables',
        'canReadRequiredTables',
        'requiredFunctionsPresent',
        'canAlterRequiredFunctions',
      ];
      if (requiredPrivileges.some((key) => result.rows[0][key] !== true)) {
        throw safeDatabaseFailure('MIGRATION_ROLE_PRIVILEGE_INSUFFICIENT');
      }
      return { migrationRolePrivilegesVerified: true };
    },
    'MIGRATION_DATABASE_URL',
  );
}

async function verifyRuntimeFinancialGuardPrivileges(runtimeUrl) {
  return withReadOnlyTransaction(
    runtimeUrl,
    'eduai-runtime-financial-guard-check',
    async (client) => {
      let result;
      try {
        result = await client.query(RUNTIME_FINANCIAL_GUARD_QUERY);
      } catch {
        throw safeDatabaseFailure('MIGRATION_RUNTIME_GUARD_QUERY_FAILED');
      }
      if (result.rowCount !== 1) {
        throw safeDatabaseFailure('MIGRATION_RUNTIME_GUARD_METADATA_INCOMPLETE');
      }
      const row = result.rows[0];
      for (const key of [
        'markerTablePresent',
        'canInsertLegacyMarker',
        'canUpdateLegacyMarker',
        'canDeleteLegacyMarker',
        'canAssumeLegacyMarkerOwner',
      ]) {
        requiredBoolean(row[key], key);
      }
      if (
        row.markerTablePresent !== true ||
        row.canInsertLegacyMarker !== false ||
        row.canUpdateLegacyMarker !== false ||
        row.canDeleteLegacyMarker !== false ||
        row.canAssumeLegacyMarkerOwner !== false
      ) {
        throw safeDatabaseFailure('MIGRATION_RUNTIME_GUARD_PRIVILEGE_EXPOSED');
      }
      return { runtimeFinancialGuardPrivilegesBlocked: true };
    },
    'DATABASE_URL',
  );
}

function parseDigestSnapshot(result) {
  if (result.rowCount !== 1 || !result.rows[0]?.digests) {
    throw safeDatabaseFailure('MIGRATION_FINANCIAL_DIGEST_INCOMPLETE');
  }

  const digests = result.rows[0].digests;
  for (const key of FINANCIAL_DIGEST_KEYS) {
    const entry = digests[key];
    if (!entry || !/^[0-9a-f]{32}$/i.test(String(entry.digest))) {
      throw safeDatabaseFailure('MIGRATION_FINANCIAL_DIGEST_INCOMPLETE');
    }
    numericCount(entry.rowCount, `digest_${key}`);
  }
  return digests;
}

function assertFinancialDigestUnchanged(before, after) {
  for (const key of FINANCIAL_DIGEST_KEYS) {
    if (
      !before?.[key] ||
      !after?.[key] ||
      before[key].rowCount !== after[key].rowCount ||
      before[key].digest !== after[key].digest
    ) {
      throw safeDatabaseFailure('MIGRATION_FINANCIAL_STATE_CHANGED');
    }
  }
}

function assertReconciliationFinancialBaseline(digests) {
  if (!digests || typeof digests !== 'object') {
    throw safeDatabaseFailure('MIGRATION_FINANCIAL_DIGEST_INCOMPLETE');
  }
  for (const [key, expectedRowCount] of Object.entries(
    RECONCILIATION_FINANCIAL_ROW_COUNTS,
  )) {
    const actualRowCount = numericCount(digests[key]?.rowCount, `digest_${key}`);
    if (actualRowCount !== expectedRowCount) {
      throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
    }
  }
  return digests;
}

function assertReconciliationPreflight(snapshot) {
  const expectedBooleans = {
    requiredTablesPresent: true,
    requiredFunctionsPresent: true,
    requiredTriggersPresent: true,
    requiredTriggerBindingsPresent: true,
    markerTablePresent: false,
    markerTriggerPresent: false,
    markerTriggerBindingPresent: false,
    markerGuardFunctionPresent: false,
    hardenedResolutionGuard: false,
    hardenedSourceKeyGuard: false,
    sourceKeyNullable: true,
    sourceKeyNotNull: false,
    sourceKeyTypeCompatible: true,
    sourceKeyUniqueIndexPresent: true,
    markerTriggerShapeCompatible: false,
    markerForeignKeyPresent: false,
  };
  for (const [key, expected] of Object.entries(expectedBooleans)) {
    if (requiredBoolean(snapshot?.[key], key) !== expected) {
      throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
    }
  }

  const expectedCounts = {
    totalCaseCount: 7,
    openCaseCount: 4,
    openProviderOutageCount: 2,
    openProviderFactMismatchCount: 2,
    openPaidNotFulfilledCount: 0,
    nullSourceKeyCount: 0,
    nonCanonicalExistingSourceKeyCount: 1,
    sourceKeyNonNullCount: 7,
    oversizedSourceKeyCount: 0,
    acknowledgedFinancialCaseCount: 1,
    unprovenLegacyCaseCount: 0,
    candidateSourceKeyCount: 0,
    missingAttemptCount: 0,
    missingSettlementCount: 0,
    duplicateGroupCount: 0,
    duplicateExtraRowCount: 0,
    existingCollisionCount: 0,
    oversizedDerivedKeyCount: 0,
    invalidDerivedKeyCount: 0,
    historicalCaseCount: 1,
    historicalAmbiguityMatchCount: 1,
    historicalSourceKeyPresentCount: 1,
    historicalCanonicalSourceKeyMatchCount: 1,
    historicalProvenanceMatchCount: 1,
    historicalFinancialFactMatchCount: 1,
    historicalSettlementFactAbsentMatchCount: 1,
    historicalWebhookFactAbsentMatchCount: 1,
    historicalFulfillmentAbsentMatchCount: 1,
    historicalAuditTransitionMatchCount: 1,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (numericCount(snapshot?.[key], key) !== expected) {
      throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
    }
  }

  return snapshot;
}

function assertReconciliationPreflightStable(before, after) {
  if (!before || !after) {
    throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
  }
  if (
    before.ledger?.currentSchemaVersion !== after.ledger?.currentSchemaVersion ||
    JSON.stringify(before.ledger?.pendingMigrationNames) !==
      JSON.stringify(after.ledger?.pendingMigrationNames) ||
    before.ledger?.targetApplied !== after.ledger?.targetApplied
  ) {
    throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
  }

  for (const section of ['roles', 'privileges', 'schema']) {
    if (JSON.stringify(before[section]) !== JSON.stringify(after[section])) {
      throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
    }
  }

  const caseKeys = new Set([
    ...Object.keys(before.caseSnapshot ?? {}),
    ...Object.keys(after.caseSnapshot ?? {}),
  ]);
  for (const key of caseKeys) {
    if (String(before.caseSnapshot?.[key]) !== String(after.caseSnapshot?.[key])) {
      throw safeDatabaseFailure('MIGRATION_PREFLIGHT_STATE_DRIFT');
    }
  }

  for (const key of FINANCIAL_DIGEST_KEYS) {
    if (
      before.financialDigest?.[key]?.rowCount !==
        after.financialDigest?.[key]?.rowCount ||
      before.financialDigest?.[key]?.digest !== after.financialDigest?.[key]?.digest
    ) {
      throw safeDatabaseFailure('MIGRATION_FINANCIAL_STATE_CHANGED');
    }
  }
  return after;
}

function assertMigrationAppliedExactlyOnce({
  expectedMigrationName = EXPECTED_RECONCILIATION_MIGRATION,
  expectedMigrationSha256 = EXPECTED_RECONCILIATION_MIGRATION_SHA256,
  localMigrationNames: localNames,
  localMigrationChecksums: localChecksums,
  migrationRows,
}) {
  if (!Array.isArray(localNames) || !Array.isArray(migrationRows)) {
    throw safeDatabaseFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }
  const applied = new Set();
  const targetRows = [];
  for (const row of migrationRows) {
    const rolledBack = row?.rolled_back_at !== null;
    if (
      !row ||
      typeof row.migration_name !== 'string' ||
      typeof row.checksum !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(row.checksum) ||
      row.rolled_back_at === undefined ||
      (rolledBack
        ? row.finished_at !== null
        : row.finished_at === null || row.finished_at === undefined)
    ) {
      throw safeDatabaseFailure('MIGRATION_LEDGER_STATE_DRIFT');
    }
    if (
      localChecksums &&
      (typeof localChecksums[row.migration_name] !== 'string' ||
        row.checksum.toUpperCase() !==
          localChecksums[row.migration_name].toUpperCase())
    ) {
      throw safeDatabaseFailure('MIGRATION_LEDGER_CHECKSUM_MISMATCH');
    }
    if (rolledBack) continue;
    if (applied.has(row.migration_name)) {
      throw safeDatabaseFailure('MIGRATION_LEDGER_STATE_DRIFT');
    }
    applied.add(row.migration_name);
    if (row.migration_name === expectedMigrationName) targetRows.push(row);
  }

  if (
    targetRows.length !== 1 ||
    localNames.some((name) => !applied.has(name)) ||
    [...applied].some((name) => !localNames.includes(name))
  ) {
    throw safeDatabaseFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }
  if (
    targetRows[0].checksum.toUpperCase() !== expectedMigrationSha256.toUpperCase()
  ) {
    throw safeDatabaseFailure('MIGRATION_ARTIFACT_CHECKSUM_MISMATCH');
  }

  return {
    currentSchemaVersion:
      migrationRows.filter((row) => applied.has(row.migration_name)).at(-1)
        ?.migration_name ?? null,
    targetApplied: true,
  };
}

function assertReconciliationPostflight({
  ledger,
  schema,
  caseSnapshot,
  markerSnapshot,
  preflightSnapshot,
  financialDigestBefore,
  financialDigestAfter,
}) {
  if (!ledger?.targetApplied) {
    throw safeDatabaseFailure('MIGRATION_LEDGER_STATE_DRIFT');
  }

  const expectedBooleans = {
    requiredTablesPresent: true,
    requiredFunctionsPresent: true,
    requiredTriggersPresent: true,
    requiredTriggerBindingsPresent: true,
    markerTablePresent: true,
    markerTriggerPresent: true,
    markerTriggerBindingPresent: true,
    markerGuardFunctionPresent: true,
    hardenedResolutionGuard: true,
    hardenedSourceKeyGuard: true,
    sourceKeyNullable: false,
    sourceKeyNotNull: true,
    sourceKeyTypeCompatible: true,
    sourceKeyUniqueIndexPresent: true,
    markerTriggerShapeCompatible: true,
    markerForeignKeyPresent: true,
  };
  for (const [key, expected] of Object.entries(expectedBooleans)) {
    if (requiredBoolean(schema?.[key], key) !== expected) {
      throw safeDatabaseFailure('MIGRATION_POSTFLIGHT_GUARD_MISSING');
    }
  }

  const unchangedCounts = [
    'totalCaseCount',
    'openCaseCount',
    'openProviderOutageCount',
    'openProviderFactMismatchCount',
    'openPaidNotFulfilledCount',
    'nonCanonicalExistingSourceKeyCount',
    'acknowledgedFinancialCaseCount',
    'unprovenLegacyCaseCount',
    'historicalCaseCount',
    'historicalAmbiguityMatchCount',
    'historicalSourceKeyPresentCount',
    'historicalCanonicalSourceKeyMatchCount',
    'historicalProvenanceMatchCount',
    'historicalFinancialFactMatchCount',
    'historicalSettlementFactAbsentMatchCount',
    'historicalWebhookFactAbsentMatchCount',
    'historicalFulfillmentAbsentMatchCount',
    'historicalAuditTransitionMatchCount',
  ];
  for (const key of unchangedCounts) {
    if (
      numericCount(caseSnapshot?.[key], key) !==
      numericCount(preflightSnapshot?.[key], key)
    ) {
      throw safeDatabaseFailure('MIGRATION_RECONCILIATION_STATE_CHANGED');
    }
  }

  for (const key of [
    'nullSourceKeyCount',
    'oversizedSourceKeyCount',
    'candidateSourceKeyCount',
    'missingAttemptCount',
    'missingSettlementCount',
    'duplicateGroupCount',
    'duplicateExtraRowCount',
    'existingCollisionCount',
    'oversizedDerivedKeyCount',
    'invalidDerivedKeyCount',
  ]) {
    if (numericCount(caseSnapshot?.[key], key) !== 0) {
      throw safeDatabaseFailure('MIGRATION_POSTFLIGHT_SOURCE_KEY_INVALID');
    }
  }

  if (
    numericCount(caseSnapshot?.sourceKeyNonNullCount, 'sourceKeyNonNullCount') <
    numericCount(preflightSnapshot?.sourceKeyNonNullCount, 'sourceKeyNonNullCount')
  ) {
    throw safeDatabaseFailure('MIGRATION_RECONCILIATION_STATE_CHANGED');
  }

  const markerCounts = {
    markerCount: numericCount(markerSnapshot?.markerCount, 'markerCount'),
    acknowledgedFinancialCaseCount: numericCount(
      markerSnapshot?.acknowledgedFinancialCaseCount,
      'acknowledgedFinancialCaseCount',
    ),
    matchedMarkerCount: numericCount(
      markerSnapshot?.matchedMarkerCount,
      'matchedMarkerCount',
    ),
    unmarkedLegacyCaseCount: numericCount(
      markerSnapshot?.unmarkedLegacyCaseCount,
      'unmarkedLegacyCaseCount',
    ),
    mismatchedLegacyMarkerCount: numericCount(
      markerSnapshot?.mismatchedLegacyMarkerCount,
      'mismatchedLegacyMarkerCount',
    ),
    orphanMarkerCount: numericCount(
      markerSnapshot?.orphanMarkerCount,
      'orphanMarkerCount',
    ),
    unexpectedMarkerCount: numericCount(
      markerSnapshot?.unexpectedMarkerCount,
      'unexpectedMarkerCount',
    ),
  };
  if (
    markerCounts.acknowledgedFinancialCaseCount !==
      numericCount(caseSnapshot.acknowledgedFinancialCaseCount, 'acknowledgedFinancialCaseCount') ||
    markerCounts.markerCount !== markerCounts.acknowledgedFinancialCaseCount ||
    markerCounts.matchedMarkerCount !== markerCounts.markerCount ||
    markerCounts.unmarkedLegacyCaseCount !== 0 ||
    markerCounts.mismatchedLegacyMarkerCount !== 0 ||
    markerCounts.orphanMarkerCount !== 0 ||
    markerCounts.unexpectedMarkerCount !== 0
  ) {
    throw safeDatabaseFailure('MIGRATION_LEGACY_MARKER_INVALID');
  }

  assertFinancialDigestUnchanged(financialDigestBefore, financialDigestAfter);
  return {
    sourceKeyBackfillRows:
      numericCount(caseSnapshot.sourceKeyNonNullCount, 'sourceKeyNonNullCount') -
      numericCount(preflightSnapshot.sourceKeyNonNullCount, 'sourceKeyNonNullCount'),
    legacyMarkerRows: markerCounts.markerCount,
    financialRowsChanged: 0,
  };
}

function createSafeMigrationPreflightDiagnostic(error) {
  const attachedClass =
    error && typeof error === 'object' && typeof error.failureClass === 'string'
      ? error.failureClass
      : '';
  const message = error instanceof Error ? error.message : '';
  const diagnostic = {
    failureClass: /^[A-Z0-9_]+$/.test(attachedClass)
      ? attachedClass
      : classifyMigrationFailure(message),
  };
  const connectionSource =
    error &&
    typeof error === 'object' &&
    typeof error.databaseConnectionSource === 'string'
      ? error.databaseConnectionSource
      : '';
  if (SAFE_DATABASE_CONNECTION_SOURCES.has(connectionSource)) {
    diagnostic.databaseConnectionSource = connectionSource;
  }
  return diagnostic;
}

function buildMigrationChildEnvironment(runtimeDatabaseUrl, migrationDatabaseUrl) {
  return {
    ...process.env,
    DATABASE_URL: runtimeDatabaseUrl,
    MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    PGOPTIONS: '-c search_path=public,pg_catalog',
  };
}

async function runMigrationPreflight({
  rootDirectory,
  runtimeUrl,
  migrationUrl,
}) {
  const migrationHash = assertReviewedMigrationFingerprint(rootDirectory);
  const roles = await verifyDatabaseRoleSeparationAtServer(
    runtimeUrl,
    migrationUrl,
  );
  const privileges = await verifyMigrationRolePrivileges(migrationUrl);
  const localNames = localMigrationNames(rootDirectory);
  const localChecksums = localMigrationChecksums(rootDirectory, localNames);
  const preflight = await withReadOnlyTransaction(
    migrationUrl,
    'eduai-migration-preflight',
    async (client) => {
      let ledgerResult;
      let schemaResult;
      let caseResult;
      let digestResult;
      try {
        ledgerResult = await client.query(MIGRATION_LEDGER_QUERY);
        schemaResult = await client.query(RECONCILIATION_SCHEMA_QUERY);
        caseResult = await client.query(RECONCILIATION_CASE_STATE_QUERY);
        digestResult = await client.query(RECONCILIATION_FINANCIAL_DIGEST_QUERY);
      } catch {
        throw safeDatabaseFailure('MIGRATION_PREFLIGHT_QUERY_FAILED');
      }
      if (schemaResult.rowCount !== 1 || caseResult.rowCount !== 1) {
        throw safeDatabaseFailure('MIGRATION_PREFLIGHT_METADATA_INCOMPLETE');
      }
      const ledger = assertMigrationLedgerState({
        localMigrationNames: localNames,
        localMigrationChecksums: localChecksums,
        migrationRows: ledgerResult.rows,
      });
      const caseSnapshot = assertReconciliationPreflight(caseResult.rows[0]);
      const financialDigest = parseDigestSnapshot(digestResult);
      assertReconciliationFinancialBaseline(financialDigest);
      return {
        ledger,
        schema: schemaResult.rows[0],
        caseSnapshot,
        financialDigest,
      };
    },
    'MIGRATION_DATABASE_URL',
  );

  return {
    migrationHash,
    roles,
    privileges,
    localMigrationNames: localNames,
    ...preflight,
  };
}

async function runMigrationPostflight({
  rootDirectory,
  migrationUrl,
  preflight,
}) {
  const localNames = localMigrationNames(rootDirectory);
  const localChecksums = localMigrationChecksums(rootDirectory, localNames);
  const postflight = await withReadOnlyTransaction(
    migrationUrl,
    'eduai-migration-postflight',
    async (client) => {
      let ledgerResult;
      let schemaResult;
      let caseResult;
      let markerResult;
      let digestResult;
      try {
        ledgerResult = await client.query(MIGRATION_LEDGER_QUERY);
        schemaResult = await client.query(RECONCILIATION_SCHEMA_QUERY);
        caseResult = await client.query(RECONCILIATION_CASE_STATE_QUERY);
        markerResult = await client.query(RECONCILIATION_MARKER_QUERY);
        digestResult = await client.query(RECONCILIATION_FINANCIAL_DIGEST_QUERY);
      } catch {
        throw safeDatabaseFailure('MIGRATION_POSTFLIGHT_QUERY_FAILED');
      }
      if (
        schemaResult.rowCount !== 1 ||
        caseResult.rowCount !== 1 ||
        markerResult.rowCount !== 1
      ) {
        throw safeDatabaseFailure('MIGRATION_POSTFLIGHT_METADATA_INCOMPLETE');
      }
      return {
        ledger: assertMigrationAppliedExactlyOnce({
          expectedMigrationSha256: preflight.migrationHash,
          localMigrationNames: localNames,
          localMigrationChecksums: localChecksums,
          migrationRows: ledgerResult.rows,
        }),
        schema: schemaResult.rows[0],
        caseSnapshot: caseResult.rows[0],
        markerSnapshot: markerResult.rows[0],
        financialDigest: parseDigestSnapshot(digestResult),
      };
    },
    'MIGRATION_DATABASE_URL',
  );

  const checks = assertReconciliationPostflight({
    ...postflight,
    preflightSnapshot: preflight.caseSnapshot,
    financialDigestBefore: preflight.financialDigest,
    financialDigestAfter: postflight.financialDigest,
  });
  return { ...postflight, checks };
}

async function run() {
  const rootDirectory = process.cwd();
  dotenv.config({ quiet: true });
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  const migrationDatabaseUrl = loadMigrationDatabaseUrl(rootDirectory);

  let preflight = await runMigrationPreflight({
    rootDirectory,
    runtimeUrl: runtimeDatabaseUrl,
    migrationUrl: migrationDatabaseUrl,
  });
  const repeatPreflight = await runMigrationPreflight({
    rootDirectory,
    runtimeUrl: runtimeDatabaseUrl,
    migrationUrl: migrationDatabaseUrl,
  });
  assertReconciliationPreflightStable(preflight, repeatPreflight);
  preflight = repeatPreflight;

  console.log(`migrationFileHash: ${preflight.migrationHash}`);
  console.log(
    `runtimeDatabaseConfigured: ${preflight.roles.runtimeDatabaseConfigured}`,
  );
  console.log(
    `migrationDatabaseConfigured: ${preflight.roles.migrationDatabaseConfigured}`,
  );
  console.log(
    `runtimeRoleIdentityVerified: ${preflight.roles.runtimeRoleIdentityVerified}`,
  );
  console.log(
    `migrationRoleIdentityVerified: ${preflight.roles.migrationRoleIdentityVerified}`,
  );
  console.log(`databaseRolesSeparated: ${preflight.roles.databaseRolesSeparated}`);
  console.log(
    `migrationRolePrivilegesVerified: ${preflight.privileges.migrationRolePrivilegesVerified}`,
  );
  console.log(
    `currentSchemaVersion: ${safeMigrationName(preflight.ledger.currentSchemaVersion)}`,
  );
  console.log(
    `pendingMigrationName: ${safeMigrationName(preflight.ledger.pendingMigrationNames[0])}`,
  );
  console.log(
    `preflightOpenCaseCount: ${numericCount(preflight.caseSnapshot.openCaseCount, 'openCaseCount')}`,
  );
  console.log(
    `preflightAcknowledgedFinancialCaseCount: ${numericCount(preflight.caseSnapshot.acknowledgedFinancialCaseCount, 'acknowledgedFinancialCaseCount')}`,
  );
  console.log(
    `preflightNullSourceKeyCount: ${numericCount(preflight.caseSnapshot.nullSourceKeyCount, 'nullSourceKeyCount')}`,
  );
  console.log(
    `preflightFinancialEvidenceCounts: ${FINANCIAL_DIGEST_KEYS
      .map((key) => `${key}=${numericCount(preflight.financialDigest[key].rowCount, `digest_${key}`)}`)
      .join(',')}`,
  );

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const migrationHashBeforeApply = assertReviewedMigrationFingerprint(rootDirectory);
  if (migrationHashBeforeApply !== preflight.migrationHash) {
    throw safeDatabaseFailure('MIGRATION_ARTIFACT_CHANGED_AFTER_PREFLIGHT');
  }
  const migration = spawnSync(
    npmCommand,
    ['run', 'prisma:migrate:deploy'],
    {
      env: buildMigrationChildEnvironment(
        runtimeDatabaseUrl,
        migrationDatabaseUrl,
      ),
      cwd: rootDirectory,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  );

  if (migration.error) {
    throw safeDatabaseFailure(
      migration.error.code === 'ETIMEDOUT'
        ? 'MIGRATION_PROCESS_TIMEOUT'
        : 'MIGRATION_PROCESS_SPAWN_FAILED',
    );
  }
  if (migration.status !== 0 || migration.signal) {
    const migrationOutput = [migration.stdout, migration.stderr]
      .filter((value) => typeof value === 'string' && value)
      .join('\n');
    const safeErrorCodes = extractSafeMigrationErrorCodes(migrationOutput);
    if (safeErrorCodes.prismaCode) {
      console.error(`migrationPrismaErrorCode: ${safeErrorCodes.prismaCode}`);
    }
    if (safeErrorCodes.sqlState) {
      console.error(`migrationSqlState: ${safeErrorCodes.sqlState}`);
    }
    const failureClass = classifyMigrationFailure(migrationOutput);
    throw safeDatabaseFailure(failureClass);
  }

  const postflight = await runMigrationPostflight({
    rootDirectory,
    migrationUrl: migrationDatabaseUrl,
    preflight,
  });
  console.log('migrationPostflight: PASS');
  console.log(`sourceKeyBackfillRows: ${postflight.checks.sourceKeyBackfillRows}`);
  console.log(`legacyMarkerRows: ${postflight.checks.legacyMarkerRows}`);
  console.log(`financialRowsChanged: ${postflight.checks.financialRowsChanged}`);

  const runtimeFinancialGuard = await verifyRuntimeFinancialGuardPrivileges(
    runtimeDatabaseUrl,
  );
  console.log(
    `runtimeFinancialGuardPrivilegesBlocked: ${runtimeFinancialGuard.runtimeFinancialGuardPrivilegesBlocked}`,
  );

  await grantRuntimeMembershipPrivileges(
    migrationDatabaseUrl,
    runtimeDatabaseUrl,
  );
  console.log('runtimeMembershipPrivilegesGranted: true');
}

if (require.main === module) {
  run().catch((error) => {
    const diagnostic = createSafeMigrationPreflightDiagnostic(error);
    console.error(`migrationFailureClass: ${diagnostic.failureClass}`);
    if (diagnostic.databaseConnectionSource) {
      console.error(
        `migrationDatabaseConnectionSource: ${diagnostic.databaseConnectionSource}`,
      );
    }
    console.error('Production migration failed closed');
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_RECONCILIATION_MIGRATION,
  EXPECTED_RECONCILIATION_MIGRATION_SHA256,
  FINANCIAL_DIGEST_KEYS,
  RECONCILIATION_FINANCIAL_ROW_COUNTS,
  RECONCILIATION_CASE_STATE_QUERY,
  RECONCILIATION_FINANCIAL_DIGEST_QUERY,
  RECONCILIATION_MARKER_QUERY,
  RECONCILIATION_SCHEMA_QUERY,
  MIGRATION_PRIVILEGE_QUERY,
  RUNTIME_FINANCIAL_GUARD_QUERY,
  assertMigrationAppliedExactlyOnce,
  assertMigrationLedgerState,
  assertReconciliationFinancialBaseline,
  assertReconciliationPreflightStable,
  assertReconciliationPostflight,
  assertReconciliationPreflight,
  assertReviewedMigrationFingerprint,
  classifyMigrationFailure,
  extractSafeMigrationErrorCodes,
  createSafeMigrationPreflightDiagnostic,
  buildDatabaseClientConfig,
  localMigrationNames,
  localMigrationChecksums,
  loadMigrationDatabaseUrl,
  runMigrationPostflight,
  runMigrationPreflight,
  safeMigrationName,
  buildMigrationChildEnvironment,
  verifyRuntimeFinancialGuardPrivileges,
  verifyDatabaseRoleSeparationAtServer,
  verifyDatabaseRoleSeparation,
};
