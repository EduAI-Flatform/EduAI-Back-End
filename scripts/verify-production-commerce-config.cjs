const dotenv = require('dotenv');

function commerceConfigReadiness(environment) {
  const secret = environment.COMMERCE_IDEMPOTENCY_SECRET;
  return {
    commerceIdempotencySecretConfigured:
      typeof secret === 'string' && secret.trim().length >= 32,
  };
}

function verifyProductionCommerceConfig(environment, logger = console) {
  const readiness = commerceConfigReadiness(environment);
  logger.log(
    `commerceIdempotencySecretConfigured: ${readiness.commerceIdempotencySecretConfigured}`,
  );
  if (!readiness.commerceIdempotencySecretConfigured) {
    throw new Error('Production Commerce configuration verification failed');
  }
}

function run() {
  dotenv.config({ quiet: true });
  verifyProductionCommerceConfig(process.env);
}

if (require.main === module) {
  try {
    run();
  } catch {
    console.error('Production Commerce configuration verification failed');
    process.exitCode = 1;
  }
}

module.exports = {
  commerceConfigReadiness,
  verifyProductionCommerceConfig,
};
