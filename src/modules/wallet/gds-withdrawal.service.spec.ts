import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { GdsWithdrawalService } from './gds-withdrawal.service';
import { GdsWithdrawalController, GdsWithdrawalAdminController } from './gds-withdrawal.controller';
import { GdsWalletController } from './gds-wallet.controller';
import { GdsCreateWithdrawalDto, GdsWithdrawalPageDto, GdsWithdrawalSettingsDto } from './dto/gds-withdrawal.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
const makeRow = () => ({ id: 'request-id', ownerId: 'owner', walletId: 'wallet', requestKeyHash: 'private-hash', amountMinor: 50000n,
  bankCode: 'MB', accountNumber: '123456789', accountHolder: 'NGUYEN VAN A', status: 'PENDING',
  minimumMinor: 50000n, maximumMinor: 10000000n, createdAt: new Date('2026-01-01'), processingAdminId: null });
function setup() {
  const row = makeRow();
  const tx = {
    $queryRaw: jest.fn(),
    gdsWithdrawal: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue(row), findUniqueOrThrow: jest.fn().mockResolvedValue(row), count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([row]) },
    gdsWithdrawalSettings: { findUniqueOrThrow: jest.fn().mockResolvedValue({ minimumMinor: 50000n, maximumMinor: 10000000n, version: 1, admissionEnabled: true, processingEnabled: true }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    gdsInternalWallet: { findUnique: jest.fn().mockResolvedValue({ id: 'wallet', status: 'ACTIVE', debtMinor: 0n, availableMinor: 100000n }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'ACTIVE', debtMinor: 0n }) },
    gdsWithdrawalEvent: { create: jest.fn() }, auditLog: { create: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const revenue = { transaction: (fn: (arg: typeof tx) => unknown) => fn(tx), syncOwner: jest.fn() };
  return { row, tx, revenue, service: new GdsWithdrawalService(tx as never, config as never, revenue as never) };
}
const input = { amountMinor: '50000', bankCode: 'MB', accountNumber: '123456789', accountHolder: 'NGUYEN VAN A' };
describe('GDS withdrawal API and service boundaries', () => {
  it('allows students/instructors to use their wallet but preserves student-only checkout', () => {
    expect(Reflect.getMetadata('roles', GdsWithdrawalController)).toEqual([RoleName.student, RoleName.instructor]);
    expect(Reflect.getMetadata('roles', GdsWithdrawalAdminController)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata('roles', GdsWalletController.prototype.payOrder)).toEqual([RoleName.student]);
  });
  it('rejects owner/status injection, malformed bank accounts and unbounded pagination', async () => {
    for (const body of [{ ...input, ownerId: 'other' }, { ...input, status: 'PAID' }, { ...input, amountMinor: 50000 }, { ...input, accountNumber: '123' }]) {
      await expect(pipe.transform(body, { type: 'body', metatype: GdsCreateWithdrawalDto })).rejects.toThrow();
    }
    await expect(pipe.transform({ page: '1', pageSize: '101' }, { type: 'query', metatype: GdsWithdrawalPageDto })).rejects.toThrow();
    await expect(pipe.transform({ minimumMinor: '50000', maximumMinor: '10000000', version: 1, admissionEnabled: 'false', processingEnabled: false }, { type: 'body', metatype: GdsWithdrawalSettingsDto })).rejects.toThrow();
  });
  it('creates an immutable settings snapshot and hides the idempotency hash', async () => {
    const { service, tx } = setup();
    const result = await service.create('owner', input, 'unique-request-key-123');
    expect(result.amountMinor).toBe('50000');
    expect(result).not.toHaveProperty('requestKeyHash');
    expect(tx.gdsWithdrawal.create.mock.calls[0][0].data).toMatchObject({ ownerId: 'owner', settingsVersion: 1, minimumMinor: 50000n, maximumMinor: 10000000n });
  });
  it('replays the same request even after admission stops and rejects changed payload', async () => {
    const { service, tx, row } = setup(); tx.gdsWithdrawal.findUnique.mockResolvedValue(row);
    tx.gdsWithdrawalSettings.findUniqueOrThrow.mockRejectedValue(new Error('must not consult admission for a replay'));
    await expect(service.create('owner', input, 'unique-request-key-123')).resolves.toMatchObject({ id: row.id });
    await expect(service.create('owner', { ...input, amountMinor: '60000' }, 'unique-request-key-123')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(tx.gdsWithdrawal.create).not.toHaveBeenCalled();
  });
  it('rejects debt, suspended wallet and insufficient funds before creating a hold', async () => {
    for (const wallet of [{ status: 'ACTIVE', debtMinor: 1n, availableMinor: 100000n }, { status: 'SUSPENDED', debtMinor: 0n, availableMinor: 100000n }, { status: 'ACTIVE', debtMinor: 0n, availableMinor: 49999n }]) {
      const { service, tx } = setup(); tx.gdsInternalWallet.findUnique.mockResolvedValue(wallet);
      await expect(service.create('owner', input, 'unique-request-key-123')).rejects.toThrow();
      expect(tx.gdsWithdrawal.create).not.toHaveBeenCalled();
    }
  });
  it('rejects stale settings versions and inverted limits', async () => {
    const { service, tx } = setup();
    const body = { minimumMinor: '50000', maximumMinor: '10000000', version: 1, admissionEnabled: true, processingEnabled: true };
    tx.gdsWithdrawalSettings.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateSettings('admin', body)).rejects.toThrow('SETTINGS_CHANGED');
    await expect(service.updateSettings('admin', { ...body, maximumMinor: '49999' })).rejects.toThrow('INVALID_LIMITS');
  });
  it('does not expose other owners requests and masks bank accounts in lists', async () => {
    const { service, tx } = setup();
    const list = await service.list({ page: 1, pageSize: 20 }, 'owner');
    expect(list.items[0].accountNumber).toBe('••••6789');
    expect(tx.gdsWithdrawal.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'owner' });
    tx.gdsWithdrawal.findFirst.mockResolvedValue(null);
    await expect(service.detail('request-id', 'other-owner')).rejects.toThrow('NOT_FOUND');
  });
  it('forbids self-processing, wrong transfer operator and missing payment evidence', async () => {
    const { service, tx, row } = setup();
    await expect(service.act('owner', row.id, 'approve', { reason: 'check' })).rejects.toThrow('SELF_PROCESSING');
    tx.gdsWithdrawal.findFirst.mockResolvedValue({ ...row, status: 'PROCESSING', processingAdminId: 'admin' });
    await expect(service.act('other-admin', row.id, 'pay', { reason: 'check' })).rejects.toThrow('ANOTHER_ADMIN');
    await expect(service.act('admin', row.id, 'pay', { reason: 'check' })).rejects.toThrow('PAYMENT_PROOF');
    expect(tx.gdsWithdrawalEvent.create).not.toHaveBeenCalled();
  });
  it('refreshes revenue refunds before accepting a cash-out or transfer claim', async () => {
    const { service, tx, revenue, row } = setup();
    await service.create('owner', input, 'unique-request-key-123');
    expect(revenue.syncOwner).toHaveBeenCalledWith(tx, 'owner');
    tx.gdsWithdrawal.findFirst.mockResolvedValue({ ...row, status: 'APPROVED' });
    revenue.syncOwner.mockClear();
    await service.act('admin', row.id, 'process', { reason: 'Bank account checked' });
    expect(revenue.syncOwner).toHaveBeenCalledWith(tx, 'owner');
  });
});
