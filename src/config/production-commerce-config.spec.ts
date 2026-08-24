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
    const preflight = workflow.indexOf(
      'npm run config:verify:production-commerce',
    );
    const restart = workflow.indexOf('pm2 restart eduai-backend --update-env');

    expect(preflight).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(preflight);
  });
});
