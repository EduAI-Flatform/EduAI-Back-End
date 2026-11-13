import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ServiceEntitlementController } from './service-entitlement.controller';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiceEntitlementService } from './service-entitlement.service';

describe('ServiceEntitlementController authorization', () => {
  it('requires authentication for any account role to read only its injected-user quota view', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ServiceEntitlementController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, ServiceEntitlementController)).toBeUndefined();
    const service = { listForUser: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new ServiceEntitlementController(service as never);
    await controller.listOwn('student-id');
    expect(service.listForUser).toHaveBeenCalledWith('student-id');
  });
});

describe('own-quota HTTP ownership boundary', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const secret = 'synthetic-quota-controller-test-only';
  const accounts = ['student', 'instructor', 'platform_admin'].map((role, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`, email: `${role}@example.test`,
    status: 'active', deletedAt: null, mfa: null, roles: [{ role: { name: role } }],
  }));
  const service = { listForUser: jest.fn(async (userId: string) => ({ items: [], cardItems: [], owner: userId })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })], controllers: [ServiceEntitlementController],
      providers: [
        { provide: ServiceEntitlementService, useValue: service },
        { provide: AppConfigService, useValue: { jwt: { accessSecret: secret } } },
        { provide: PrismaService, useValue: { user: { findUnique: jest.fn(async ({ where }) => accounts.find(account => account.id === where.id) ?? null) } } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    jwt = module.get(JwtService);
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => service.listForUser.mockClear());

  it.each(accounts)('injects authenticated owner $id and ignores caller-selected query owners', async account => {
    const token = await jwt.signAsync({ sub: account.id }, { expiresIn: '1m' });
    await request(app.getHttpServer()).get(`/membership/service-entitlements?userId=${accounts[2].id}`)
      .set('Authorization', `Bearer ${token}`).expect(200).expect(({ body }) => expect(body.owner).toBe(account.id));
    expect(service.listForUser).toHaveBeenCalledTimes(1);
    expect(service.listForUser).toHaveBeenCalledWith(account.id);
  });
  it('rejects anonymous and invalid-token reads before accessing entitlement data', async () => {
    await request(app.getHttpServer()).get('/membership/service-entitlements').expect(401);
    await request(app.getHttpServer()).get('/membership/service-entitlements').set('Authorization', 'Bearer invalid').expect(401);
    expect(service.listForUser).not.toHaveBeenCalled();
  });
  it('exposes no caller-selected owner route or public mutation', async () => {
    const token = await jwt.signAsync({ sub: accounts[0].id });
    await request(app.getHttpServer()).get(`/membership/service-entitlements/${accounts[2].id}`).set('Authorization', `Bearer ${token}`).expect(404);
    await request(app.getHttpServer()).post('/membership/service-entitlements').set('Authorization', `Bearer ${token}`).send({ userId: accounts[2].id }).expect(404);
    expect(service.listForUser).not.toHaveBeenCalled();
  });
});
