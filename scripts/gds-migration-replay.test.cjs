'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('replay isolates all 22 upgrades while retaining the historical 65-migration baseline', () => {
  const workflow = readFileSync(join(root, '.github/workflows/gds-migration-replay.yml'), 'utf8');
  const declaration = workflow.match(/pending=\(([\s\S]*?)\)/)?.[1];
  assert.ok(declaration, 'pending migration declaration required');
  const selectors = declaration.trim().split(/\s+/).map(value => value.replace('prisma/migrations/', ''));
  const names = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const selected = selectors.flatMap(selector => names.filter(name => selector.endsWith('*') ? name.startsWith(selector.slice(0, -1)) : name === selector));
  assert.equal(new Set(selected).size, selected.length, 'upgrade selectors must not overlap');
  assert.equal(selected.length, 22);
  assert.equal(names.length - selected.length, 65);
  assert.deepEqual(selected.filter(name => name.startsWith('20261111')).sort(), [
    '20261111090000_platform_policy_revisions', '20261111120000_add_platform_requests',
    '20261111130000_profile_cover_images', '20261111150000_user_mfa',
    '20261111160000_affiliate', '20261111170000_support_image', '20261111180000_affiliate_wallet',
  ]);
  assert.match(workflow, /test "\$\{#pending\[@\]\}" -eq 22/);
  assert.match(workflow, /test "\$baseline_count" -eq 65/);
});

test('backend CI covers new GDS source, disposable migrations and restricted affiliate grants', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /^\s+run: npm test -- --runInBand\s*$/m, 'all source tests must run, including affiliate credit and spending recovery');
  for (const target of ['platform-policy-migration.spec.ts', 'mfa-migration.spec.ts', 'affiliate-wallet-migration.spec.ts',
    'scripts/affiliate-runtime-privileges.test.cjs', 'scripts/gds-migration-replay.test.cjs']) {
    assert.ok(workflow.includes(target), `CI must cover ${target}`);
  }
});
