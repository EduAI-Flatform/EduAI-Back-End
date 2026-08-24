const { spawnSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const dotenv = require('dotenv');

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

function run() {
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
  process.exitCode = migration.status ?? 1;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(
      `Production migration preflight failed: ${
        error instanceof Error ? error.message : 'unknown safe error'
      }`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  loadMigrationDatabaseUrl,
  verifyDatabaseRoleSeparation,
};
