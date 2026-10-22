import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BankTransferAdminController, BankTransferController } from './bank-transfer.controller';
import { BankApprovalDto, BankStatementDto, BankSupportDto, CreatePaymentMethodDto } from './dto/bank-transfer.dto';
import { PaymentWebhookService } from './payment-webhook.service';

describe('bank payment boundary contracts', () => {
  it('admin and learner surfaces retain explicit role boundaries', () => {
    expect(Reflect.getMetadata('roles', BankTransferAdminController)).toEqual(['platform_admin']);
    expect(Reflect.getMetadata('roles', BankTransferController)).toEqual(['student']);
  });
  it('only advertises bank method after sandbox gate', () => {
    const bank: any = { enabled: () => false };
    const registry: any = { isEnabled: (name: string) => name === 'vnpay' };
    expect(new BankTransferController(bank, registry).methods().methods).toEqual(['vnpay']);
    bank.enabled = () => true;
    expect(new BankTransferController(bank, registry).methods().methods).toEqual(['vnpay', 'bank_transfer']);
  });
  it('rejects screenshot-style evidence and generic empty approval', async () => {
    expect((await validate(plainToInstance(BankStatementDto, { screenshot: 'proof.png' }))).length).toBeGreaterThan(0);
    expect((await validate(new BankApprovalDto())).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(BankSupportDto, { reason: 'x' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(CreatePaymentMethodDto, { provider: 'untrusted' }))).length).toBeGreaterThan(0);
    expect((await validate(new CreatePaymentMethodDto()))).toEqual([]);
  });
  it('rejects bank confirmation through the gateway verified webhook entry point before persistence', async () => {
    const webhook = new PaymentWebhookService({} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(webhook.ingestVerified({ provider: 'bank_transfer', providerCode: '00' } as any)).rejects.toThrow('Webhook does not describe an eligible settlement');
  });
});
