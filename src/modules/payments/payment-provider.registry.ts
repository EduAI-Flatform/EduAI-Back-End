import {
  PaymentProvider,
  PaymentProviderError,
  PaymentProviderName,
  PAYMENT_PROVIDER_REGISTRY,
} from './payment-provider';

export { PAYMENT_PROVIDER_REGISTRY };

export interface PaymentProviderRegistryOptions {
  defaultProvider: PaymentProviderName;
  providers: Record<PaymentProviderName, PaymentProvider>;
  enabled: Record<PaymentProviderName, boolean>;
  disabled: PaymentProvider;
}

export interface PaymentProviderRegistry {
  get(provider: string): PaymentProvider;
  requireEnabled(provider: string): PaymentProvider;
  isEnabled(provider: string): boolean;
  getDefaultProvider(): PaymentProviderName;
}

export class DefaultPaymentProviderRegistry implements PaymentProviderRegistry {
  private readonly defaultProvider: PaymentProviderName;
  private readonly providers: Record<PaymentProviderName, PaymentProvider>;
  private readonly enabled: Record<PaymentProviderName, boolean>;
  private readonly disabled: PaymentProvider;

  constructor(options: PaymentProviderRegistryOptions) {
    this.defaultProvider = options.defaultProvider;
    this.providers = options.providers;
    this.enabled = options.enabled;
    this.disabled = options.disabled;
  }

  get(provider: string): PaymentProvider {
    if (!this.isEnabled(provider)) return this.disabled;
    return this.providers[provider as PaymentProviderName] ?? this.disabled;
  }

  requireEnabled(provider: string): PaymentProvider {
    if (!this.isEnabled(provider)) {
      throw new PaymentProviderError('disabled', false);
    }
    const resolved = this.providers[provider as PaymentProviderName];
    if (!resolved) throw new PaymentProviderError('disabled', false);
    return resolved;
  }

  isEnabled(provider: string): boolean {
    return (
      (provider === 'payos' || provider === 'vnpay') &&
      this.enabled[provider] &&
      Boolean(this.providers[provider])
    );
  }

  getDefaultProvider(): PaymentProviderName {
    return this.defaultProvider;
  }
}
