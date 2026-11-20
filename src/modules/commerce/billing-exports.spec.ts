import { CommerceOrderHistoryService } from './commerce-order-history.service';
import { PlatformRequestsService } from '../platform-requests/platform-requests.service';
import { parseHistoryQuery, historyQuery, encodeHistoryCursor } from '../wallet/gds-wallet-history';

const owner = '11111111-1111-4111-8111-111111111111';
const query = { page: 4, pageSize: 20, startDate: '2026-11-01', endDate: '2026-11-20' };
function database(rows: unknown[]) {
  const model = { findMany: jest.fn().mockResolvedValue(rows) };
  const tx = { commerceOrder: model, platformSupportTicket: model };
  return { ...tx, $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(tx)), model };
}
describe('Owner billing Excel exports', () => {
  it('exports all filtered orders without pagination, preserving exact values and text cells', async () => {
    const db = database([{ orderNumber: 'ORDER-01', status: 'confirmed', currency: 'VND', createdAt: new Date('2026-11-18T00:00:00Z'), confirmedAt: null,
      subtotalAmountMinor: 9007199254740993000n, discountAmountMinor: 0n, payableAmountMinor: 9007199254740993000n,
      lines: [{ displayTitle: '=HYPERLINK("bad") Tiếng Việt', quantity: 1 }] }]);
    const file = await new CommerceOrderHistoryService(db as never).exportOrders(owner, { ...query, status: 'confirmed' });
    expect(file).toMatchObject({ exported: 1, complete: true, scope: 'filtered_history' });
    const xml = Buffer.from(file.dataBase64, 'base64').toString('utf8');
    expect(xml).toContain('9007199254740993000'); expect(xml).toContain('Tiếng Việt'); expect(xml).not.toContain('<f>');
    expect(db.model.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ buyerId: owner, archivedAt: null, status: 'confirmed' }), take: 2001 }));
    expect(db.model.findMany.mock.calls[0][0]).not.toHaveProperty('skip');
  });
  it('rejects oversized order exports rather than silently truncating', async () => {
    const db = database(Array(2001).fill({}));
    await expect(new CommerceOrderHistoryService(db as never).exportOrders(owner, query)).rejects.toThrow('COMMERCE_ORDER_EXPORT_LIMIT_EXCEEDED');
  });
  it('exports invoice details from structured fields, scoped to the current owner and invoice type', async () => {
    const db = database([{ id: 'invoice-1', order: { orderNumber: 'ORDER-01' }, invoiceDetails: { recipientName: 'Công ty A', taxCode: '0012345', billingAddress: 'Hà Nội', invoiceEmail: 'a@example.com' },
      status: 'open', content: 'DO NOT PARSE THIS', createdAt: new Date(), updatedAt: new Date() }]);
    const file = await new PlatformRequestsService(db as never, {} as never).exportInvoices(owner, { ...query, status: 'open' });
    expect(file.exported).toBe(1);
    const xml = Buffer.from(file.dataBase64, 'base64').toString('utf8');
    expect(xml).toContain('0012345'); expect(xml).toContain('Công ty A'); expect(xml).not.toContain('DO NOT PARSE THIS');
    expect(db.model.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: owner, requestType: 'invoice', status: 'open' }), take: 2001 }));
  });
  it('rejects oversized invoice exports and invalid date ranges', async () => {
    const service = new PlatformRequestsService(database(Array(2001).fill({})) as never, {} as never);
    await expect(service.exportInvoices(owner, query)).rejects.toThrow('INVOICE_EXPORT_LIMIT_EXCEEDED');
    await expect(service.exportInvoices(owner, { ...query, startDate: '2026-11-21' })).rejects.toThrow();
  });
});
describe('Wallet history date filters', () => {
  it('uses the same inclusive Vietnam calendar-day range in canonical history', () => {
    const parsed = parseHistoryQuery(owner, 'all', '20', undefined, '2026-11-01', '2026-11-20');
    const sql = historyQuery(owner, parsed);
    expect(sql.values).toContainEqual(new Date('2026-10-31T17:00:00Z'));
    expect(sql.values).toContainEqual(new Date('2026-11-20T17:00:00Z'));
  });
  it('rejects nonexistent dates, reversed ranges and cursors from another range', () => {
    expect(() => parseHistoryQuery(owner, 'all', '20', undefined, '2026-02-30')).toThrow();
    expect(() => parseHistoryQuery(owner, 'all', '20', undefined, '2026-11-21', '2026-11-20')).toThrow();
    const cursor = encodeHistoryCursor(owner, 'all', '1794960000000000', 'journal-22222222-2222-4222-8222-222222222222', '2026-11-01', '2026-11-20');
    expect(parseHistoryQuery(owner, 'all', '20', cursor, '2026-11-01', '2026-11-20').before?.micros).toBe('1794960000000000');
    expect(() => parseHistoryQuery(owner, 'all', '20', cursor, '2026-11-02', '2026-11-20')).toThrow('GDS_HISTORY_INVALID_CURSOR');
    expect(() => parseHistoryQuery('another-owner', 'all', '20', cursor, '2026-11-01', '2026-11-20')).toThrow('GDS_HISTORY_INVALID_CURSOR');
  });
});
