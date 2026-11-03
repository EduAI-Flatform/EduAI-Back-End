const dotenv = require('dotenv');
const { createHash } = require('node:crypto');

function databaseIdentityFingerprint(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) return null;
    const identity = `${url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
    return createHash('sha256').update(identity).digest('hex');
  } catch { return null; }
}

function walletProductionReadiness(environment) {
  const flags = ['GDS_WALLET_PRODUCTION_TOPUP_ENABLED', 'GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED'];
  const validFlags = flags.every(key => environment[key] === undefined || ['true', 'false'].includes(environment[key]));
  const requested = flags.some(key => environment[key] === 'true');
  const https = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname); } catch { return false; } };
  const fingerprint = databaseIdentityFingerprint(environment.DATABASE_URL);
  const uatFingerprint = environment.GDS_WALLET_UAT_DATABASE_FINGERPRINT;
  const classified = environment.NODE_ENV === 'production' && environment.DEPLOYMENT_CLASS === 'production';
  const channel = environment.PAYOS_ENVIRONMENT === 'production' && ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY', 'COMMERCE_IDEMPOTENCY_SECRET'].every(key => typeof environment[key] === 'string' && environment[key].trim().length >= (key === 'COMMERCE_IDEMPOTENCY_SECRET' ? 32 : 1));
  const urls = https(environment.PUBLIC_APP_URL) && https(environment.PAYOS_WEBHOOK_URL) && new URL(environment.PAYOS_WEBHOOK_URL).pathname === '/api/v1/payments/webhooks/payos';
  const isolated = Boolean(fingerprint && /^[a-f0-9]{64}$/.test(uatFingerprint || '') && fingerprint !== uatFingerprint);
  return { walletProductionRequested: requested, walletProductionFlagsValid: validFlags, walletProductionRuntimeValid: classified, walletProductionChannelConfigured: channel, walletProductionUrlsValid: urls, walletProductionDatabaseIsolated: isolated, walletProductionReady: validFlags && (!requested || (classified && channel && urls && isolated)) };
}

function verifyWalletProductionConfig(environment, logger = console) {
  const readiness = walletProductionReadiness(environment);
  for (const [key, value] of Object.entries(readiness)) logger.log(`${key}: ${value}`);
  if (!readiness.walletProductionReady) throw new Error('Production wallet configuration verification failed');
  return readiness;
}


function commerceConfigReadiness(environment) {
  const secret = environment.COMMERCE_IDEMPOTENCY_SECRET;
  const providerEnvironment =
    typeof environment.PAYOS_ENVIRONMENT === 'string' &&
    environment.PAYOS_ENVIRONMENT.trim().length > 0
      ? environment.PAYOS_ENVIRONMENT.trim()
      : 'disabled';
  return {
    commerceIdempotencySecretConfigured:
      typeof secret === 'string' && secret.trim().length >= 32,
    paymentProviderActivated: providerEnvironment === 'production',
    paymentProviderDisabled: providerEnvironment === 'disabled',
  };
}

function verifyProductionCommerceConfig(environment, logger = console) {
  const readiness = commerceConfigReadiness(environment);
  verifyWalletProductionConfig(environment, logger);
  logger.log(
    `commerceIdempotencySecretConfigured: ${readiness.commerceIdempotencySecretConfigured}`,
  );
  logger.log(`paymentProviderActivated: ${readiness.paymentProviderActivated}`);
  logger.log(`paymentProviderDisabled: ${readiness.paymentProviderDisabled}`);
  if (
    !readiness.commerceIdempotencySecretConfigured ||
    (!readiness.paymentProviderActivated && !readiness.paymentProviderDisabled)
  ) {
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
  databaseIdentityFingerprint,
  walletProductionReadiness,
  verifyWalletProductionConfig,
  commerceConfigReadiness,
  verifyProductionCommerceConfig,
};
