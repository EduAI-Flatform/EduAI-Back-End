import { BadRequestException, NotFoundException } from '@nestjs/common';
const sharp: typeof import('sharp').default = require('sharp');
import { PlatformRequestsService } from './platform-requests.service';
describe('private support screenshot', () => {
  const setup = (maxAttachmentMb = 1) => {
    const prisma: any = { platformSupportTicket: { create: jest.fn(async ({ data, select }) => Object.fromEntries(Object.entries({ id: 'ticket', ...data }).filter(([key]) => select[key]))), findFirst: jest.fn().mockResolvedValue(null) }, auditLog: { create: jest.fn() } };
    prisma.$transaction = async (work: any) => work(prisma);
    const settings: any = { current: async () => ({ settings: { operations: { supportEnabled: true, maxAttachmentMb } }, versions: {} }) };
    return { prisma, service: new PlatformRequestsService(prisma, settings) };
  };
  const input = { title: 'Need help', content: 'Private support details' };
  it('normalizes an image atomically without projecting bytes', async () => {
    const { prisma, service } = setup();
    const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().withMetadata().toBuffer();
    const result = await service.createSupport('owner', input, { buffer, mimetype: 'image/jpeg', size: buffer.length });
    expect(result).toMatchObject({ attachmentSize: expect.any(Number) }); expect(result).not.toHaveProperty('attachmentData');
    const metadata = await sharp(prisma.platformSupportTicket.create.mock.calls[0][0].data.attachmentData).metadata();
    expect(metadata.format).toBe('png'); expect(metadata.exif).toBeUndefined();
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('Private support details');
  });
  it('rejects spoofed magic and corrupt images before saving', async () => {
    const { prisma, service } = setup();
    for (const buffer of [Buffer.from('<svg></svg>'), Buffer.from('89504e470d0a1a0a', 'hex')]) {
      await expect(service.createSupport('owner', input, { buffer, mimetype: 'image/png', size: buffer.length })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.platformSupportTicket.create).not.toHaveBeenCalled();
  });
  it('enforces the configured upload ceiling', async () => {
    const { service } = setup(); const buffer = Buffer.alloc(1024 * 1024 + 1);
    await expect(service.createSupport('owner', input, { buffer, mimetype: 'image/png', size: buffer.length })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('scopes private screenshot lookup to its owner', async () => {
    const { prisma, service } = setup();
    await expect(service.getSupportImage('other', 'ticket')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.platformSupportTicket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ticket', ownerId: 'other' } }));
    prisma.platformSupportTicket.findFirst.mockResolvedValue({ attachmentData: Buffer.from('private') });
    expect(await service.getSupportImage(undefined, 'ticket')).toEqual(Buffer.from('private'));
  });
});
