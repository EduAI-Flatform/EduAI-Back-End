/** One policy for wallet admission and recovery. Legacy UAT switches never enable production. */
export interface GdsWalletCapabilityConfig {
  app: { nodeEnv: string; deploymentClass: string; publicAppUrl?: string };
  gdsWallet: {
    sandboxEnabled: boolean;
    checkoutEnabled?: boolean;
    qrPreviewEnabled?: boolean;
    productionTopupEnabled?: boolean;
    productionCheckoutEnabled?: boolean;
  };
  payos?: { environment?: string; clientId?: string; apiKey?: string; checksumKey?: string; webhookUrl?: string };
  commerce?: { idempotencySecret?: string };
}

export function gdsWalletCapabilities(config: GdsWalletCapabilityConfig) {
  const { app, gdsWallet, payos, commerce } = config;
  const production = app.nodeEnv === 'production' && app.deploymentClass === 'production';
  const mixedProduction = !production && (app.nodeEnv === 'production' || app.deploymentClass === 'production');
  const uat = !mixedProduction && !production && gdsWallet.sandboxEnabled === true;
  const credentialsReady = payos?.environment === 'production' &&
    Boolean(payos.clientId?.trim() && payos.apiKey?.trim() && payos.checksumKey?.trim()) &&
    Boolean(commerce?.idempotencySecret && commerce.idempotencySecret.trim().length >= 32);
  const admissionReady = credentialsReady && isHttps(app.publicAppUrl) && isHttps(payos?.webhookUrl);
  // Signed facts must remain durable when admission stops or configuration drifts.
  // The worker still independently queries PayOS and retries failures before any credit.
  const processingEnabled = production || uat && app.deploymentClass === 'uat' && ['test', 'development'].includes(app.nodeEnv);
  return {
    mode: production ? 'production' as const : uat ? 'sandbox' as const : 'disabled' as const,
    readEnabled: production || uat,
    processingEnabled,
    cancellationEnabled: production ? credentialsReady : uat && gdsWallet.qrPreviewEnabled === true && app.deploymentClass === 'uat',
    topupEnabled: production ? admissionReady && gdsWallet.productionTopupEnabled === true : uat && gdsWallet.qrPreviewEnabled === true && app.deploymentClass === 'uat',
    checkoutEnabled: production ? admissionReady && gdsWallet.productionCheckoutEnabled === true : uat && gdsWallet.checkoutEnabled === true && app.deploymentClass === 'uat',
  };
}

function isHttps(value?: string): boolean {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}
