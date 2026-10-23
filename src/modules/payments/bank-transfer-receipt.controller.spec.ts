import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import request = require('supertest');
import { BankReceiptController, BankReceiptAdminController } from './bank-transfer-receipt.controller';
import { BankReceiptService } from './bank-transfer-receipt.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiResponseInterceptor } from '../../common/interceptors/api-response.interceptor';

describe('receipt HTTP ownership and role boundary', () => {
  const buyer='11111111-1111-4111-8111-111111111111';
  const order='22222222-2222-4222-8222-222222222222';
  const receipt='33333333-3333-4333-8333-333333333333';
  let app:INestApplication;
  const service={upload:jest.fn(),listOwned:jest.fn(),imageOwned:jest.fn(),listAdmin:jest.fn(),detailAdmin:jest.fn(),imageAdmin:jest.fn()};
  beforeAll(async () => {
    const module=await Test.createTestingModule({controllers:[BankReceiptController,BankReceiptAdminController],
      providers:[{provide:BankReceiptService,useValue:service}]})
      .overrideGuard(JwtAuthGuard).useValue({canActivate:(ctx:ExecutionContext)=>{const req=ctx.switchToHttp().getRequest(); const role=req.headers['x-test-role']; if(role)req.user={id:buyer,roles:[role]}; return true;}}).compile();
    app=module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
    app.useGlobalInterceptors(new ApiResponseInterceptor()); await app.init();
  });
  afterAll(async()=>{await app.close();}); beforeEach(()=>jest.clearAllMocks());
  it('denies anonymous and non-student claim reads before the service', async()=>{
    await request(app.getHttpServer()).get(`/payments/orders/${order}/receipts`).expect(401);
    await request(app.getHttpServer()).get(`/payments/orders/${order}/receipts`).set('x-test-role','instructor').expect(403);
    expect(service.listOwned).not.toHaveBeenCalled();
  });
  it('passes authenticated buyer/order only and validates UUID',async()=>{
    service.listOwned.mockResolvedValue({items:[]});
    await request(app.getHttpServer()).get(`/payments/orders/${order}/receipts`).set('x-test-role','student').expect(200);
    expect(service.listOwned).toHaveBeenCalledWith(buyer,order);
    await request(app.getHttpServer()).get('/payments/orders/invalid/receipts').set('x-test-role','student').expect(400);
  });
  it('keeps Admin queue inaccessible to students',async()=>{
    await request(app.getHttpServer()).get('/admin/commerce/receipt-claims').set('x-test-role','student').expect(403);
    expect(service.listAdmin).not.toHaveBeenCalled();
  });
  it('validates bounded Admin pagination',async()=>{
    service.listAdmin.mockResolvedValue({items:[]});
    await request(app.getHttpServer()).get('/admin/commerce/receipt-claims?page=2&pageSize=10').set('x-test-role','platform_admin').expect(200);
    expect(service.listAdmin).toHaveBeenCalledWith(buyer,{page:2,pageSize:10});
    await request(app.getHttpServer()).get('/admin/commerce/receipt-claims?pageSize=101').set('x-test-role','platform_admin').expect(400);
  });
  it('does not cache private image responses or wrap image bytes in JSON',async()=>{
    service.imageOwned.mockResolvedValue(Buffer.from([137,80,78,71]));
    const res=await request(app.getHttpServer()).get(`/payments/receipts/${receipt}/image`).set('x-test-role','student').expect(200);
    expect(res.headers['content-type']).toContain('image/png'); expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff'); expect(res.body).toEqual(Buffer.from([137,80,78,71]));
  });
  it('accepts exactly one image and forwards the idempotency key',async()=>{
    service.upload.mockResolvedValue({id:receipt,status:'REVIEW_REQUIRED',financialProof:false});
    const image=Buffer.from([137,80,78,71]);
    await request(app.getHttpServer()).post(`/payments/orders/${order}/receipts`).set('x-test-role','student')
      .set('idempotency-key','synthetic-key-001').attach('image',image,{filename:'receipt.png',contentType:'image/png'}).expect(201);
    expect(service.upload).toHaveBeenCalledWith(buyer,order,'synthetic-key-001',expect.objectContaining({buffer:image,mimetype:'image/png'}));
  });
  it('rejects buyer supplied OCR verdict fields',async()=>{
    await request(app.getHttpServer()).post(`/payments/orders/${order}/receipts`).set('x-test-role','student')
      .field('status','MATCHED_CLAIM').attach('image',Buffer.from([137,80,78,71]),{filename:'receipt.png',contentType:'image/png'}).expect(400);
    expect(service.upload).not.toHaveBeenCalled();
  });  it('rejects oversized or non-image multipart before upload service',async()=>{
    await request(app.getHttpServer()).post(`/payments/orders/${order}/receipts`).set('x-test-role','student')
      .attach('image',Buffer.alloc(5*1024*1024+1),'receipt.png').expect(413);
    await request(app.getHttpServer()).post(`/payments/orders/${order}/receipts`).set('x-test-role','student')
      .attach('image',Buffer.from('fake'),{filename:'receipt.txt',contentType:'text/plain'}).expect(400);
    expect(service.upload).not.toHaveBeenCalled();
  });
});
