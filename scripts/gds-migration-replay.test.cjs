'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('replay isolates all 25 upgrades while retaining the historical 65-migration baseline', () => {
  const workflow = readFileSync(join(root, '.github/workflows/gds-migration-replay.yml'), 'utf8');
  const declaration = workflow.match(/pending=\(([\s\S]*?)\)/)?.[1];
  assert.ok(declaration, 'pending migration declaration required');
  const selectors = declaration.trim().split(/\s+/).map(value => value.replace('prisma/migrations/', ''));
  const names = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const selected = selectors.flatMap(selector => names.filter(name => selector.endsWith('*') ? name.startsWith(selector.slice(0, -1)) : name === selector));
  assert.equal(new Set(selected).size, selected.length, 'upgrade selectors must not overlap');
  assert.equal(selected.length, 25);
  assert.equal(names.length - selected.length, 65);
  assert.deepEqual(selected.filter(name => name.startsWith('20261111')).sort(), [
    '20261111090000_platform_policy_revisions', '20261111120000_add_platform_requests',
    '20261111130000_profile_cover_images', '20261111150000_user_mfa',
    '20261111160000_affiliate', '20261111170000_support_image', '20261111180000_affiliate_wallet',
  ]);
  assert.ok(selected.includes('20261112180000_activity_points'));
  assert.ok(selected.includes('20261113100000_card_service_limit_provenance'));
  assert.ok(selected.includes('20261116090000_auth_session_v2_foundation'));
  assert.match(workflow, /test "\$\{#pending\[@\]\}" -eq 25/);
  assert.match(workflow, /test "\$baseline_count" -eq 65/);
});

test('CI covers card provenance and a real PostgreSQL cross-tier last-unit race', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const replay = readFileSync(join(root, '.github/workflows/gds-migration-replay.yml'), 'utf8');
  assert.ok(workflow.includes('card-service-limit-migration.spec.ts'));
  assert.ok(replay.includes('node scripts/test-card-quota-postgres.cjs'));
});

test('CI exercises point schema, bounded privileges and real PostgreSQL point races', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const replay = readFileSync(join(root, '.github/workflows/gds-migration-replay.yml'), 'utf8');
  assert.ok(workflow.includes('activity-points-migration.spec.ts'));
  assert.ok(workflow.includes('scripts/point-runtime-privileges.test.cjs'));
  assert.ok(replay.includes('node scripts/test-activity-points-prisma.cjs'));
});

test('backend CI covers new GDS source, disposable migrations and restricted affiliate grants', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /^\s+run: npm test -- --runInBand\s*$/m, 'all source tests must run, including affiliate credit and spending recovery');
  for (const target of ['platform-policy-migration.spec.ts', 'mfa-migration.spec.ts', 'affiliate-wallet-migration.spec.ts',
    'scripts/affiliate-runtime-privileges.test.cjs', 'scripts/gds-migration-replay.test.cjs']) {
    assert.ok(workflow.includes(target), `CI must cover ${target}`);
  }
});

test('affiliate dashboard replay refuses non-CI and non-disposable database targets before loading runtime', () => {
  const { spawnSync } = require('node:child_process');
  const target = join(root, 'scripts/test-affiliate-dashboard-prisma.cjs');
  const local = 'postgresql://eduai_migration_replay:synthetic@127.0.0.1:5432/eduai_migration_replay';
  for (const [ci, url] of [
    ['false', local], ['', local], ['true', ''],
    ['true', local.replace('127.0.0.1', 'external.example.test')],
    ['true', local.replace('/eduai_migration_replay', '/production')],
    ['true', local.replace('eduai_migration_replay:', 'production:')],
    ['true', local.replace('postgresql:', 'https:')],
    ['true', local + '?host=external.example.test'],
    ['true', local + '#unexpected'],
  ]) {
    const result = spawnSync(process.execPath, [target], { encoding: 'utf8', env: { ...process.env, CI: ci, DATABASE_URL: url } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AFFILIATE_DASHBOARD_PRISMA=FAIL AssertionError/);
    assert.equal(result.stdout, '');
  }
});
