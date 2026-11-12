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
  assert.match(deploy, /migration_args\+=\(--authorize-reviewed-receipt-migrations\)/);
  assert.match(deploy, /migration_args=\(\)/);
  assert.match(deploy, /npm run prisma:migrate:production -- "\$\{migration_args\[@\]\}"/);
});

test('skipped deployments do not send external notifications', () => {
  const notify = workflow.split(/\r?\n  notify:/)[1];
  assert.match(notify, /if: \$\{\{ always\(\) && needs.deploy.result != 'skipped' \}\}/);
});


test('wallet production admission changes require explicit enum inputs and preserve on source pushes', () => {
  assert.match(trigger, /gds_wallet_topup:[\s\S]*?default: preserve/);
  assert.match(trigger, /gds_wallet_checkout:[\s\S]*?default: preserve/);
  assert.match(workflow, /inputs.gds_wallet_topup \|\| 'preserve'/);
  assert.match(workflow, /inputs.gds_wallet_checkout \|\| 'preserve'/);
  assert.match(workflow, /preserve\|enable\|disable/);
  assert.match(workflow, /configure-gds-production-wallet.cjs --topup/);
});


test('wallet configuration is repaired before npm ci triggers Prisma postinstall',()=>{
 const deploy=workflow.slice(workflow.indexOf('      - name: Deploy backend'));
 assert.ok(deploy.indexOf('node scripts/configure-gds-production-wallet.cjs')<deploy.indexOf('          npm ci'));
 assert.ok(deploy.indexOf('          npm ci')>=0);
});

test('withdrawal activation is explicit and follows migration, restart and readiness', () => {
  assert.match(trigger, /gds_withdrawal_action:[\s\S]*?default: preserve/);
  assert.match(trigger, /gds_withdrawal_minimum:[\s\S]*?default: '10000'/);
  assert.match(workflow, /inputs.gds_withdrawal_action \|\| 'preserve'/);
  const activation = workflow.indexOf('deployment_stage="withdrawal-configuration"');
  assert.ok(activation > workflow.indexOf('npm run prisma:migrate:production'));
  assert.ok(activation > workflow.indexOf('npm run process:restart:production'));
  assert.ok(activation > workflow.indexOf('Backend readiness check timed out'));
  assert.match(workflow, /configure-gds-withdrawals.cjs[\s\S]*?--expected-sha "\$EXPECTED_DEPLOY_SHA" --authorize-production-withdrawals/);
});

test('GDS platform schema release requires explicit consent and a private backup before migration', () => {
  assert.match(trigger, /authorize_gds_platform_schema_migrations:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /inputs.authorize_gds_platform_schema_migrations/);
  const backup = workflow.indexOf('node scripts/backup-gds-platform.cjs');
  assert.ok(backup > 0);
  assert.ok(backup < workflow.indexOf('npm run prisma:migrate:production'));
  assert.match(workflow, /migration_args\+=\(--authorize-reviewed-gds-platform-migrations\)/);
  assert.match(workflow, /npm run prisma:migrate:production -- "\$\{migration_args\[@\]\}"/);
});

test('MFA key initialization is limited to the approved release and precedes process restart', () => {
  const initialization = workflow.indexOf('node scripts/initialize-gds-mfa-key.cjs');
  assert.ok(initialization > workflow.indexOf('npm run prisma:migrate:production'));
  assert.ok(initialization < workflow.indexOf('npm run process:restart:production'));
  assert.match(workflow.slice(initialization - 200, initialization), /inputs.authorize_gds_platform_schema_migrations/);
});
