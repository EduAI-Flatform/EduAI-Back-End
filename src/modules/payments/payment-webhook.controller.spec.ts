import { HttpStatus } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../common/security/public.decorator';
import { RATE_LIMIT_KEY } from '../../common/security/rate-limit.decorator';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { VnPayIpnService } from './vnpay-ipn.service';

describe('PaymentWebhookController', () => {
  const webhooks = {
    ingest: jest.fn().mockResolvedValue({ accepted: true, result: 'CONFIRMED' }),
  };
  const vnpayIpn = { handle: jest.fn() };
  const controller = new PaymentWebhookController(
    webhooks as unknown as PaymentWebhookService,
    vnpayIpn as unknown as VnPayIpnService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('accepts bounded JSON and delegates only the parsed envelope', async () => {
    const body = { data: { orderCode: 1 }, signature: 'signed' };
    await expect(
      controller.receive('application/json; charset=utf-8', '45', body),
    ).resolves.toEqual({ accepted: true, result: 'CONFIRMED' });
    expect(webhooks.ingest).toHaveBeenCalledWith(body);
  });

  it('rejects non-JSON and oversized bodies before verification', async () => {
    expect(() => controller.receive('text/plain', '2', {})).toThrow(
      expect.objectContaining({ status: HttpStatus.UNSUPPORTED_MEDIA_TYPE }),
    );
    expect(() =>
      controller.receive('application/json', String(32 * 1024 + 1), {}),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
    expect(webhooks.ingest).not.toHaveBeenCalled();
  });

  it('is explicitly public and separately IP-rate-limited', () => {
    const handler = PaymentWebhookController.prototype.receive;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual({
      identity: 'ip',
      limit: 120,
      name: 'payos-webhook',
      windowSeconds: 900,
    });
  });

  it('exposes a public GET IPN route with a separate IP rate limit', async () => {
    vnpayIpn.handle.mockResolvedValue({ RspCode: '00', Message: 'Confirm Success' });
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await controller.receiveVnPay(
      { query: { vnp_TxnRef: '1001' }, originalUrl: '/api/v1/payments/webhooks/vnpay?vnp_TxnRef=1001' } as never,
      response as never,
    );

    expect(vnpayIpn.handle).toHaveBeenCalledWith({ vnp_TxnRef: '1001' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ RspCode: '00', Message: 'Confirm Success' });
    const handler = PaymentWebhookController.prototype.receiveVnPay;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual({
      identity: 'ip',
      limit: 120,
      name: 'vnpay-ipn',
      windowSeconds: 900,
    });
  });
});
