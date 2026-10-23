import { ConflictException } from '@nestjs/common';
import { BankReceiptService } from './bank-transfer-receipt.service';
import { decodeReceiptImage } from './bank-transfer-receipt-image';
jest.mock('./bank-transfer-receipt-image', () => ({ decodeReceiptImage: jest.fn() }));

describe('Private synthetic receipt intake', () => {
  const buyer='11111111-1111-4111-8111-111111111111';
  const file={buffer:Buffer.from('image'),size:5,mimetype:'image/png'};
  const originalEnv={...process.env};
  beforeEach(() => {
    process.env.BANK_TRANSFER_SANDBOX_ENABLED='true'; process.env.BANK_RECEIPT_SANDBOX_ENABLED='true';
    process.env.BANK_RECEIPT_SYNTHETIC_BUYER_IDS=buyer;
    jest.resetAllMocks();
    (decodeReceiptImage as jest.Mock).mockResolvedValue({buffer:file.buffer,originalSha256:'a'.repeat(64),imageSha256:'b'.repeat(64),width:100,height:100});
  });
  afterAll(() => { process.env=originalEnv; });
  const harness=() => {
    const now=Date.now();
    const order={id:'order',buyerId:buyer,status:'pending_payment'};
    const request={id:'request',orderId:order.id,status:'PENDING',bankBin:'970422',accountNumber:'0000000000',beneficiaryName:'SANDBOX ONLY',amountMinor:1000n,transferContent:'EDUAITEST01',createdAt:new Date(now-60_000),expiresAt:new Date(now+600_000)};
    const claims:any[]=[];
    const tx:any={
      $queryRaw:jest.fn().mockResolvedValue([]),
      user:{findFirst:jest.fn().mockResolvedValue({id:buyer})},
      commerceOrder:{findMany:jest.fn().mockResolvedValue([]),findFirst:jest.fn().mockImplementation(async ({where}) => where.buyerId===buyer?order:null)},
      commerceBankTransferRequest:{findUnique:jest.fn().mockResolvedValue(request)},
      commerceBankReceiptClaim:{
        findUnique:jest.fn().mockImplementation(async ({where}) => claims.find(c=>where.id?c.id===where.id:c.buyerId===where.buyerId_operationKeyHash.buyerId&&c.operationKeyHash===where.buyerId_operationKeyHash.operationKeyHash)??null),
        findFirst:jest.fn().mockResolvedValue(null), count:jest.fn().mockImplementation(async()=>claims.length),
        create:jest.fn().mockImplementation(async({data})=>{const c={status:'PROCESSING',...data,fieldsJson:null,warnings:[],confidence:null,imageDeletedAt:null,assessedAt:null};claims.push(c);return c;}),
        update:jest.fn().mockImplementation(async({where,data})=>Object.assign(claims.find(c=>c.id===where.id),data)),
        findMany:jest.fn().mockResolvedValue([]),
      },
    };
    tx.commerceBankReceiptClaim.findUniqueOrThrow=jest.fn().mockImplementation(async({where})=>{const row=claims.find(c=>c.id===where.id);if(!row)throw new Error('not found');return row;});
    tx.commerceBankTransferRequest.findUniqueOrThrow=jest.fn().mockResolvedValue(request);
    tx.$transaction=jest.fn(async fn=>fn(tx));
    const audit={record:jest.fn().mockResolvedValue({})};
    const storage={put:jest.fn().mockResolvedValue(undefined),read:jest.fn().mockResolvedValue(file.buffer),remove:jest.fn().mockResolvedValue(undefined)};
    const ocr={assess:jest.fn().mockResolvedValue({fields:{bankBin:'970422',accountNumber:'0000000000',beneficiaryName:'SANDBOX ONLY',amountMinor:'1000',transferContent:'EDUAITEST01',occurredAt:new Date(now-30_000).toISOString(),transactionId:null},confidence:95,warnings:[]})};
    const access={grantForClaim:jest.fn().mockResolvedValue({state:'ACCESS_UNVERIFIED',generation:1,financialProof:false})};
    const config={app:{nodeEnv:'test'}};
    return {service:new BankReceiptService(tx,config as any,audit as any,storage as any,ocr as any,access as any),access,tx,claims,storage,ocr,config,request,order,audit};
  };
  it('uses a separate idempotent access ledger after matched assessment and upload replay',async()=>{
    process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED='true';const h=harness();
    const first=await h.service.upload(buyer,'order','early-upload-key',file);
    const second=await h.service.upload(buyer,'order','early-upload-key',file);
    expect(first).toMatchObject({status:'MATCHED_CLAIM',financialProof:false,access:{state:'ACCESS_UNVERIFIED'}});
    expect(second).toMatchObject({access:{state:'ACCESS_UNVERIFIED'}});
    expect(h.access.grantForClaim).toHaveBeenCalledTimes(2);expect(h.ocr.assess).toHaveBeenCalledTimes(1);
    expect(h.order.status).toBe('pending_payment');delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
  });
  it('retains matched evidence when access requires review and does not report payment',async()=>{
    process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED='true';const h=harness();
    h.access.grantForClaim.mockRejectedValue(new ConflictException('RECEIPT_ACCESS_SCOPE_UNSUPPORTED'));
    await expect(h.service.upload(buyer,'order','early-review-key',file)).resolves.toMatchObject({
      status:'MATCHED_CLAIM',financialProof:false,access:{state:'NONE',warning:'ACCESS_REVIEW_REQUIRED'},
    });expect(h.claims[0].status).toBe('MATCHED_CLAIM');delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
  });  it('retries a structured driver serialization conflict during final assessment',async()=>{
    const h=harness();let calls=0;
    const conflict=Object.assign(new Error('TransactionWriteConflict'),{name:'DriverAdapterError',cause:{kind:'TransactionWriteConflict'}});
    h.tx.$transaction.mockImplementation(async(fn:any)=>{calls++;if(calls===3)throw conflict;return fn(h.tx);});
    const result=await h.service.upload(buyer,'order','upload-conflict-1',file);
    expect(result.status).toBe('MATCHED_CLAIM');expect(h.claims).toHaveLength(1);expect(h.ocr.assess).toHaveBeenCalledTimes(1);
    expect(h.order.status).toBe('pending_payment');expect(calls).toBe(4);
  });
  it('bounds repeated driver conflicts and returns a safe retryable conflict',async()=>{
    const h=harness();const conflict=Object.assign(new Error('TransactionWriteConflict'),{name:'DriverAdapterError',cause:{kind:'TransactionWriteConflict'}});
    h.tx.$transaction.mockRejectedValue(conflict);
    await expect(h.service.upload(buyer,'order','upload-conflict-2',file)).rejects.toThrow('RECEIPT_CONCURRENT_OPERATION');
    expect(h.tx.$transaction).toHaveBeenCalledTimes(3);expect(decodeReceiptImage).not.toHaveBeenCalled();
  });
  it('does not retry unrelated driver failures',async()=>{
    const h=harness();const failure=Object.assign(new Error('database unavailable'),{name:'DriverAdapterError',cause:{kind:'AuthenticationFailed'}});
    h.tx.$transaction.mockRejectedValue(failure);
    await expect(h.service.upload(buyer,'order','upload-conflict-3',file)).rejects.toThrow('database unavailable');
    expect(h.tx.$transaction).toHaveBeenCalledTimes(1);
  });  it('denies production before database or decoding',async()=>{
    const h=harness();h.config.app.nodeEnv='production';
    await expect(h.service.upload(buyer,'order','upload-key-1',file)).rejects.toThrow('BANK_RECEIPT_DISABLED');
    expect(h.tx.$transaction).not.toHaveBeenCalled();expect(decodeReceiptImage).not.toHaveBeenCalled();
  });
  it('checks ownership before decoding or writing private storage',async()=>{
    const h=harness();h.tx.commerceOrder.findFirst.mockResolvedValue(null);
    await expect(h.service.upload(buyer,'order','upload-key-1',file)).rejects.toThrow();
    expect(decodeReceiptImage).not.toHaveBeenCalled();expect(h.storage.put).not.toHaveBeenCalled();
  });
  it('records an assessed claim and leaves the payment/order untouched',async()=>{
    const h=harness();const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('MATCHED_CLAIM');expect(result.financialProof).toBe(false);
    expect(result).not.toHaveProperty('originalSha256');expect(h.order.status).toBe('pending_payment');expect(h.request.status).toBe('PENDING');
  });
  it('replays the same key/file without repeating OCR or upload',async()=>{
    const h=harness();const first=await h.service.upload(buyer,'order','upload-key-1',file);
    const again=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(again.id).toBe(first.id);expect(h.storage.put).toHaveBeenCalledTimes(1);expect(h.ocr.assess).toHaveBeenCalledTimes(1);
  });
  it('rejects an idempotency key reused for different content',async()=>{
    const h=harness();await h.service.upload(buyer,'order','upload-key-1',file);
    (decodeReceiptImage as jest.Mock).mockResolvedValue({buffer:file.buffer,originalSha256:'c'.repeat(64),imageSha256:'d'.repeat(64),width:100,height:100});
    await expect(h.service.upload(buyer,'order','upload-key-1',file)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });
  it('fails closed on OCR failure with a generic safe warning',async()=>{
    const h=harness();h.ocr.assess.mockRejectedValue(new Error('secret OCR provider details'));
    const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('OCR_FAILED');expect(result.warnings).toEqual(['OCR_UNAVAILABLE']);expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('requires review for low-confidence OCR',async()=>{
    const h=harness();const output=await h.ocr.assess();h.ocr.assess.mockResolvedValue({...output,confidence:69});
    expect((await h.service.upload(buyer,'order','upload-key-1',file)).status).toBe('REVIEW_REQUIRED');
  });
  it('does not block a match solely for the optional OCR transaction code',async()=>{
    const h=harness();const output=await h.ocr.assess();h.ocr.assess.mockResolvedValue({...output,warnings:['OCR_MISSING_TRANSACTION_ID']});
    expect((await h.service.upload(buyer,'order','upload-key-1',file)).status).toBe('MATCHED_CLAIM');
  });
  it('requires review for reused bank transaction codes',async()=>{
    const h=harness();const output=await h.ocr.assess();h.ocr.assess.mockResolvedValue({...output,fields:{...output.fields,transactionId:'TX-1'}});
    const original=h.tx.commerceBankReceiptClaim.findUnique.getMockImplementation();
    h.tx.commerceBankReceiptClaim.findUnique.mockImplementation(async({where}:any)=>where.transactionKeyHash?{id:'other'}:original({where}));
    const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('REVIEW_REQUIRED');expect(result.warnings).toContain('TRANSACTION_REUSED');
  });
  it('denies expired image retrieval even for its owner',async()=>{
    const h=harness();await h.service.upload(buyer,'order','upload-key-1',file);h.claims[0].expiresAt=new Date(0);
    await expect(h.service.imageOwned(buyer,h.claims[0].id)).rejects.toThrow();expect(h.storage.read).not.toHaveBeenCalled();
  });
  it('denies admins outside the reconciliation allowlist',async()=>{
    const h=harness();process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS='other';
    await expect(h.service.listAdmin(buyer,{page:1,pageSize:20})).rejects.toThrow();expect(h.tx.commerceBankReceiptClaim.findMany).not.toHaveBeenCalled();
  });
  it('records storage failure without sending an image to OCR',async()=>{
    const h=harness();h.storage.put.mockRejectedValue(new Error('private path details'));
    const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('OCR_FAILED');expect(result.imageAvailable).toBe(false);
    expect(result.warnings).toEqual(['PRIVATE_STORAGE_UNAVAILABLE']);expect(h.ocr.assess).not.toHaveBeenCalled();
  });
  it('rejects a fourth claim before writing storage',async()=>{
    const h=harness();h.tx.commerceBankReceiptClaim.count.mockResolvedValue(3);
    await expect(h.service.upload(buyer,'order','upload-key-1',file)).rejects.toThrow('RECEIPT_UPLOAD_LIMIT');
    expect(h.storage.put).not.toHaveBeenCalled();
  });
  it('rejects an image previously used by another order',async()=>{
    const h=harness();h.tx.commerceBankReceiptClaim.findFirst.mockResolvedValue({id:'other'});
    await expect(h.service.upload(buyer,'order','upload-key-1',file)).rejects.toThrow('RECEIPT_ALREADY_USED');
    expect(h.storage.put).not.toHaveBeenCalled();
  });
  it('requires review when the order closes during OCR',async()=>{
    const h=harness();const output=await h.ocr.assess();
    h.ocr.assess.mockImplementation(async()=>{h.order.status='cancelled';h.request.status='CANCELLED';return output;});
    const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('REVIEW_REQUIRED');expect(result.warnings).toContain('ORDER_WINDOW_CLOSED');
  });
  it('requires review when buyer authority is removed during OCR',async()=>{
    const h=harness();const output=await h.ocr.assess();
    h.ocr.assess.mockImplementation(async()=>{h.tx.user.findFirst.mockResolvedValue(null);return output;});
    const result=await h.service.upload(buyer,'order','upload-key-1',file);
    expect(result.status).toBe('REVIEW_REQUIRED');expect(result.warnings).toContain('BUYER_NO_LONGER_ELIGIBLE');
  });
  it('denies revoked administrator even if still allowlisted',async()=>{
    const h=harness();process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS=buyer;h.tx.user.findFirst.mockResolvedValue(null);
    await expect(h.service.listAdmin(buyer,{page:1,pageSize:20})).rejects.toThrow('RECEIPT_OPERATOR_REQUIRED');
  });
  it('surfaces an interrupted processing lease as OCR failure',async()=>{
    const h=harness();await h.service.upload(buyer,'order','upload-key-1',file);
    Object.assign(h.claims[0],{status:'PROCESSING',processingExpiresAt:new Date(0)});
    h.tx.commerceBankReceiptClaim.findMany.mockResolvedValue(h.claims);
    const result=await h.service.listOwned(buyer,'order');
    expect(result.items[0].status).toBe('OCR_FAILED');expect(result.items[0].warnings).toEqual(['PROCESSING_INTERRUPTED']);
  });
  it('deletes expired private files before marking metadata',async()=>{
    const h=harness();await h.service.upload(buyer,'order','upload-key-1',file);
    h.claims[0].expiresAt=new Date(0);h.tx.commerceBankReceiptClaim.findMany.mockResolvedValue(h.claims);
    expect(await h.service.cleanupExpired()).toEqual({deleted:1});
    expect(h.storage.remove).toHaveBeenCalledWith(h.claims[0].id);expect(h.claims[0].imageDeletedAt).toBeInstanceOf(Date);
  });
  it('retains deletion retry metadata when private storage removal fails',async()=>{
    const h=harness();await h.service.upload(buyer,'order','upload-key-1',file);
    h.claims[0].expiresAt=new Date(0);h.tx.commerceBankReceiptClaim.findMany.mockResolvedValue(h.claims);h.storage.remove.mockRejectedValue(new Error('busy'));
    expect(await h.service.cleanupExpired()).toEqual({deleted:0});expect(h.claims[0].imageDeletedAt).toBeNull();
  });
  it('returns buyer and exact order facts only in the protected Admin review queue',async()=>{
    const h=harness();await h.service.upload(buyer,'order','admin-context-key',file);
    process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS=buyer;
    h.tx.commerceBankReceiptClaim.findMany.mockResolvedValue(h.claims);
    h.tx.commerceOrder.findMany.mockResolvedValue([{id:'order',orderNumber:'EDU-SYNTHETIC',status:'pending_payment',
      payableAmountMinor:1000n,currency:'VND',buyer:{id:buyer,fullName:'Synthetic buyer',email:'synthetic@example.test'},
      lines:[{productType:'course',displayTitle:'Synthetic course'}]}]);
    const response=await h.service.listAdmin(buyer,{page:1,pageSize:20});
    expect(response.items[0]).toMatchObject({financialProof:false,order:{orderNumber:'EDU-SYNTHETIC',
      payableAmountMinor:'1000',buyer:{fullName:'Synthetic buyer'}}});
    const owned=await h.service.listOwned(buyer,'order');expect(owned.items[0]).not.toHaveProperty('order');
  });  it('yields between structured serialization retries so a competing commit can finish',async()=>{
    jest.useFakeTimers();
    try{const h=harness();const conflict=Object.assign(new Error('TransactionWriteConflict'),{name:'DriverAdapterError',cause:{kind:'TransactionWriteConflict'}});
      h.tx.$transaction.mockRejectedValue(conflict);
      const result=h.service.upload(buyer,'order','backoff-conflict-key',file).catch(error=>error);
      await jest.advanceTimersByTimeAsync(0);expect(h.tx.$transaction).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(25);expect(h.tx.$transaction).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(50);expect(h.tx.$transaction).toHaveBeenCalledTimes(3);
      expect((await result).message).toBe('RECEIPT_CONCURRENT_OPERATION');
    }finally{jest.useRealTimers();}
  });  it('defaults Admin queue to pending orders or still-active early access, with an explicit history view',async()=>{
    const h=harness();process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS=buyer;
    await h.service.listAdmin(buyer,{page:1,pageSize:20});
    const filter=h.tx.commerceBankReceiptClaim.findMany.mock.calls[0][0].where;
    expect(filter).toEqual({order:{OR:[{status:'pending_payment'},{receiptAccessGenerations:{some:{status:'ACCESS_UNVERIFIED'}}}]}});
    expect(h.tx.commerceBankReceiptClaim.count).toHaveBeenCalledWith({where:filter});
    await h.service.listAdmin(buyer,{page:1,pageSize:20,scope:'all'});
    expect(h.tx.commerceBankReceiptClaim.findMany.mock.calls[1][0].where).toEqual({});
  });});
