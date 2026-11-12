import { ExecutionContext, INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RATE_LIMIT_KEY } from '../../common/security/rate-limit.decorator';
import { AdminPlatformRequestsController, PlatformSupportController, PublicPartnerApplicationsController } from './platform-requests.controller';
import { PlatformRequestsService } from './platform-requests.service';

const sharp: typeof import('sharp').default = require('sharp');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ticketId = '00000000-0000-4000-8000-000000000003';
const partnerInput = { category: 'school', name: 'Example', organization: 'Example School', phone: '0901234567', email: 'hello@example.test', content: 'We would like to partner with GDS.', consent: true };

describe('request HTTP authorization and validation', () => {
  let app: INestApplication;
  let enabled = true;
  const ticket = { id: ticketId, ownerId: owner, title: 'Need help', content: 'Private support details', status: 'open', createdAt: new Date(), updatedAt: new Date() };
  const prisma = {
    platformSupportTicket: {
      findFirst: jest.fn(async ({ where, select }: { where: { id: string; ownerId?: string }; select: Record<string, boolean> }) => where.id === ticketId && (!where.ownerId || where.ownerId === owner) ? (select.attachmentData ? { attachmentData: Buffer.from('private screenshot') } : ticket) : null),
      findMany: jest.fn().mockResolvedValue([ticket]), count: jest.fn().mockResolvedValue(1),
      create: jest.fn(async ({ data, select }: { data: object; select: Record<string, boolean> }) => Object.fromEntries(Object.entries({ ...ticket, ...data }).filter(([key]) => select[key]))),
      update: jest.fn(async ({ data }: { data: object }) => ({ ...ticket, ...data })),
    },
    platformSupportReply: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'reply-1', content: 'A support response', isStaff: true }) },
    platformPartnerApplication: { create: jest.fn().mockResolvedValue({ id: 'partner-1', status: 'submitted', createdAt: new Date() }), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(prisma)),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformSupportController, PublicPartnerApplicationsController, AdminPlatformRequestsController],
      providers: [PlatformRequestsService, RolesGuard, Reflector,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformSettingsService, useValue: { current: async () => ({ settings: { operations: { supportEnabled: enabled, partnerApplicationsEnabled: enabled } }, versions: {} }) } }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      if (!req.headers['x-test-owner']) throw new UnauthorizedException();
      req.user = { id: req.headers['x-test-owner'], roles: [req.headers['x-test-role'] ?? 'student'] };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => { enabled = true; jest.clearAllMocks(); });

  it('creates multipart screenshots without exposing bytes or original names', async () => {
    const image = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
    const response = await request(app.getHttpServer()).post('/platform/support').set('x-test-owner', owner)
      .field('title', 'Image help').field('content', 'Private support details').attach('image', image, { filename: 'private-person.png', contentType: 'image/png' }).expect(201);
    expect(response.body.attachmentSize).toBeGreaterThan(0); expect(response.body).not.toHaveProperty('attachmentData');
    expect(JSON.stringify(response.body)).not.toContain('private-person');
  });
  it('serves image bytes only to the owner and platform administrator with private headers', async () => {
    await request(app.getHttpServer()).get('/platform/support/' + ticketId + '/image').expect(401);
    await request(app.getHttpServer()).get('/platform/support/' + ticketId + '/image').set('x-test-owner', other).expect(404);
    await request(app.getHttpServer()).get('/admin/platform/requests/support/' + ticketId + '/image').set('x-test-owner', owner).expect(403);
    const response = await request(app.getHttpServer()).get('/platform/support/' + ticketId + '/image').set('x-test-owner', owner).expect(200);
    expect(response.headers['content-type']).toContain('image/png'); expect(response.headers['cache-control']).toContain('no-store'); expect(response.headers['x-content-type-options']).toBe('nosniff');
    await request(app.getHttpServer()).get('/admin/platform/requests/support/' + ticketId + '/image').set('x-test-owner', other).set('x-test-role', 'platform_admin').expect(200);
  });
  it('requires authentication for support access', async () => {
    await request(app.getHttpServer()).get('/platform/support').expect(401);
  });
  it('returns 404 for another owner detail and reply without leaking private content', async () => {
    const response = await request(app.getHttpServer()).get(`/platform/support/${ticketId}`).set('x-test-owner', other).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Private support details');
    await request(app.getHttpServer()).post(`/platform/support/${ticketId}/replies`).set('x-test-owner', other).send({ content: 'Intruding' }).expect(404);
    expect(prisma.platformSupportReply.create).not.toHaveBeenCalled();
  });
  it('rejects forged ownership and attachment fields at the request boundary', async () => {
    await request(app.getHttpServer()).post('/platform/support').set('x-test-owner', owner)
      .send({ title: 'Need help', content: 'Private support details', ownerId: other, attachmentUrl: 'https://example.test/image' }).expect(400);
    expect(prisma.platformSupportTicket.create).not.toHaveBeenCalled();
  });
  it('creates support on behalf of the authenticated owner only', async () => {
    const response = await request(app.getHttpServer()).post('/platform/support').set('x-test-owner', owner)
      .send({ title: ' Need help ', content: ' Private support details ' }).expect(201);
    expect(response.body.ownerId).toBe(owner);
    expect(response.body.title).toBe('Need help');
  });
  it('denies every admin request operation to a student', async () => {
    const agent = request(app.getHttpServer());
    await agent.get('/admin/platform/requests/support').set('x-test-owner', owner).expect(403);
    await agent.get(`/admin/platform/requests/support/${ticketId}`).set('x-test-owner', owner).expect(403);
    await agent.patch(`/admin/platform/requests/support/${ticketId}`).set('x-test-owner', owner).send({ status: 'resolved' }).expect(403);
    await agent.post(`/admin/platform/requests/support/${ticketId}/replies`).set('x-test-owner', owner).send({ content: 'Forged staff reply' }).expect(403);
    await agent.get('/admin/platform/requests/partners').set('x-test-owner', owner).expect(403);
    await agent.patch(`/admin/platform/requests/partners/${ticketId}`).set('x-test-owner', owner).send({ status: 'accepted' }).expect(403);
  });
  it('lets an administrator change status and add a staff response', async () => {
    await request(app.getHttpServer()).patch(`/admin/platform/requests/support/${ticketId}`).set('x-test-owner', other).set('x-test-role', 'platform_admin').send({ status: 'resolved' }).expect(200);
    await request(app.getHttpServer()).post(`/admin/platform/requests/support/${ticketId}/replies`).set('x-test-owner', other).set('x-test-role', 'platform_admin').send({ content: 'A support response' }).expect(201);
    expect(prisma.platformSupportReply.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ authorId: other, isStaff: true }) }));
  });
  it('accepts a public partner application only with explicit consent and enabled intake', async () => {
    await request(app.getHttpServer()).post('/platform/partner-applications').send({ ...partnerInput, consent: false }).expect(400);
    await request(app.getHttpServer()).post('/platform/partner-applications').send(partnerInput).expect(201);
    enabled = false;
    await request(app.getHttpServer()).post('/platform/partner-applications').send(partnerInput).expect(503);
    expect(prisma.platformPartnerApplication.create).toHaveBeenCalledTimes(1);
  });
  it('bounds pagination and declares rate limits for all new content intake', async () => {
    await request(app.getHttpServer()).get('/platform/support?pageSize=1000').set('x-test-owner', owner).expect(400);
    for (const method of [PlatformSupportController.prototype.create, PlatformSupportController.prototype.reply, AdminPlatformRequestsController.prototype.reply, PublicPartnerApplicationsController.prototype.create]) {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, method)).toMatchObject({ limit: expect.any(Number), windowSeconds: 3600 });
    }
  });
});
