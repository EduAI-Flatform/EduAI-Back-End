import { DisabledPaymentProvider } from './disabled-payment.provider';
import {
  DefaultPaymentProviderRegistry,
  PaymentProviderRegistryOptions,
} from './payment-provider.registry';

function provider() {
  return {
    createPaymentRequest: jest.fn(),
    checkoutUrlFor: jest.fn(),
    retrievePaymentRequest: jest.fn(),
    cancelPaymentRequest: jest.fn(),
    verifyWebhook: jest.fn(),
    reconcilePaymentRequest: jest.fn(),
  } as never;
}

function registry(
  overrides: Partial<PaymentProviderRegistryOptions> = {},
): DefaultPaymentProviderRegistry {
  const payos = provider();
  const vnpay = provider();
  return new DefaultPaymentProviderRegistry({
    defaultProvider: 'payos',
    providers: { payos, vnpay },
    enabled: { payos: true, vnpay: false },
    disabled: new DisabledPaymentProvider(),
    ...overrides,
  });
}

describe('DefaultPaymentProviderRegistry', () => {
  it('resolves PayOS and VNPay independently', () => {
    const payos = provider();
    const vnpay = provider();
    const value = registry({
      providers: { payos, vnpay },
      enabled: { payos: true, vnpay: true },
    });

    expect(value.get('payos')).toBe(payos);
    expect(value.get('vnpay')).toBe(vnpay);
  });

  it('fails closed for disabled and unknown providers', () => {
    const value = registry();

    expect(value.get('vnpay')).toBeInstanceOf(DisabledPaymentProvider);
    expect(value.get('unknown')).toBeInstanceOf(DisabledPaymentProvider);
    expect(() => value.requireEnabled('vnpay')).toThrow('Payment provider operation failed');
    expect(() => value.requireEnabled('unknown')).toThrow('Payment provider operation failed');
  });

  it('keeps the configured default explicit and does not switch existing attempts', () => {
    const vnpay = provider();
    const value = registry({
      defaultProvider: 'vnpay',
      providers: { payos: provider(), vnpay },
      enabled: { payos: true, vnpay: true },
    });

    expect(value.getDefaultProvider()).toBe('vnpay');
    expect(value.get('payos')).not.toBe(vnpay);
    expect(value.get('vnpay')).toBe(vnpay);
  });

  it('uses an existing attempt provider as the authoritative resolution key', () => {
    const payos = provider();
    const vnpay = provider();
    const value = registry({
      providers: { payos, vnpay },
      enabled: { payos: true, vnpay: true },
    });

    expect(value.requireEnabled('payos')).toBe(payos);
    expect(value.requireEnabled('vnpay')).toBe(vnpay);
    expect(value.requireEnabled('payos')).not.toBe(vnpay);
  });
});
