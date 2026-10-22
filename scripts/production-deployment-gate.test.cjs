const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const workflow = readFileSync(join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
const trigger = workflow.split(/\r?\nconcurrency:/)[0];
test('production deployment accepts only an explicit manual invocation', () => {
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /^  (push|pull_request|workflow_run|schedule):/m);
  assert.match(trigger, /authorize_production:[\s\S]*?type: boolean[\s\S]*?default: false/);
});
test('production job requires main and explicit owner approval', () => {
  const deploy = workflow.split(/\r?\n  deploy:/)[1]?.split(/\r?\n  notify:/)[0];
  assert.ok(deploy);
  assert.match(deploy, /if: \$\{\{ github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main' && inputs.authorize_production == true \}\}/);
  assert.match(deploy, /environment: production/);
});
test('skipped deployments do not send external notifications', () => {
  const notify = workflow.split(/\r?\n  notify:/)[1];
  assert.match(notify, /if: \$\{\{ always\(\) && needs.deploy.result != 'skipped' \}\}/);
});
