import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PlatformRequestsService } from './platform-requests.service';

describe('PlatformRequestsService', () => {
  const ticket = { id: 'ticket-a', ownerId: 'owner-a', title: 'Help me', content: 'Private details', status: 'open' };
  const setup = (enabled = true) => {
    const prisma = {
      platformSupportTicket: {
        findFirst: jest.fn(async ({ where }: { where: { ownerId?: string } }) => !where.ownerId || where.ownerId === ticket.ownerId ? ticket : null),
        findMany: jest.fn().mockResolvedValue([ticket]), count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue(ticket), update: jest.fn().mockResolvedValue(ticket),
      },
      platformSupportReply: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
      platformPartnerApplication: { create: jest.fn().mockResolvedValue({ id: 'partner-a', status: 'submitted' }) },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(prisma)),
    };
    const settings = { current: jest.fn().mockResolvedValue({ settings: { operations: { supportEnabled: enabled, partnerApplicationsEnabled: enabled } }, versions: { operations: 'policy-a' } }) };
    return { prisma, settings, service: new PlatformRequestsService(prisma as never, settings as never) };
  };
  it('filters the current user list by the authenticated owner', async () => {
    const { service, prisma } = setup();
    await service.listSupport('owner-a', { page: 1, pageSize: 20 });
    expect(prisma.platformSupportTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'owner-a' } }));
  });
  it('does not reveal another account ticket or conversation', async () => {
    const { service, prisma } = setup();
    await expect(service.getSupport('owner-b', 'ticket-a', { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.platformSupportReply.findMany).not.toHaveBeenCalled();
  });
  it('does not allow replying to another account ticket', async () => {
    const { service, prisma } = setup();
    await expect(service.reply('owner-b', 'ticket-a', 'Not mine', false)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.platformSupportReply.create).not.toHaveBeenCalled();
  });
  it('rejects new support and partner collection while operations are disabled', async () => {
    const { service, prisma } = setup(false);
    await expect(service.createSupport('owner-a', { title: 'Need help', content: 'Private details' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.createPartner({ category: 'school', name: 'Example', organization: 'School', phone: '0901234567', email: 'example@example.test', content: 'A partnership application', consent: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.platformSupportTicket.create).not.toHaveBeenCalled();
    expect(prisma.platformPartnerApplication.create).not.toHaveBeenCalled();
  });
  it('audits identifiers but never support content', async () => {
    const { service, prisma } = setup();
    await service.createSupport('owner-a', { title: 'Need help', content: 'Private details' });
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('Private details');
  });
  it('records explicit consent and active operations-policy provenance for partner requests', async () => {
    const { service, prisma } = setup();
    await service.createPartner({ category: 'school', name: 'Example', organization: 'School', phone: '0901234567', email: 'EXAMPLE@example.test', content: 'A partnership application', consent: true });
    expect(prisma.platformPartnerApplication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: 'example@example.test', consentAt: expect.any(Date), policyId: 'policy-a' }),
    }));
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('example@example.test');
  });
});
