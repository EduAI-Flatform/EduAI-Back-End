const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const {
  verifyProductionCommerceConfig,
} = require('./verify-production-commerce-config.cjs');

const { restartWithAuthSessionFloor } = require('./auth-session-cutover.cjs');

async function restartProductionProcess(
  environment,
  spawn = spawnSync,
  logger = console,
  options = {},
) {
  logger.log('pm2EnvironmentLoadedFromFile: true');
  const result = await restartWithAuthSessionFloor(environment, { ...options, spawn });
  logger.log(JSON.stringify({ authSessionCutover: 'PASS', ...result }));
  return result;
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(argument => argument !== '--authorize-auth-session-v2-cutover')) throw new Error('AUTH_SESSION_RESTART_ARGUMENT_INVALID');
  const loaded = dotenv.config({ quiet: true, override: true });
  if (loaded.error) {
    throw new Error('Production process environment load failed');
  }
  verifyProductionCommerceConfig(process.env);
  await restartProductionProcess(process.env, spawnSync, console, { authorizeCutover: args.includes('--authorize-auth-session-v2-cutover') });
}

if (require.main === module) {
  run().catch(error => {
    const code = typeof error.message === 'string' && /^AUTH_SESSION_[A-Z_]+$/.test(error.message) ? error.message : 'PRODUCTION_PROCESS_RESTART_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}

module.exports = { restartProductionProcess };
