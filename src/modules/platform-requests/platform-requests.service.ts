import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
const sharp: typeof import('sharp').default = require('sharp');
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { CreateInvoiceRequestDto, CreatePartnerApplicationDto, CreateSupportTicketDto, PartnerListQueryDto, RequestListQueryDto, SupportListQueryDto, UpdatePartnerApplicationDto, UpdateSupportTicketDto } from './platform-requests.dto';
import { PLATFORM_REQUEST_HANDLERS } from './platform-requests.readiness';

export interface SupportImageUpload { buffer: Buffer; mimetype: string; size: number; }

const supportSelect = { attachmentSize: true, id: true, ownerId: true, title: true, content: true, requestType: true, orderId: true, status: true, createdAt: true, updatedAt: true } as const;
const replySelect = { id: true, content: true, isStaff: true, createdAt: true } as const;
const pageMeta = (query: RequestListQueryDto, total: number) => ({ page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) });

@Injectable()
export class PlatformRequestsService {
  constructor(private readonly prisma: PrismaService, private readonly settings: PlatformSettingsService) {}

  readiness() { return PLATFORM_REQUEST_HANDLERS; }

  async createSupport(ownerId: string, input: CreateSupportTicketDto, image?: SupportImageUpload) {
    await this.requireOperation('supportEnabled');
    const attachmentData = image ? await this.normalizeImage(image) : undefined;
    return this.prisma.$transaction(async tx => {
      const ticket = await tx.platformSupportTicket.create({ data: { ownerId, title: input.title, content: input.content, ...(attachmentData ? { attachmentData, attachmentSize: attachmentData.length } : {}) }, select: supportSelect });
      await this.audit(tx, ownerId, 'SUPPORT_TICKET_CREATED', 'support_ticket', ticket.id);
      return ticket;
    });
  }

  async getSupportImage(ownerId: string | undefined, id: string) {
    const ticket = await this.prisma.platformSupportTicket.findFirst({
      where: { id, ...(ownerId ? { ownerId } : {}) }, select: { attachmentData: true },
    });
    if (!ticket?.attachmentData) throw new NotFoundException('Support image not found.');
    return Buffer.from(ticket.attachmentData);
  }

  private async normalizeImage(file: SupportImageUpload) {
    const current = await this.settings.current();
    const configured = Number((current.settings.operations as Record<string, unknown>).maxAttachmentMb);
    const maxMb = Number.isFinite(configured) ? Math.max(1, Math.min(10, configured)) : 5;
    if (!Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || !file.buffer.length || file.buffer.length > maxMb * 1024 * 1024) throw new BadRequestException('Image exceeds the configured attachment size.');
    const bytes = file.buffer;
    const signatures: Record<string, boolean> = {
      'image/png': bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
      'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    };
    if (signatures[file.mimetype] !== true) throw new BadRequestException('Choose a valid PNG, JPEG or WebP image.');
    try {
      // Decoding and re-encoding drops original filenames, metadata and active payloads.
      const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning', animated: false });
      const metadata = await image.metadata();
      if ((metadata.pages ?? 1) !== 1) throw new Error('Animated image');
      const result = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().timeout({ seconds: 5 }).toBuffer();
      if (result.length > 12 * 1024 * 1024) throw new Error('Image too large');
      return result;
    } catch { throw new BadRequestException('Unable to decode this image. Choose a smaller PNG, JPEG or WebP image.'); }
  }

  async listSupport(ownerId: string | undefined, query: SupportListQueryDto) {
    const where = { ...(ownerId ? { ownerId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.requestType ? { requestType: query.requestType } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.platformSupportTicket.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: supportSelect }),
      this.prisma.platformSupportTicket.count({ where }),
    ]);
    return { items: items.map(item => ({ ...item, content: item.content.slice(0, 200) })), ...pageMeta(query, total) };
  }

  async getSupport(ownerId: string | undefined, id: string, query: RequestListQueryDto) {
    const ticket = await this.findTicket(this.prisma, id, ownerId);
    const [replies, total] = await Promise.all([
      this.prisma.platformSupportReply.findMany({ where: { ticketId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: replySelect }),
      this.prisma.platformSupportReply.count({ where: { ticketId: id } }),
    ]);
    return { ...ticket, replies, replyPage: query.page, replyTotal: total, replyTotalPages: Math.ceil(total / query.pageSize) };
  }

  async reply(actorId: string, id: string, content: string, isStaff: boolean) {
    return this.prisma.$transaction(async tx => {
      const ticket = await this.findTicket(tx, id, isStaff ? undefined : actorId);
      await this.requireOperation(ticket.requestType === 'invoice' ? 'invoiceRequestsEnabled' : 'supportEnabled');
      if (ticket.status === 'closed') throw new ConflictException('Reopen this ticket before adding a reply.');
      const reply = await tx.platformSupportReply.create({ data: { ticketId: id, authorId: actorId, content, isStaff }, select: replySelect });
      await tx.platformSupportTicket.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit(tx, actorId, 'SUPPORT_REPLY_CREATED', 'support_ticket', id);
      return reply;
    });
  }

  async createInvoice(ownerId: string, input: CreateInvoiceRequestDto) {
    await this.requireOperation('invoiceRequestsEnabled');
    return this.prisma.$transaction(async tx => {
      const order = await tx.commerceOrder.findFirst({
        where: { id: input.orderId, buyerId: ownerId, status: 'confirmed' },
        select: { id: true, orderNumber: true, payableAmountMinor: true, currency: true, confirmedSettlement: { select: { orderId: true, amountMinor: true, currency: true } } },
      });
      if (!order || !order.confirmedSettlement || order.confirmedSettlement.orderId !== order.id
        || order.confirmedSettlement.amountMinor !== order.payableAmountMinor || order.confirmedSettlement.currency !== order.currency) {
        throw new NotFoundException('Confirmed order not found for this account.');
      }
      const existing = await tx.platformSupportTicket.findUnique({ where: { orderId: input.orderId }, select: supportSelect });
      if (existing) return existing;
      const content = [input.recipientName, input.taxCode, input.billingAddress, input.invoiceEmail].join('\n');
      const invoiceDetails = { recipientName: input.recipientName, taxCode: input.taxCode, billingAddress: input.billingAddress, invoiceEmail: input.invoiceEmail };
      const ticket = await tx.platformSupportTicket.upsert({
        where: { orderId: order.id }, update: {},
        create: { ownerId, orderId: order.id, requestType: 'invoice', invoiceDetails, title: 'Invoice ' + order.orderNumber, content }, select: supportSelect,
      });
      await this.audit(tx, ownerId, 'INVOICE_REQUEST_CREATED', 'support_ticket', ticket.id);
      return ticket;
    });
  }

  async updateSupport(actorId: string, id: string, input: UpdateSupportTicketDto) {
    return this.prisma.$transaction(async tx => {
      await this.findTicket(tx, id);
      const ticket = await tx.platformSupportTicket.update({ where: { id }, data: { status: input.status }, select: supportSelect });
      await this.audit(tx, actorId, 'SUPPORT_STATUS_CHANGED', 'support_ticket', id, { status: input.status });
      return ticket;
    });
  }

  async createPartner(input: CreatePartnerApplicationDto) {
    const policyId = await this.requireOperation('partnerApplicationsEnabled');
    return this.prisma.$transaction(async tx => {
      const application = await tx.platformPartnerApplication.create({
        data: { category: input.category, name: input.name, organization: input.organization, phone: input.phone,
          email: input.email.toLowerCase(), content: input.content, consentAt: new Date(), policyId },
        select: { id: true, status: true, createdAt: true },
      });
      await this.audit(tx, undefined, 'PARTNER_APPLICATION_CREATED', 'partner_application', application.id);
      return application;
    });
  }

  async listPartners(query: PartnerListQueryDto) {
    const where = query.status ? { status: query.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.platformPartnerApplication.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.platformPartnerApplication.count({ where }),
    ]);
    return { items, ...pageMeta(query, total) };
  }

  async updatePartner(actorId: string, id: string, input: UpdatePartnerApplicationDto) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.platformPartnerApplication.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Partner application not found.');
      const application = await tx.platformPartnerApplication.update({ where: { id }, data: { status: input.status } });
      await this.audit(tx, actorId, 'PARTNER_STATUS_CHANGED', 'partner_application', id, { status: input.status });
      return application;
    });
  }

  private async requireOperation(key: 'supportEnabled' | 'partnerApplicationsEnabled' | 'invoiceRequestsEnabled') {
    const current = await this.settings.current();
    const operations = current.settings.operations as Record<string, unknown>;
    if (operations?.[key] !== true) throw new ServiceUnavailableException('Request intake is currently disabled.');
    return current.versions.operations ?? null;
  }

  private async findTicket(client: Pick<Prisma.TransactionClient, 'platformSupportTicket'>, id: string, ownerId?: string) {
    const ticket = await client.platformSupportTicket.findFirst({ where: { id, ...(ownerId ? { ownerId } : {}) }, select: supportSelect });
    if (!ticket) throw new NotFoundException('Support ticket not found.');
    return ticket;
  }

  private async audit(tx: Prisma.TransactionClient, actorId: string | undefined, action: string, type: string, id: string, metadata: Record<string, string> = {}) {
    await tx.auditLog.create({ data: { actorId, actorKind: actorId ? 'USER' : 'SYSTEM', action, targetType: type, targetId: id, metadataJson: metadata } });
  }
}
