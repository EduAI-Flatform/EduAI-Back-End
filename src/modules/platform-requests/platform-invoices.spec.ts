import { NotFoundException } from '@nestjs/common';
import { PlatformRequestsService } from './platform-requests.service';

describe('invoice requests', () => {
  const input = { orderId: 'order-a', recipientName: 'School', taxCode: '1234567890', billingAddress: 'School address', invoiceEmail: 'invoice@example.test' };
  function setup() {
    const ticket = { id: 'ticket', requestType: 'invoice', orderId: 'order-a', ownerId: 'owner' };
    const prisma: any = {
      commerceOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', orderNumber: 'GDS-1', payableAmountMinor: 50000n, currency: 'VND', confirmedSettlement: { orderId: 'order-a', amountMinor: 50000n, currency: 'VND' } }) },
      platformSupportTicket: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue(ticket) },
      auditLog: { create: jest.fn() }, $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const settings = { current: jest.fn().mockResolvedValue({ settings: { operations: { invoiceRequestsEnabled: true } }, versions: {} }) };
    return { prisma, ticket, service: new PlatformRequestsService(prisma as any, settings as any) };
  }
  it('checks order ownership and canonical settlement then records structured invoice details', async () => {
    const { service, prisma } = setup();
    await service.createInvoice('owner', input);
    expect(prisma.commerceOrder.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-a', buyerId: 'owner', status: 'confirmed' } }));
    expect(prisma.platformSupportTicket.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'order-a' }, update: {}, create: expect.objectContaining({ requestType: 'invoice', invoiceDetails: expect.objectContaining({ taxCode: input.taxCode }) }) }));
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(input.taxCode);
  });
  it('does not create an invoice for another account or mismatched settlement', async () => {
    const first = setup(); first.prisma.commerceOrder.findFirst.mockResolvedValue(null);
    await expect(first.service.createInvoice('other', input)).rejects.toBeInstanceOf(NotFoundException);
    expect(first.prisma.platformSupportTicket.upsert).not.toHaveBeenCalled();
    const second = setup(); second.prisma.commerceOrder.findFirst.mockResolvedValue({ id: 'order-a', payableAmountMinor: 50000n, currency: 'VND', confirmedSettlement: { orderId: 'different', amountMinor: 50000n, currency: 'VND' } } as any);
    await expect(second.service.createInvoice('owner', input)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('returns an existing request instead of duplicating invoice submissions', async () => {
    const { service, prisma, ticket } = setup(); prisma.platformSupportTicket.findUnique.mockResolvedValue(ticket as any);
    await expect(service.createInvoice('owner', input)).resolves.toBe(ticket);
    expect(prisma.platformSupportTicket.upsert).not.toHaveBeenCalled();
  });
});
