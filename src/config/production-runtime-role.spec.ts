import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const {
  RUNTIME_ROLE_QUERY,
  assessRuntimeRole,
  assertRuntimeRoleReady,
  buildRuntimeClientConfig,
  createSafeFailureDiagnostic,
}: {
  RUNTIME_ROLE_QUERY: string;
  assessRuntimeRole: (row: Record<string, unknown>) => Record<string, boolean>;
  assertRuntimeRoleReady: (assessment: Record<string, boolean>) => void;
  buildRuntimeClientConfig: (connectionString: string) => Record<string, unknown>;
  createSafeFailureDiagnostic: (
    error: unknown,
    stage?: string,
  ) => { stage: string; failureClass: string };
} = require('../../scripts/verify-production-runtime-role.cjs');

describe('production runtime database role verifier', () => {
  const safeRow = {
    commerceTablesPresent: true,
    membershipTablesPresent: true,
    runtimeRoleCanUseMembershipTables: true,
    runtimeRoleSuperuser: false,
    runtimeRoleHasBypassRlsAttribute: false,
    runtimeRoleOwnsCommerceTables: false,
    runtimeRoleCanAssumeCommerceOwner: false,
  };

  it('accepts only a fully least-privilege runtime role', () => {
    const assessment = assessRuntimeRole(safeRow);

    expect(assessment).toEqual({
      commerceTablesPresent: true,
      membershipTablesPresent: true,
      runtimeRoleCanUseMembershipTables: true,
      runtimeRoleSuperuser: false,
      runtimeRoleHasBypassRlsAttribute: false,
      runtimeRoleOwnsCommerceTables: false,
      runtimeRoleCanAssumeCommerceOwner: false,
      runtimeRoleCanBypassCommerceGuards: false,
      runtimeRoleCanDisableCommerceTriggers: false,
      runtimeRoleLeastPrivilegeReady: true,
    });
    expect(() => assertRuntimeRoleReady(assessment)).not.toThrow();
  });

  it.each([
    ['missing Commerce tables', { commerceTablesPresent: false }],
    ['missing membership tables', { membershipTablesPresent: false }],
    ['missing membership DML privileges', { runtimeRoleCanUseMembershipTables: false }],
    ['superuser', { runtimeRoleSuperuser: true }],
    ['BYPASSRLS', { runtimeRoleHasBypassRlsAttribute: true }],
    ['table owner', { runtimeRoleOwnsCommerceTables: true }],
    ['owner-role membership', { runtimeRoleCanAssumeCommerceOwner: true }],
  ])('fails closed for %s', (_name, unsafeField) => {
    const assessment = assessRuntimeRole({ ...safeRow, ...unsafeField });

    expect(assessment.runtimeRoleLeastPrivilegeReady).toBe(false);
    expect(() => assertRuntimeRoleReady(assessment)).toThrow(
      'Production runtime database role is not least-privilege ready',
    );
  });

  it('fails closed when PostgreSQL metadata is incomplete', () => {
    expect(() =>
      assessRuntimeRole({
        ...safeRow,
        runtimeRoleSuperuser: undefined,
      }),
    ).toThrow('Runtime database role metadata is incomplete');
  });

  it('does not send PgBouncer-incompatible runtime settings in the startup packet', () => {
    const config = buildRuntimeClientConfig(
      'postgresql://user:placeholder@localhost/database',
    );
    const startup = (new Client(config) as unknown as {
      getStartupConf: () => Record<string, string>;
    }).getStartupConf();

    expect(startup).not.toHaveProperty('options');
    expect(startup).not.toHaveProperty('statement_timeout');
    expect(config).toMatchObject({
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
    });
  });

  it('emits only a fixed diagnostic for an unsupported pooled startup parameter', () => {
    const diagnostic = createSafeFailureDiagnostic(
      new Error(
        'unsupported startup parameter in options: secret-host runtime-user',
      ),
      'connection',
    );

    expect(diagnostic).toEqual({
      stage: 'connection',
      failureClass: 'POOLED_STARTUP_PARAMETER_UNSUPPORTED',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret-host');
    expect(JSON.stringify(diagnostic)).not.toContain('runtime-user');
  });

  it.each([
    ['42501', 'DATABASE_METADATA_PERMISSION_DENIED'],
    ['42883', 'DATABASE_METADATA_QUERY_INVALID'],
    ['57014', 'DATABASE_METADATA_QUERY_TIMEOUT'],
    ['08006', 'DATABASE_CONNECTION_FAILED'],
  ])('maps PostgreSQL error %s to a credential-safe class', (code, failureClass) => {
    const error = Object.assign(new Error('sensitive database detail'), {
      code,
    });

    expect(createSafeFailureDiagnostic(error, 'metadata-query')).toEqual({
      stage: 'metadata-query',
      failureClass,
    });
  });

  it('executes the MEMBER and USAGE owner checks for safe and inherited roles', () => {
    const repositoryRoot = join(__dirname, '..', '..');
    const verifierPath = join(
      repositoryRoot,
      'scripts',
      'verify-production-runtime-role.cjs',
    );
    const privilegesPath = join(
      repositoryRoot,
      'scripts',
      'membership-runtime-privileges.cjs',
    );
    const probe = `
      const { PGlite } = require('@electric-sql/pglite');
      const { RUNTIME_ROLE_QUERY, assessRuntimeRole } = require(${JSON.stringify(verifierPath)});
      const { MEMBERSHIP_RUNTIME_TABLES } = require(${JSON.stringify(privilegesPath)});
      (async () => {
        const database = new PGlite();
        try {
          await database.exec(\`
            CREATE ROLE verifier_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
            CREATE ROLE verifier_owner NOLOGIN;
            CREATE TABLE public.commerce_verifier_probe (id integer PRIMARY KEY);
            ALTER TABLE public.commerce_verifier_probe OWNER TO verifier_owner;
          \`);
          for (const table of MEMBERSHIP_RUNTIME_TABLES) {
            await database.exec(\`CREATE TABLE public."\${table}" (id integer PRIMARY KEY)\`);
            await database.exec(\`GRANT SELECT, INSERT, UPDATE ON public."\${table}" TO verifier_runtime\`);
          }
          await database.exec('SET ROLE verifier_runtime');
          const safeResult = await database.query(RUNTIME_ROLE_QUERY);
          const safeAssessment = assessRuntimeRole(safeResult.rows[0]);

          await database.exec(\`
            RESET ROLE;
            GRANT verifier_owner TO verifier_runtime;
            SET ROLE verifier_runtime;
          \`);
          const memberResult = await database.query(RUNTIME_ROLE_QUERY);
          const memberAssessment = assessRuntimeRole(memberResult.rows[0]);

          process.stdout.write(JSON.stringify({ safeAssessment, memberAssessment }));
        } finally {
          await database.close();
        }
      })().catch(() => { process.exitCode = 1; });
    `;
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', '-e', probe],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      safeAssessment: {
        commerceTablesPresent: true,
        membershipTablesPresent: true,
        runtimeRoleCanUseMembershipTables: true,
        runtimeRoleSuperuser: false,
        runtimeRoleHasBypassRlsAttribute: false,
        runtimeRoleOwnsCommerceTables: false,
        runtimeRoleCanAssumeCommerceOwner: false,
        runtimeRoleLeastPrivilegeReady: true,
      },
      memberAssessment: {
        runtimeRoleCanAssumeCommerceOwner: true,
        runtimeRoleCanBypassCommerceGuards: true,
        runtimeRoleCanDisableCommerceTriggers: true,
        runtimeRoleLeastPrivilegeReady: false,
      },
    });
  });

  it('uses metadata-only catalog inspection and the exact runtime deployment path', () => {
    const repositoryRoot = join(__dirname, '..', '..');
    const workflow = readFileSync(
      join(repositoryRoot, '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const verifier = readFileSync(
      join(repositoryRoot, 'scripts', 'verify-production-runtime-role.cjs'),
      'utf8',
    );

    expect(RUNTIME_ROLE_QUERY).toContain('pg_roles');
    expect(RUNTIME_ROLE_QUERY).toContain('pg_class');
    expect(RUNTIME_ROLE_QUERY).toContain('pg_has_role');
    expect(RUNTIME_ROLE_QUERY).toContain("namespace.nspname = 'public'");
    expect(RUNTIME_ROLE_QUERY).not.toMatch(/^\s*(ALTER|UPDATE|DELETE|INSERT|DROP)\b/im);
    expect(workflow).toContain('npm run db:verify:production-runtime-role');
    expect(verifier).not.toContain('MIGRATION_DATABASE_URL');
    expect(verifier).not.toContain('console.error(error');
  });
});
