import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  commerceConfigReadiness,
  verifyProductionCommerceConfig,
} = require('../../scripts/verify-production-commerce-config.cjs') as {
  commerceConfigReadiness: (environment: NodeJS.ProcessEnv) => {
    commerceIdempotencySecretConfigured: boolean;
    paymentProviderActivated: boolean;
    paymentProviderDisabled: boolean;
  };
  verifyProductionCommerceConfig: (
    environment: NodeJS.ProcessEnv,
    logger?: Pick<Console, 'log'>,
  ) => void;
};
jest.mock('../../scripts/auth-session-cutover.cjs', () => ({ restartWithAuthSessionFloor: jest.fn().mockResolvedValue({ tokenVersion: 2, oldProcessDrained: true }) }));
const { restartWithAuthSessionFloor } = require('../../scripts/auth-session-cutover.cjs');
const {
  restartProductionProcess,
} = require('../../scripts/restart-production-process.cjs') as {
  restartProductionProcess: (
    environment: NodeJS.ProcessEnv,
    spawn?: jest.Mock,
    logger?: Pick<Console, 'log'>,
    options?: { authorizeCutover: boolean },
  ) => Promise<unknown>;
};

describe('production Commerce configuration verifier', () => {
  it('requires a secret of at least 32 characters without returning its value', () => {
    expect(commerceConfigReadiness({})).toEqual({
      commerceIdempotencySecretConfigured: false,
      paymentProviderActivated: false,
      paymentProviderDisabled: true,
    });
    expect(
      commerceConfigReadiness({ COMMERCE_IDEMPOTENCY_SECRET: 'short' }),
    ).toEqual({
      commerceIdempotencySecretConfigured: false,
      paymentProviderActivated: false,
      paymentProviderDisabled: true,
    });
    expect(
      commerceConfigReadiness({
        COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
      }),
    ).toEqual({
      commerceIdempotencySecretConfigured: true,
      paymentProviderActivated: false,
      paymentProviderDisabled: true,
    });
  });

  it('logs only sanitized readiness and fails closed', () => {
    const logger = { log: jest.fn() };

    expect(() => verifyProductionCommerceConfig({}, logger)).toThrow(
      'Production Commerce configuration verification failed',
    );
    expect(logger.log).toHaveBeenCalledWith(
      'commerceIdempotencySecretConfigured: false',
    );
    expect(logger.log).toHaveBeenCalledWith('paymentProviderActivated: false');
    expect(logger.log).toHaveBeenCalledWith('paymentProviderDisabled: true');
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('short'));
  });

  it('reports provider mode as sanitized booleans and rejects unknown modes', () => {
    expect(
      commerceConfigReadiness({
        COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
        PAYOS_ENVIRONMENT: 'production',
      }),
    ).toEqual({
      commerceIdempotencySecretConfigured: true,
      paymentProviderActivated: true,
      paymentProviderDisabled: false,
    });

    expect(() =>
      verifyProductionCommerceConfig(
        {
          COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
          PAYOS_ENVIRONMENT: 'unexpected',
        },
        { log: jest.fn() },
      ),
    ).toThrow('Production Commerce configuration verification failed');
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

  it('hands the loaded environment through the mandatory auth cutover verifier', async () => {
    const spawn = jest.fn().mockReturnValue({ status: 0 });
    const logger = { log: jest.fn() };
    const environment = {
      COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
      NODE_ENV: 'production',
    };

    await restartProductionProcess(environment, spawn, logger, { authorizeCutover: true });
    expect(restartWithAuthSessionFloor).toHaveBeenCalledWith(environment, { authorizeCutover: true, spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'pm2EnvironmentLoadedFromFile: true',
    );
  });
});
