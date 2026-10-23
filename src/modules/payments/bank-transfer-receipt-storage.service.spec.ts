import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BankReceiptStorageService } from './bank-transfer-receipt-storage.service';

describe('private synthetic receipt storage', () => {
  let root: string;
  const previous = { root:process.env.BANK_RECEIPT_STORAGE_ROOT, flag:process.env.BANK_RECEIPT_SANDBOX_ENABLED };
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'eduai-receipt-test-')); process.env.BANK_RECEIPT_STORAGE_ROOT=root; process.env.BANK_RECEIPT_SANDBOX_ENABLED='true'; });
  afterEach(async () => { if (!root.startsWith(join(tmpdir(), 'eduai-receipt-test-'))) throw new Error('Unsafe fixture cleanup'); await rm(root, {recursive:true,force:true}); });
  afterAll(() => { for (const [key, value] of Object.entries({BANK_RECEIPT_STORAGE_ROOT:previous.root,BANK_RECEIPT_SANDBOX_ENABLED:previous.flag})) {
    if (value === undefined) delete process.env[key]; else process.env[key]=value;
  } });
  const storage = (nodeEnv='test') => new BankReceiptStorageService({app:{nodeEnv}} as any);
  it('stores private bytes, retries same bytes idempotently, and removes them', async () => {
    const id=randomUUID(); const image=Buffer.from('synthetic canonical PNG bytes'); const service=storage();
    await service.put(id,image); await service.put(id,image);
    expect(await service.read(id)).toEqual(image);
    await expect(service.put(id,Buffer.from('different'))).rejects.toThrow('RECEIPT_STORAGE_CONFLICT');
    await service.remove(id); await service.remove(id);
    await expect(service.read(id)).rejects.toThrow('RECEIPT_IMAGE_UNAVAILABLE');
  });
  it.each(['../escape','/tmp/path','invalid','00000000-0000-0000-0000-000000000000'])('rejects untrusted object identifier %s', async (id) => {
    await expect(storage().read(id)).rejects.toThrow('RECEIPT_IMAGE_UNAVAILABLE');
    await expect(storage().put(id,Buffer.from('x'))).rejects.toThrow('RECEIPT_IMAGE_UNAVAILABLE');
  });
  it('denies production and disabled storage before file IO', async () => {
    const id=randomUUID(); await expect(storage('production').put(id,Buffer.from('x'))).rejects.toThrow('RECEIPT_SANDBOX_DISABLED');
    delete process.env.BANK_RECEIPT_SANDBOX_ENABLED;
    await expect(storage().put(id,Buffer.from('x'))).rejects.toThrow('RECEIPT_SANDBOX_DISABLED');
  });
  it('rejects a storage root inside the app working directory', async () => {
    process.env.BANK_RECEIPT_STORAGE_ROOT=join(process.cwd(),'public','receipts');
    await expect(storage().put(randomUUID(),Buffer.from('x'))).rejects.toThrow('RECEIPT_STORAGE_NOT_PRIVATE');
  });
  it('rejects symbolic links in ancestor directories',async()=>{
    const target=join(root,'ancestor');const link=join(root,'ancestor-link');await mkdir(target);await symlink(target,link,'junction');
    process.env.BANK_RECEIPT_STORAGE_ROOT=join(link,'receipts');
    await expect(storage().put(randomUUID(),Buffer.from('private image'))).rejects.toThrow('RECEIPT_STORAGE_NOT_PRIVATE');
  });  it('rejects a symbolic-link storage root', async () => {
    const target=join(root,'actual'); const link=join(root,'linked'); await mkdir(target);
    await symlink(target,link,'junction'); process.env.BANK_RECEIPT_STORAGE_ROOT=link;
    await expect(storage().put(randomUUID(),Buffer.from('private image'))).rejects.toThrow('RECEIPT_STORAGE_NOT_PRIVATE');
  });
});