const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const workflow = readFileSync(join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
const trigger = workflow.split(/\r?\nconcurrency:/)[0];
test('push to main runs CI while automatic deployment requires an opt-in repository variable', () => {
  assert.match(trigger, /^  push:\r?\n    branches:\r?\n      - main/m);
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /^  (pull_request|workflow_run|schedule):/m);
  assert.match(trigger, /authorize_production:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(trigger, /authorize_receipt_schema_migrations:[\s\S]*?type: boolean[\s\S]*?default: false/);
});
test('deployment on main is gated by per-repository auto opt-in or explicit manual consent', () => {
  const deploy = workflow.split(/\r?\n  deploy:/)[1]?.split(/\r?\n  notify:/)[0];
  assert.ok(deploy);
  assert.match(deploy, /if: \$\{\{ github.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /github.event_name == 'push' && vars.EDUAI_AUTO_CD_ENABLED == 'true'/);
  assert.match(deploy, /github.event_name == 'workflow_dispatch' && inputs.authorize_production == true/);
  assert.match(deploy, /environment: production/);
  assert.match(deploy, /if \[ "\$\{\{ inputs.authorize_receipt_schema_migrations \}\}" = "true" \]; then/);
  assert.match(deploy, /npm run prisma:migrate:production -- --authorize-reviewed-receipt-migrations/);
  assert.match(deploy, /npm run prisma:migrate:production\r?\n/);
});

test('skipped deployments do not send external notifications', () => {
  const notify = workflow.split(/\r?\n  notify:/)[1];
  assert.match(notify, /if: \$\{\{ always\(\) && needs.deploy.result != 'skipped' \}\}/);
});
