import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  verifyDatabaseRoleSeparation,
}: {
  verifyDatabaseRoleSeparation: (
    runtimeUrl: unknown,
    migrationUrl: unknown,
  ) => {
    runtimeDatabaseConfigured: boolean;
    migrationDatabaseConfigured: boolean;
    databaseRolesSeparated: boolean;
  };
} = require('../../scripts/run-production-migrations.cjs');

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
  });
});
