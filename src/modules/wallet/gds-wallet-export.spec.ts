import 'reflect-metadata';
import { GdsWalletController } from './gds-wallet.controller';
import { GdsWalletService } from './gds-wallet.service';
import { RATE_LIMIT_KEY } from '../../common/security/rate-limit.decorator';
import { Prisma } from '../../../generated/prisma/client';

const owner = '11111111-1111-4111-8111-111111111111';
const row = { id: 'withdrawal-22222222-2222-4222-8222-222222222222', type: 'WITHDRAWAL', amountMinor: '9007199254740993000',
  occurredAt: new Date('2026-11-18T00:00:00Z'), micros: '1794960000000000', withdrawalId: '22222222-2222-4222-8222-222222222222',
  status: 'PENDING', bankCode: 'BANK', bankShortName: '=HYPERLINK("bad") & Nguyễn\u0001\ufffe\uffff', accountNumber: '••••7890' };
function setup(enabled = true, rows: unknown[] = [row]) {
  const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) };
  const db = { $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  const service = new GdsWalletService(db as never, { app: { deploymentClass: 'uat', nodeEnv: 'test' }, gdsWallet: { sandboxEnabled: enabled } } as never);
  return { tx, db, service };
}
function sheetXml(file: Buffer) {
  let offset = 0;
  while (file.readUInt32LE(offset) === 0x04034b50) {
    const size = file.readUInt32LE(offset + 18), nameLength = file.readUInt16LE(offset + 26), extraLength = file.readUInt16LE(offset + 28);
    const name = file.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    if (name === 'xl/worksheets/sheet1.xml') return file.subarray(start, start + size).toString('utf8');
    offset = start + size;
  }
  throw new Error('Sheet missing');
}

describe('GDS filtered-history Excel export', () => {
  it('exports all bounded canonical owner rows as exact text cells and records the filter snapshot', async () => {
    const { service, tx, db } = setup();
    const result = await service.exportTransactions(owner, 'withdrawals');
    expect(result).toMatchObject({ filename: 'gds-transactions-withdrawals.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      exported: 1, scope: 'filtered_history', complete: true, filter: 'withdrawals' });
    expect(Number.isFinite(Date.parse(result.asOf))).toBe(true);
    const file = Buffer.from(result.dataBase64, 'base64');
    expect(file.readUInt32LE(0)).toBe(0x04034b50);
    expect(file.readUInt32LE(file.length - 22)).toBe(0x06054b50);
    const xml = sheetXml(file);
    expect(xml).toContain('9007199254740993000');
    expect(xml).toContain('=HYPERLINK(&quot;bad&quot;) &amp; Nguyễn');
    expect(xml).toContain('••••7890');
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toMatch(/[\ufffe\uffff]/);
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('t="inlineStr"');
    const query = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values.filter(value => value === owner)).toHaveLength(4);
    expect(query.text).toContain('RIGHT(d.account_number,4)');
    expect(query.text).toContain('NOT (j.kind');
    expect(query.text).toContain("type IN ('WITHDRAWAL'");
    expect(query.values).toContain(2001);
    expect(query.values).toContainEqual(new Date(result.asOf));
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    expect(Object.keys(tx)).toEqual(['$queryRaw']);
  });
  it('refuses unavailable wallets before accessing the database', async () => {
    const { service, db } = setup(false);
    await expect(service.exportTransactions(owner, 'all')).rejects.toThrow('GDS_WALLET_UNAVAILABLE');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('refuses oversized results rather than returning a partial workbook', async () => {
    const { service } = setup(true, Array.from({ length: 2001 }, (_, index) => ({ ...row, id: row.id + index })));
    await expect(service.exportTransactions(owner, 'all')).rejects.toThrow('GDS_HISTORY_EXPORT_LIMIT_EXCEEDED');
  });
  it('uses the authenticated owner, validates the filter, and has a bounded per-user rate', () => {
    const wallet = { exportTransactions: jest.fn() };
    const controller = new GdsWalletController(wallet as never, undefined as never, undefined as never, undefined as never);
    controller.exportTransactions(owner, 'incoming');
    expect(wallet.exportTransactions).toHaveBeenCalledWith(owner, 'incoming');
    expect(() => controller.exportTransactions(owner, 'other-owner')).toThrow('GDS_HISTORY_INVALID_QUERY');
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, GdsWalletController.prototype.exportTransactions)).toEqual({ identity: 'user', limit: 5, name: 'gds-wallet-history-export', windowSeconds: 60 });
    expect(Reflect.getMetadata('path', GdsWalletController.prototype.exportTransactions)).toBe('transactions/export');
    expect(Reflect.getMetadata('roles', GdsWalletController)).toEqual(['student', 'instructor']);
    expect(Reflect.getMetadata('__guards__', GdsWalletController).map((guard: { name: string }) => guard.name)).toEqual(['JwtAuthGuard', 'RolesGuard']);
  });
});
