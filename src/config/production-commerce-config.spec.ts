import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  commerceConfigReadiness,
  verifyProductionCommerceConfig,
} = require('../../scripts/verify-production-commerce-config.cjs') as {
  commerceConfigReadiness: (environment: NodeJS.ProcessEnv) => {
    commerceIdempotencySecretConfigured: boolean;
  };
  verifyProductionCommerceConfig: (
    environment: NodeJS.ProcessEnv,
    logger?: Pick<Console, 'log'>,
  ) => void;
};
const {
  restartProductionProcess,
} = require('../../scripts/restart-production-process.cjs') as {
  restartProductionProcess: (
    environment: NodeJS.ProcessEnv,
    spawn?: jest.Mock,
    logger?: Pick<Console, 'log'>,
  ) => void;
};

describe('production Commerce configuration verifier', () => {
  it('requires a secret of at least 32 characters without returning its value', () => {
    expect(commerceConfigReadiness({})).toEqual({
      commerceIdempotencySecretConfigured: false,
    });
    expect(
      commerceConfigReadiness({ COMMERCE_IDEMPOTENCY_SECRET: 'short' }),
    ).toEqual({ commerceIdempotencySecretConfigured: false });
    expect(
      commerceConfigReadiness({
        COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
      }),
    ).toEqual({ commerceIdempotencySecretConfigured: true });
  });

  it('logs only sanitized readiness and fails closed', () => {
    const logger = { log: jest.fn() };

    expect(() => verifyProductionCommerceConfig({}, logger)).toThrow(
      'Production Commerce configuration verification failed',
    );
    expect(logger.log).toHaveBeenCalledWith(
      'commerceIdempotencySecretConfigured: false',
    );
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('short'));
  });

  it('is wired into production deployment before PM2 restart', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const preflight = workflow.indexOf('npm run config:verify:production-commerce');
    const restart = workflow.indexOf('npm run process:restart:production');

    expect(preflight).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(preflight);
  });

  it('hands the loaded environment to the exact approved PM2 commands', () => {
    const spawn = jest.fn().mockReturnValue({ status: 0 });
    const logger = { log: jest.fn() };
    const environment = {
      COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
      NODE_ENV: 'production',
    };

    restartProductionProcess(environment, spawn, logger);

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'pm2',
      ['restart', 'eduai-backend', '--update-env'],
      expect.objectContaining({ env: environment, shell: false, stdio: 'inherit' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'pm2',
      ['save'],
      expect.objectContaining({ env: environment, shell: false, stdio: 'inherit' }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      'pm2EnvironmentLoadedFromFile: true',
    );
  });
});
