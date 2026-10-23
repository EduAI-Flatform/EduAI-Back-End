import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BankReceiptAccessController, BankReceiptAccessAdminController } from './bank-receipt-access.controller';
import { BankReceiptAccessService } from './bank-receipt-access.service';

const claim = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
describe('receipt access HTTP boundary', () => {
  let app: INestApplication;
  const service = { describeClaim: jest.fn(), describeClaimAdmin: jest.fn(), revoke: jest.fn(), restore: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [BankReceiptAccessController, BankReceiptAccessAdminController],
      providers: [{ provide: BankReceiptAccessService, useValue: service }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        if (req.headers['x-role']) req.user = { id: actor, roles: [req.headers['x-role']] };
        return true;
      } }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('requires student identity for owned access and Admin for revocation', async () => {
    await request(app.getHttpServer()).get(`/payments/receipts/${claim}/access`).expect(401);
    await request(app.getHttpServer()).get(`/payments/receipts/${claim}/access`).set('x-role', 'student').expect(200);
    expect(service.describeClaim).toHaveBeenCalledWith(actor, claim);
    await request(app.getHttpServer()).post(`/admin/commerce/receipt-claims/${claim}/revoke`).set('x-role', 'student')
      .send({ reason: 'Yeu cau thu hoi', expectedGeneration: 1 }).expect(403);
    expect(service.revoke).not.toHaveBeenCalled();
  });
  it('validates reason, generation and rejects financial state injection', async () => {
    for (const body of [{ reason: '', expectedGeneration: 1 }, { reason: 'ok', expectedGeneration: 0 },
      { reason: 'ok', expectedGeneration: 1, status: 'PAID' }, { reason: 'x'.repeat(301), expectedGeneration: 1 }]) {
      await request(app.getHttpServer()).post(`/admin/commerce/receipt-claims/${claim}/revoke`).set('x-role', 'platform_admin')
        .set('idempotency-key', 'review-operation-01').send(body).expect(400);
    }
    expect(service.revoke).not.toHaveBeenCalled();
  });
  it.each(['revoke', 'restore'] as const)('forwards %s to the source-scoped transactional service', async method => {
    await request(app.getHttpServer()).post(`/admin/commerce/receipt-claims/${claim}/${method}`).set('x-role', 'platform_admin')
      .set('idempotency-key', 'review-operation-01').send({ reason: 'Da kiem tra yeu cau', expectedGeneration: 1 }).expect(201);
    expect(service[method]).toHaveBeenCalledWith(actor, claim, 'review-operation-01', { reason: 'Da kiem tra yeu cau', expectedGeneration: 1 });
  });
});