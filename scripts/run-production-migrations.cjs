const { spawnSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const {
  grantRuntimeMembershipPrivileges,
} = require('./membership-runtime-privileges.cjs');

const MIGRATION_ENV_FILE = '.env.migration';

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

function safeMigrationName(value) {
  return typeof value === 'string' && /^\d{14}_[a-z0-9_]+$/.test(value)
    ? value
    : 'UNAVAILABLE';
}

async function findFailedMigration(connectionString) {
  const client = new Client({
    application_name: 'eduai-migration-preflight',
    connectionString,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  try {
    await client.connect();
    const result = await client.query(`
      SELECT migration_name, logs
      FROM _prisma_migrations
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
        AND logs IS NOT NULL
      ORDER BY started_at ASC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  } catch (error) {
    if (error && error.code === '42P01') return null;
    throw new Error('Failed migration metadata inspection was unavailable');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function run() {
  dotenv.config({ quiet: true });
  const migrationDatabaseUrl = loadMigrationDatabaseUrl(process.cwd());
  const result = verifyDatabaseRoleSeparation(
    process.env.DATABASE_URL,
    migrationDatabaseUrl,
  );

  console.log(
    `runtimeDatabaseConfigured: ${result.runtimeDatabaseConfigured}`,
  );
  console.log(
    `migrationDatabaseConfigured: ${result.migrationDatabaseConfigured}`,
  );
  console.log(`databaseRolesSeparated: ${result.databaseRolesSeparated}`);

  const failedMigration = await findFailedMigration(migrationDatabaseUrl);
  if (failedMigration) {
    const migrationName = safeMigrationName(failedMigration.migration_name);
    const failureClass = classifyMigrationFailure(failedMigration.logs);
    console.log('failedMigrationPresent: true');
    console.log(`failedMigrationName: ${migrationName}`);
    console.log(`migrationFailureClass: ${failureClass}`);
    console.error(
      `::error title=Production migration blocked::migrationFailureClass=${failureClass};migration=${migrationName}`,
    );
    throw new Error('A failed migration requires reviewed recovery');
  }
  console.log('failedMigrationPresent: false');

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const migration = spawnSync(
    npmCommand,
    ['run', 'prisma:migrate:deploy'],
    {
      env: {
        ...process.env,
        DATABASE_URL: migrationDatabaseUrl,
        MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      },
      stdio: 'inherit',
    },
  );

  if (migration.error) throw migration.error;
  if (migration.status !== 0) {
    process.exitCode = migration.status ?? 1;
    return;
  }

  await grantRuntimeMembershipPrivileges(
    migrationDatabaseUrl,
    process.env.DATABASE_URL,
  );
  console.log('runtimeMembershipPrivilegesGranted: true');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(
      `Production migration preflight failed: ${
        error instanceof Error ? error.message : 'unknown safe error'
      }`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  classifyMigrationFailure,
  loadMigrationDatabaseUrl,
  safeMigrationName,
  verifyDatabaseRoleSeparation,
};
