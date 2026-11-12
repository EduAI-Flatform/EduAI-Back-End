'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('replay isolates all 23 upgrades while retaining the historical 65-migration baseline', () => {
  const workflow = readFileSync(join(root, '.github/workflows/gds-migration-replay.yml'), 'utf8');
  const declaration = workflow.match(/pending=\(([\s\S]*?)\)/)?.[1];
  assert.ok(declaration, 'pending migration declaration required');
  const selectors = declaration.trim().split(/\s+/).map(value => value.replace('prisma/migrations/', ''));
  const names = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const selected = selectors.flatMap(selector => names.filter(name => selector.endsWith('*') ? name.startsWith(selector.slice(0, -1)) : name === selector));
  assert.equal(new Set(selected).size, selected.length, 'upgrade selectors must not overlap');
  assert.equal(selected.length, 23);
  assert.equal(names.length - selected.length, 65);
  assert.deepEqual(selected.filter(name => name.startsWith('20261111')).sort(), [
    '20261111090000_platform_policy_revisions', '20261111120000_add_platform_requests',
    '20261111130000_profile_cover_images', '20261111150000_user_mfa',
    '20261111160000_affiliate', '20261111170000_support_image', '20261111180000_affiliate_wallet',
  ]);
  assert.ok(selected.includes('20261112180000_activity_points'));
  assert.match(workflow, /test "\$\{#pending\[@\]\}" -eq 23/);
  assert.match(workflow, /test "\$baseline_count" -eq 65/);
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
