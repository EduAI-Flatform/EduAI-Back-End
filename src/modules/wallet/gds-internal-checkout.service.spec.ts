import { ForbiddenException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFulfillmentService } from '../payments/commerce-fulfillment.service';
import { GdsInternalCheckoutService } from './gds-internal-checkout.service';

const buyerId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const walletId = '33333333-3333-4333-8333-333333333333';
const settlementId = '44444444-4444-4444-8444-444444444444';

function setup(options: { existingHold?: boolean; confirmed?: boolean; amount?: bigint;
  available?: bigint; paymentCount?: number; sandboxEnabled?: boolean; checkoutEnabled?: boolean;
  production?: boolean } = {}) {
  const amount = options.amount ?? 100_000n;
  let hold = options.existingHold || options.confirmed ? {
    walletId, orderRef: orderId, amountMinor: amount, status: options.confirmed ? 'CAPTURED' : 'RESERVED',
  } : null;
  let availableMinor = options.available ?? amount;
  let heldMinor = hold?.status === 'RESERVED' ? amount : 0n;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: orderId }]),
    commerceOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: orderId, buyerId, status: options.confirmed ? 'confirmed' : 'pending_payment',
        confirmedSettlementId: options.confirmed ? settlementId : null,
        payableAmountMinor: amount, currency: 'VND',
      }),
      update: jest.fn().mockResolvedValue({ id: orderId }),
    },
    commercePaymentAttempt: { count: jest.fn().mockResolvedValue(options.paymentCount ?? 0) },
    commerceSettlement: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({
        id: settlementId, orderId, kind: 'wallet_capture', provider: 'gds',
        providerSettlementReference: `gds:order:${orderId}`, amountMinor: amount,
      }),
      create: jest.fn().mockResolvedValue({ id: settlementId }),
    },
    commerceLifecycleEvent: { create: jest.fn().mockResolvedValue({}) },
    gdsInternalWallet: {
      findUnique: jest.fn().mockResolvedValue({ id: walletId, buyerId, status: 'ACTIVE',
        availableMinor, heldMinor }),
      findUniqueOrThrow: jest.fn().mockImplementation(async () => ({
        id: walletId, buyerId, status: 'ACTIVE', availableMinor, heldMinor,
      })),
    },
    gdsInternalHold: { findUnique: jest.fn().mockImplementation(async () => hold) },
    gdsInternalJournal: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({
        walletId, kind: 'CAPTURE', amountMinor: amount,
      }),
      create: jest.fn().mockImplementation(async ({ data }: { data: { kind: string } }) => {
        if (data.kind === 'RESERVE') {
          availableMinor -= amount;
          heldMinor += amount;
          hold = { walletId, orderRef: orderId, amountMinor: amount, status: 'RESERVED' };
        } else if (data.kind === 'CAPTURE') {
          heldMinor -= amount;
          if (hold) hold.status = 'CAPTURED';
        }
        return {};
      }),
    },
  };
  const prisma = { $transaction: jest.fn().mockImplementation(async (action) => action(tx)) };
  const config = { gdsWallet: { sandboxEnabled: options.sandboxEnabled ?? true,
    checkoutEnabled: options.checkoutEnabled ?? true },
    app: { nodeEnv: options.production ? 'production' : 'test',
      deploymentClass: options.production ? 'production' : 'uat' } };
  const fulfillment = {
    fulfillConfirmedOrder: jest.fn().mockResolvedValue(undefined),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new GdsInternalCheckoutService(
    prisma as unknown as PrismaService, config as unknown as AppConfigService,
    fulfillment as unknown as CommerceFulfillmentService, audit as unknown as AuditService,
  );
  return { tx, prisma, fulfillment, audit, service };
}

describe('PAYW-04C internal-only Commerce capture orchestration', () => {
  it('reserves, captures, confirms, and grants entitlements inside one serializable transaction', async () => {
    const { service, tx, prisma, fulfillment, audit } = setup();
    await expect(service.payOrder(buyerId, orderId)).resolves.toEqual({
      orderId, status: 'CONFIRMED', amountMinor: '100000', currency: 'VND',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual(expect.objectContaining({
      isolationLevel: 'Serializable',
    }));
    expect(tx.gdsInternalJournal.create.mock.calls.map(([arg]) => arg.data.kind))
      .toEqual(['RESERVE', 'CAPTURE']);
    expect(tx.commerceSettlement.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      kind: 'wallet_capture', disposition: 'internal', provider: 'gds',
      amountMinor: 100_000n, currency: 'VND',
    }) });
    expect(tx.commerceOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'confirmed', confirmedSettlementId: settlementId }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'GDS_WALLET_CAPTURED',
    }), tx);
    expect(fulfillment.fulfillConfirmedOrder).toHaveBeenCalledWith(tx, orderId, 'user', buyerId);
    expect(fulfillment.dispatchPending).toHaveBeenCalledTimes(1);
  });

  it('captures an existing RESERVED hold without reserving twice', async () => {
    const { service, tx } = setup({ existingHold: true });
    await service.payOrder(buyerId, orderId);
    expect(tx.gdsInternalJournal.create).toHaveBeenCalledTimes(1);
    expect(tx.gdsInternalJournal.create.mock.calls[0][0].data.kind).toBe('CAPTURE');
  });

  it('returns verified replay without capturing or granting twice', async () => {
    const { service, tx, fulfillment } = setup({ confirmed: true });
    await expect(service.payOrder(buyerId, orderId)).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
  });

  it('refuses to pay an order that has a PayOS or other provider attempt', async () => {
    const { service, tx, fulfillment } = setup({ paymentCount: 1 });
    await expect(service.payOrder(buyerId, orderId))
      .rejects.toThrow('GDS_CAPTURE_INSTRUMENT_OR_REPLAY_CONFLICT');
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
  });

  it('rejects insufficient GDS before adding any financial posting', async () => {
    const { service, tx } = setup({ available: 99_999n });
    await expect(service.payOrder(buyerId, orderId))
      .rejects.toThrow('GDS_CAPTURE_INSUFFICIENT_FUNDS');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('must not report success or notify if the entitlement write fails', async () => {
    const { service, fulfillment } = setup();
    fulfillment.fulfillConfirmedOrder.mockRejectedValueOnce(new Error('grant failed'));
    await expect(service.payOrder(buyerId, orderId)).rejects.toThrow('grant failed');
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('returns confirmed when post-commit notification dispatch is temporarily unavailable', async () => {
    const { service, fulfillment } = setup();
    fulfillment.dispatchPending.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(service.payOrder(buyerId, orderId)).resolves.toMatchObject({ status: 'CONFIRMED' });
  });

  it('never allows transaction execution on production or when sandbox flag is off', async () => {
    for (const config of [{ production: true }, { sandboxEnabled: false }, { checkoutEnabled: false }]) {
      const { service, prisma } = setup(config);
      await expect(service.payOrder(buyerId, orderId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });
});
