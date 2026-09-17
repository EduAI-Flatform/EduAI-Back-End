const {
  EXPECTED_RECONCILIATION_MIGRATION,
  assertMigrationLedgerState,
  assertMigrationAppliedExactlyOnce,
  assertReviewedMigrationFingerprint,
  assertReconciliationPreflight,
  assertReconciliationFinancialBaseline,
  RECONCILIATION_FINANCIAL_ROW_COUNTS,
  createSafeMigrationPreflightDiagnostic,
}: {
  EXPECTED_RECONCILIATION_MIGRATION: string;
  assertMigrationLedgerState: (input: {
    expectedMigrationName?: string;
    localMigrationNames: string[];
    migrationRows: Array<{
      migration_name: string;
      checksum: string;
      finished_at: Date | string | null;
      rolled_back_at: Date | string | null;
    }>;
  }) => {
    currentSchemaVersion: string | null;
    pendingMigrationNames: string[];
    targetApplied: boolean;
  };
  assertReviewedMigrationFingerprint: (rootDirectory: string) => string;
  assertMigrationAppliedExactlyOnce: (input: {
    expectedMigrationSha256?: string;
    localMigrationNames: string[];
    migrationRows: Array<{
      migration_name: string;
      checksum: string;
      finished_at: Date | string | null;
      rolled_back_at: Date | string | null;
    }>;
  }) => { currentSchemaVersion: string | null; targetApplied: boolean };
  assertReconciliationPreflight: (snapshot: Record<string, unknown>) => Record<string, unknown>;
  assertReconciliationFinancialBaseline: (
    digests: Record<string, { rowCount: string | number; digest: string }>,
  ) => Record<string, { rowCount: string | number; digest: string }>;
  RECONCILIATION_FINANCIAL_ROW_COUNTS: Record<string, number>;
  createSafeMigrationPreflightDiagnostic: (error: unknown) => {
    failureClass: string;
  };
} = require('../../scripts/run-production-migrations.cjs');

describe('SPR25-007 production migration preflight', () => {
  const appliedMigrationChecksum = 'a'.repeat(64);
  it('accepts only the reviewed migration fingerprint', () => {
    const repositoryRoot = require('node:path').join(__dirname, '..', '..');
    expect(assertReviewedMigrationFingerprint(repositoryRoot)).toBe(
      '03803E8EEF652CE73BEC38267E274650F45665ECBEF578749E1DAABA663CF53F',
    );
  });

  it('allows exactly the reviewed migration as the only pending migration', () => {
    const result = assertMigrationLedgerState({
      localMigrationNames: [
        '20260909030000_make_commerce_lifecycle_event_validation_immediate',
        EXPECTED_RECONCILIATION_MIGRATION,
      ],
      migrationRows: [
        {
          migration_name:
            '20260909030000_make_commerce_lifecycle_event_validation_immediate',
          checksum: appliedMigrationChecksum,
          finished_at: new Date(),
          rolled_back_at: null,
        },
      ],
    });

    expect(result).toEqual({
      currentSchemaVersion:
        '20260909030000_make_commerce_lifecycle_event_validation_immediate',
      pendingMigrationNames: [EXPECTED_RECONCILIATION_MIGRATION],
      targetApplied: false,
    });
  });

  it('accepts a rolled-back historical attempt followed by one successful attempt', () => {
    const result = assertMigrationLedgerState({
      localMigrationNames: [
        '20260824160000_add_membership_product_type',
        EXPECTED_RECONCILIATION_MIGRATION,
      ],
      migrationRows: [
        {
          migration_name: '20260824160000_add_membership_product_type',
          checksum: appliedMigrationChecksum,
          finished_at: null,
          rolled_back_at: new Date(),
        },
        {
          migration_name: '20260824160000_add_membership_product_type',
          checksum: appliedMigrationChecksum,
          finished_at: new Date(),
          rolled_back_at: null,
        },
      ],
    });

    expect(result).toMatchObject({
      pendingMigrationNames: [EXPECTED_RECONCILIATION_MIGRATION],
      targetApplied: false,
    });
  });

  it('still rejects unfinished attempts and duplicate successful attempts', () => {
    const migrationName = '20260824160000_add_membership_product_type';
    const base = {
      localMigrationNames: [migrationName, EXPECTED_RECONCILIATION_MIGRATION],
    };

    expect(() =>
      assertMigrationLedgerState({
        ...base,
        migrationRows: [
          {
            migration_name: migrationName,
            checksum: appliedMigrationChecksum,
            finished_at: null,
            rolled_back_at: null,
          },
        ],
      }),
    ).toThrow('Production migration preflight failed');

    expect(() =>
      assertMigrationLedgerState({
        ...base,
        migrationRows: [
          {
            migration_name: migrationName,
            checksum: appliedMigrationChecksum,
            finished_at: new Date(),
            rolled_back_at: null,
          },
          {
            migration_name: migrationName,
            checksum: appliedMigrationChecksum,
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toThrow('Production migration preflight failed');
  });

  it('fails closed when the target is already applied or another migration is pending', () => {
    expect(() =>
      assertMigrationLedgerState({
        localMigrationNames: [
          EXPECTED_RECONCILIATION_MIGRATION,
          '20260917999999_unrelated_change',
        ],
        migrationRows: [
          {
            migration_name: EXPECTED_RECONCILIATION_MIGRATION,
            checksum: appliedMigrationChecksum,
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toThrow('Production migration preflight failed');

    expect(() =>
      assertMigrationLedgerState({
        localMigrationNames: [
          EXPECTED_RECONCILIATION_MIGRATION,
          '20260917999999_unrelated_change',
        ],
        migrationRows: [
          {
            migration_name: '20260909030000_previous_migration',
            checksum: appliedMigrationChecksum,
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toThrow('Production migration preflight failed');
  });

  it('requires preserved historical ambiguity and zero structural collisions', () => {
    const safeSnapshot = {
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
      totalCaseCount: 7,
      openCaseCount: 4,
      openProviderOutageCount: 2,
      openProviderFactMismatchCount: 2,
      openPaidNotFulfilledCount: 0,
      nullSourceKeyCount: 0,
      nonCanonicalExistingSourceKeyCount: 1,
      sourceKeyNonNullCount: 7,
      oversizedSourceKeyCount: 0,
      unprovenLegacyCaseCount: 0,
      candidateSourceKeyCount: 0,
      missingAttemptCount: 0,
      missingSettlementCount: 0,
      duplicateGroupCount: 0,
      duplicateExtraRowCount: 0,
      existingCollisionCount: 0,
      oversizedDerivedKeyCount: 0,
      invalidDerivedKeyCount: 0,
      acknowledgedFinancialCaseCount: 1,
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

    expect(assertReconciliationPreflight(safeSnapshot)).toEqual(safeSnapshot);

    expect(() =>
      assertReconciliationPreflight({
        ...safeSnapshot,
        historicalAmbiguityMatchCount: 0,
      }),
    ).toThrow('Production migration preflight failed');

    expect(() =>
      assertReconciliationPreflight({
        ...safeSnapshot,
        existingCollisionCount: 1,
      }),
    ).toThrow('Production migration preflight failed');
  });

  it('requires the reviewed financial row-count baseline', () => {
    const digests = Object.fromEntries(
      Object.entries(RECONCILIATION_FINANCIAL_ROW_COUNTS).map(
        ([key, rowCount]) => [key, { rowCount, digest: 'a'.repeat(32) }],
      ),
    );

    expect(assertReconciliationFinancialBaseline(digests)).toEqual(digests);
    expect(() =>
      assertReconciliationFinancialBaseline({
        ...digests,
        commerce_orders: { rowCount: 8, digest: 'a'.repeat(32) },
      }),
    ).toThrow('Production migration preflight failed');
  });

  it('requires the exact reviewed checksum after application', () => {
    expect(() =>
      assertMigrationAppliedExactlyOnce({
        localMigrationNames: [EXPECTED_RECONCILIATION_MIGRATION],
        migrationRows: [
          {
            migration_name: EXPECTED_RECONCILIATION_MIGRATION,
            checksum: 'b'.repeat(64),
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toThrow('Production migration preflight failed');

    expect(
      assertMigrationAppliedExactlyOnce({
        localMigrationNames: [EXPECTED_RECONCILIATION_MIGRATION],
        migrationRows: [
          {
            migration_name: EXPECTED_RECONCILIATION_MIGRATION,
            checksum:
              '03803E8EEF652CE73BEC38267E274650F45665ECBEF578749E1DAABA663CF53F',
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toMatchObject({ targetApplied: true });
  });

  it('accepts rolled-back attempts when exactly one successful target row remains', () => {
    expect(
      assertMigrationAppliedExactlyOnce({
        localMigrationNames: [EXPECTED_RECONCILIATION_MIGRATION],
        migrationRows: [
          {
            migration_name: EXPECTED_RECONCILIATION_MIGRATION,
            checksum:
              '03803E8EEF652CE73BEC38267E274650F45665ECBEF578749E1DAABA663CF53F',
            finished_at: null,
            rolled_back_at: new Date(),
          },
          {
            migration_name: EXPECTED_RECONCILIATION_MIGRATION,
            checksum:
              '03803E8EEF652CE73BEC38267E274650F45665ECBEF578749E1DAABA663CF53F',
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
      }),
    ).toMatchObject({ targetApplied: true });
  });

  it('classifies failures without exposing connection material', () => {
    const diagnostic = createSafeMigrationPreflightDiagnostic(
      new Error(
        'password authentication failed for migration-secret-role at db.example',
      ),
    );

    expect(diagnostic.failureClass).toBe('MIGRATION_DATABASE_CONNECTION_FAILED');
    expect(JSON.stringify(diagnostic)).not.toContain('migration-secret-role');
  });
});
