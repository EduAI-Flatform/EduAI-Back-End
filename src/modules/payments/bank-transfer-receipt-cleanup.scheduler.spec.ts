import { BankReceiptCleanupScheduler } from './bank-transfer-receipt-cleanup.scheduler';

describe('synthetic receipt retention scheduler',()=>{
  const saved={bank:process.env.BANK_TRANSFER_SANDBOX_ENABLED,receipt:process.env.BANK_RECEIPT_SANDBOX_ENABLED};
  beforeEach(()=>{jest.useFakeTimers();process.env.BANK_TRANSFER_SANDBOX_ENABLED='true';process.env.BANK_RECEIPT_SANDBOX_ENABLED='true';});
  afterEach(()=>{jest.useRealTimers();});
  afterAll(()=>{for(const [key,value] of Object.entries({BANK_TRANSFER_SANDBOX_ENABLED:saved.bank,BANK_RECEIPT_SANDBOX_ENABLED:saved.receipt})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  it.each(['production','staging'])('does not read the receipt DB in %s',async(nodeEnv)=>{
    const service={cleanupExpired:jest.fn()};const scheduler=new BankReceiptCleanupScheduler(service as never,{app:{nodeEnv}} as never);
    scheduler.onApplicationBootstrap();await jest.advanceTimersByTimeAsync(120000);expect(service.cleanupExpired).not.toHaveBeenCalled();scheduler.onApplicationShutdown();
  });
  it('cleans immediately and every minute, then cancels timer',async()=>{
    const service={cleanupExpired:jest.fn().mockResolvedValue({deleted:0})};const scheduler=new BankReceiptCleanupScheduler(service as never,{app:{nodeEnv:'test'}} as never);
    scheduler.onApplicationBootstrap();await jest.advanceTimersByTimeAsync(60000);expect(service.cleanupExpired).toHaveBeenCalledTimes(2);
    scheduler.onApplicationShutdown();await jest.advanceTimersByTimeAsync(60000);expect(service.cleanupExpired).toHaveBeenCalledTimes(2);
  });
  it('does not overlap a slow cleanup job',async()=>{
    let done!:(v:{deleted:number})=>void;const service={cleanupExpired:jest.fn().mockImplementation(()=>new Promise(resolve=>{done=resolve;}))};
    const scheduler=new BankReceiptCleanupScheduler(service as never,{app:{nodeEnv:'test'}} as never);
    scheduler.onApplicationBootstrap();await jest.advanceTimersByTimeAsync(120000);expect(service.cleanupExpired).toHaveBeenCalledTimes(1);
    done({deleted:0});await Promise.resolve();scheduler.onApplicationShutdown();
  });
});
