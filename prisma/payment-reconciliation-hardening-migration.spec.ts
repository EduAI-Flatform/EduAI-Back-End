import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');
const {
  FINANCIAL_DIGEST_KEYS,
  RECONCILIATION_CASE_STATE_QUERY,
  RECONCILIATION_FINANCIAL_DIGEST_QUERY,
  RECONCILIATION_MARKER_QUERY,
  RECONCILIATION_SCHEMA_QUERY,
  MIGRATION_PRIVILEGE_QUERY,
}: {
  FINANCIAL_DIGEST_KEYS: readonly string[];
  RECONCILIATION_CASE_STATE_QUERY: string;
  RECONCILIATION_FINANCIAL_DIGEST_QUERY: string;
  RECONCILIATION_MARKER_QUERY: string;
  RECONCILIATION_SCHEMA_QUERY: string;
  MIGRATION_PRIVILEGE_QUERY: string;
} = require('../scripts/run-production-migrations.cjs');

const migrationDirectory = '20260916123000_harden_reconciliation_source_identity';
const migrationsRoot = join(__dirname, 'migrations');
const readMigrationFile = (fileName: string): string =>
  readFileSync(
    join(process.cwd(), 'prisma', 'migrations', migrationDirectory, fileName),
    'utf8',
  );

describe('SPR25-007 reconciliation hardening migration', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      const migrationPath = join(migrationsRoot, directory, 'migration.sql');
      if (!existsSync(migrationPath)) continue;
      await db.exec(readFileSync(migrationPath, 'utf8'));
    }
    await db.exec(`
      CREATE TABLE "_prisma_migrations" (
        "id" TEXT PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMP(3),
        "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
        "finished_at" TIMESTAMP(3)
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('derives and enforces deterministic reconciliation source identity', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).toContain('deterministic_source_keys');
    expect(sql).toContain('duplicate reconciliation source keys');
    expect(sql).toContain('existing reconciliation source-key collision');
    expect(sql).toContain('existing acknowledged financial reconciliation cases');
    expect(sql).toContain('ALTER COLUMN "source_key" SET NOT NULL');
    expect(sql).toContain(
      "'duplicate_collection', 'late_payment', 'paid_not_fulfilled'",
    );
    expect(sql).toContain('commerce_reconciliation_legacy_acknowledgements');
    expect(sql).toContain('ON CONFLICT ("reconciliation_case_id") DO NOTHING');
    expect(sql).toContain('PRE_HARDENING_ACKNOWLEDGEMENT_NO_CANONICAL_RESOLUTION');
    expect(sql).toContain('Only NULL source_key values are derived');
  });

  it('strengthens acknowledgement protection without deleting financial history', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).toContain("'provider_outage'");
    expect(sql).toContain("'provider_fact_mismatch'");
    expect(sql).toContain("'unknown_provider_status'");
    expect(sql).toContain('financial reconciliation case cannot be acknowledged');
    expect(sql).toContain('commerce_guard_reconciliation_legacy_acknowledgement');
    expect(sql).toContain('legacy reconciliation acknowledgement evidence is immutable');
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|TRIGGER)\b/i);
  });

  it('documents forward-only recovery that preserves financial records', () => {
    const recovery = readMigrationFile('README.md');

    expect(recovery).toContain('Forward-only');
    expect(recovery).toContain('must not delete');
    expect(recovery).toContain('must not drop');
    expect(recovery).toContain('read-only transaction');
    expect(recovery).toContain('Provider-specific controls');
    expect(recovery).toContain('reconciliation');
    expect(recovery).toContain('legacy_acknowledgements');
    expect(recovery).toContain('immutable legacy provenance');
    expect(recovery).toContain('Existing non-NULL source keys');
    expect(recovery).toContain('preflight non-NULL key count is unchanged');
  });

  it('executes the sanitized preflight and postflight inspection queries', async () => {
    const schema = await db.query(RECONCILIATION_SCHEMA_QUERY);
    expect(schema.rows[0]).toMatchObject({
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
    });

    const state = await db.query<Record<string, unknown>>(
      RECONCILIATION_CASE_STATE_QUERY,
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      nullSourceKeyCount: '0',
      duplicateGroupCount: '0',
      duplicateExtraRowCount: '0',
      existingCollisionCount: '0',
      invalidDerivedKeyCount: '0',
    });

    const marker = await db.query<Record<string, unknown>>(
      RECONCILIATION_MARKER_QUERY,
    );
    expect(marker.rows).toHaveLength(1);
    expect(marker.rows[0]).toMatchObject({
      matchedMarkerCount: marker.rows[0].markerCount,
      unmarkedLegacyCaseCount: '0',
      mismatchedLegacyMarkerCount: '0',
      orphanMarkerCount: '0',
      unexpectedMarkerCount: '0',
    });

    const digest = await db.query<{
      digests: Record<string, Record<string, string>>;
    }>(RECONCILIATION_FINANCIAL_DIGEST_QUERY);
    expect(Object.keys(digest.rows[0].digests)).toEqual(
      expect.arrayContaining(FINANCIAL_DIGEST_KEYS),
    );

    const privileges = await db.query(MIGRATION_PRIVILEGE_QUERY);
    expect(privileges.rows[0]).toMatchObject({
      canUsePublicSchema: true,
      canCreateInPublicSchema: true,
      requiredTablesPresent: true,
      canAlterRequiredTables: true,
      canReadRequiredTables: true,
      requiredFunctionsPresent: true,
      canAlterRequiredFunctions: true,
    });
  });

  it('excludes only the system payment-expiry heartbeat from the audit concurrency digest', async () => {
    await db.exec(`
      INSERT INTO "audit_logs" (
        "actor_kind",
        "action",
        "target_type",
        "target_id",
        "metadata_json"
      ) VALUES
        ('SYSTEM', 'PAYMENT_EXPIRY_CHECKED', 'commerce_payment_expiry_run', 'heartbeat-1', '{}'),
        ('SYSTEM', 'PAYMENT_EXPIRY_CHECKED', 'unexpected_target', 'heartbeat-2', '{}'),
        ('SYSTEM', 'PAYMENT_RECONCILIATION_CHECKED', 'commerce_reconciliation_case', 'case-1', '{}');
    `);

    const digest = await db.query<{
      digests: Record<string, Record<string, string>>;
    }>(RECONCILIATION_FINANCIAL_DIGEST_QUERY);

    expect(digest.rows[0].digests.audit_logs.rowCount).toBe('2');
  });
});
