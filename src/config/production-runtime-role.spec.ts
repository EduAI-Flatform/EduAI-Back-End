import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  RUNTIME_ROLE_QUERY,
  assessRuntimeRole,
  assertRuntimeRoleReady,
}: {
  RUNTIME_ROLE_QUERY: string;
  assessRuntimeRole: (row: Record<string, unknown>) => Record<string, boolean>;
  assertRuntimeRoleReady: (assessment: Record<string, boolean>) => void;
} = require('../../scripts/verify-production-runtime-role.cjs');

describe('production runtime database role verifier', () => {
  const safeRow = {
    commerceTablesPresent: true,
    runtimeRoleSuperuser: false,
    runtimeRoleHasBypassRlsAttribute: false,
    runtimeRoleOwnsCommerceTables: false,
    runtimeRoleCanAssumeCommerceOwner: false,
  };

  it('accepts only a fully least-privilege runtime role', () => {
    const assessment = assessRuntimeRole(safeRow);

    expect(assessment).toEqual({
      commerceTablesPresent: true,
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
    expect(RUNTIME_ROLE_QUERY).not.toMatch(/\b(ALTER|UPDATE|DELETE|INSERT|DROP)\b/i);
    expect(workflow).toContain('npm run db:verify:production-runtime-role');
    expect(verifier).not.toContain('MIGRATION_DATABASE_URL');
    expect(verifier).not.toContain('console.error(error');
  });
});
