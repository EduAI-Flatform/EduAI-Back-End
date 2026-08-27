import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  classifyMigrationFailure,
  safeMigrationName,
  verifyDatabaseRoleSeparation,
}: {
  classifyMigrationFailure: (log: unknown) => string;
  safeMigrationName: (value: unknown) => string;
  verifyDatabaseRoleSeparation: (
    runtimeUrl: unknown,
    migrationUrl: unknown,
  ) => {
    runtimeDatabaseConfigured: boolean;
    migrationDatabaseConfigured: boolean;
    databaseRolesSeparated: boolean;
  };
} = require('../../scripts/run-production-migrations.cjs');
const {
  MEMBERSHIP_RUNTIME_TABLES,
  buildRuntimePrivilegeStatement,
  grantRuntimeMembershipPrivileges,
}: {
  MEMBERSHIP_RUNTIME_TABLES: readonly string[];
  buildRuntimePrivilegeStatement: (runtimeUrl: string) => string;
  grantRuntimeMembershipPrivileges: (
    migrationUrl: string,
    runtimeUrl: string,
    ClientConstructor?: new (config: Record<string, unknown>) => {
      connect: () => Promise<void>;
      query: (sql: string) => Promise<void>;
      end: () => Promise<void>;
    },
  ) => Promise<void>;
} = require('../../scripts/membership-runtime-privileges.cjs');

describe('production database role separation', () => {
  it('accepts distinct explicit runtime and migration roles', () => {
    expect(
      verifyDatabaseRoleSeparation(
        'postgresql://eduai_runtime:runtime-secret@pool.example/eduai',
        'postgresql://eduai_migration:migration-secret@direct.example/eduai',
      ),
    ).toEqual({
      runtimeDatabaseConfigured: true,
      migrationDatabaseConfigured: true,
      databaseRolesSeparated: true,
    });
  });

  it('fails closed without exposing connection material', () => {
    const runtimeUrl = 'postgresql://shared-role:runtime-secret@db.example/eduai';
    const migrationUrl = 'postgresql://shared-role:migration-secret@db.example/eduai';

    let message = '';
    try {
      verifyDatabaseRoleSeparation(runtimeUrl, migrationUrl);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      'DATABASE_URL and MIGRATION_DATABASE_URL must use distinct PostgreSQL roles',
    );
    expect(message).not.toContain('shared-role');
    expect(message).not.toContain('runtime-secret');
    expect(message).not.toContain('migration-secret');
    expect(() =>
      verifyDatabaseRoleSeparation(runtimeUrl, undefined),
    ).toThrow('MIGRATION_DATABASE_URL is required');
    expect(() =>
      verifyDatabaseRoleSeparation(
        'postgresql://eduai_runtime:secret@pool.example/eduai',
        'postgresql://eduai_migration:secret@direct.example/other',
      ),
    ).toThrow(
      'DATABASE_URL and MIGRATION_DATABASE_URL must target the same database',
    );
  });

  it('keeps migration credentials out of the PM2 runtime path', () => {
    const repositoryRoot = join(__dirname, '..', '..');
    const workflow = readFileSync(
      join(repositoryRoot, '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const prismaConfig = readFileSync(
      join(repositoryRoot, 'prisma.config.ts'),
      'utf8',
    );
    const runtimeClient = readFileSync(
      join(repositoryRoot, 'src', 'prisma', 'prisma.service.ts'),
      'utf8',
    );
    const migrationRunner = readFileSync(
      join(repositoryRoot, 'scripts', 'run-production-migrations.cjs'),
      'utf8',
    );

    expect(workflow).toContain('npm run prisma:migrate:production');
    expect(workflow).not.toMatch(/^\s*npm run prisma:migrate:deploy\s*$/m);
    expect(prismaConfig).toContain('process.env.MIGRATION_DATABASE_URL');
    expect(runtimeClient).toContain('connectionString: env.DATABASE_URL');
    expect(runtimeClient).not.toContain('MIGRATION_DATABASE_URL');
    expect(migrationRunner).toContain('DATABASE_URL: migrationDatabaseUrl');
    expect(migrationRunner).toContain('grantRuntimeMembershipPrivileges');
  });

  it('classifies stored migration failures without returning their raw details', () => {
    const rawLog =
      'database endpoint secret-role: unsafe use of new value "membership" of enum type';
    const failureClass = classifyMigrationFailure(rawLog);

    expect(failureClass).toBe('POSTGRES_ENUM_VALUE_NOT_COMMITTED');
    expect(failureClass).not.toContain('secret-role');
    expect(safeMigrationName('20260824160000_add_membership_product_type')).toBe(
      '20260824160000_add_membership_product_type',
    );
    expect(safeMigrationName('unsafe migration/name')).toBe('UNAVAILABLE');
  });

  it('grants only membership-table DML to the URL-derived runtime role', () => {
    const statement = buildRuntimePrivilegeStatement(
      'postgresql://runtime%22role:secret@db.example/eduai',
    );

    expect(MEMBERSHIP_RUNTIME_TABLES).toEqual(expect.arrayContaining([
      'membership_plans',
      'membership_plan_versions',
      'membership_checkout_intents',
      'membership_removed_course_snapshots',
      'membership_subscriptions',
      'service_entitlement_grants',
      'course_access_grants',
      'commerce_fulfillment_effects',
      'commerce_notification_outbox',
    ]));
    expect(statement).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE');
    expect(statement).toContain('TO "runtime""role"');
    expect(statement).not.toContain('_prisma_migrations');
    expect(statement).not.toMatch(/\b(ALTER|OWNER|BYPASSRLS|SUPERUSER)\b/i);
    expect(statement).not.toMatch(/\bDELETE\b/i);
    expect(statement).not.toContain('secret');
  });

  it('commits the bounded grant and rolls back with a secret-safe failure', async () => {
    const successfulQueries: string[] = [];
    class SuccessfulClient {
      constructor(_config: Record<string, unknown>) {}
      connect = async () => undefined;
      query = async (sql: string) => { successfulQueries.push(sql); };
      end = async () => undefined;
    }
    await grantRuntimeMembershipPrivileges(
      'postgresql://migration:migration-secret@db.example/eduai',
      'postgresql://runtime:runtime-secret@db.example/eduai',
      SuccessfulClient,
    );
    expect(successfulQueries[0]).toBe('BEGIN');
    expect(successfulQueries.at(-1)).toBe('COMMIT');

    const failedQueries: string[] = [];
    class FailingClient {
      constructor(_config: Record<string, unknown>) {}
      connect = async () => undefined;
      query = async (sql: string) => {
        failedQueries.push(sql);
        if (sql.startsWith('GRANT ')) throw new Error('secret database detail');
      };
      end = async () => undefined;
    }
    await expect(grantRuntimeMembershipPrivileges(
      'postgresql://migration:migration-secret@db.example/eduai',
      'postgresql://runtime:runtime-secret@db.example/eduai',
      FailingClient,
    )).rejects.toThrow('Runtime membership privilege grant failed');
    expect(failedQueries.at(-1)).toBe('ROLLBACK');
  });
});
