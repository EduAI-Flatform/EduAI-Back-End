const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const {
  verifyProductionCommerceConfig,
} = require('./verify-production-commerce-config.cjs');

function runPm2(spawn, args, environment) {
  const result = spawn('pm2', args, {
    env: environment,
    shell: false,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('Production process restart failed');
  }
}

function restartProductionProcess(
  environment,
  spawn = spawnSync,
  logger = console,
) {
  logger.log('pm2EnvironmentLoadedFromFile: true');
  runPm2(spawn, ['restart', 'eduai-backend', '--update-env'], environment);
  runPm2(spawn, ['save'], environment);
}

function run() {
  const loaded = dotenv.config({ quiet: true, override: true });
  if (loaded.error) {
    throw new Error('Production process environment load failed');
  }
  verifyProductionCommerceConfig(process.env);
  restartProductionProcess(process.env);
}

if (require.main === module) {
  try {
    run();
  } catch {
    console.error('Production process restart failed');
    process.exitCode = 1;
  }
}

module.exports = { restartProductionProcess };
