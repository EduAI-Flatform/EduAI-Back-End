import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('Private receipt claim database boundary', () => {
  let db: PGlite;
  let buyer: string; let order: string; let request: string;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active',deleted_at timestamp);
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,buyer_id uuid REFERENCES users(id),status text NOT NULL DEFAULT 'pending_payment');
      CREATE TABLE commerce_bank_transfer_requests(id uuid PRIMARY KEY,order_id uuid UNIQUE REFERENCES commerce_orders(id),status text DEFAULT 'PENDING',expires_at timestamp NOT NULL);`);
    await db.exec(readFileSync(join(__dirname,'migrations/20261023010000_add_bank_receipt_claims/migration.sql'),'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    buyer=randomUUID(); order=randomUUID(); request=randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)',[buyer]);
    await db.query('INSERT INTO commerce_orders(id,buyer_id) VALUES($1,$2)',[order,buyer]);
    await db.query("INSERT INTO commerce_bank_transfer_requests(id,order_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '15 minutes')",[request,order]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  const insert = (overrides: Record<string,unknown>={}) => {
    const v={ id:randomUUID(),buyer,order,request,key:'a'.repeat(64),original:'b'.repeat(64),image:'c'.repeat(64),...overrides };
    return db.query(`INSERT INTO commerce_bank_receipt_claims(id,buyer_id,order_id,request_id,operation_key_hash,original_sha256,image_sha256,width,height,bytes,expires_at,processing_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,100,100,500,CURRENT_TIMESTAMP+INTERVAL '24 hours',CURRENT_TIMESTAMP+INTERVAL '5 minutes') RETURNING id`,[v.id,v.buyer,v.order,v.request,v.key,v.original,v.image]);
  };
  it('accepts claim without any payment mutation', async () => {
    await insert();
    expect((await db.query('SELECT status FROM commerce_orders')).rows).toEqual([{status:'pending_payment'}]);
  });
  it('rejects another buyer claiming the order', async () => {
    const other=randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)',[other]);
    await expect(insert({buyer:other})).rejects.toThrow(/owner/);
  });
  it('rejects duplicate image independently of idempotency key', async () => {
    await insert(); await expect(insert({key:'d'.repeat(64)})).rejects.toThrow(/duplicate key/);
  });
  it('rejects a fourth claim under the order lock', async () => {
    for(const c of ['b','d','e']) await insert({key:c.repeat(64),original:c.repeat(64),image:c.repeat(64)});
    await expect(insert({key:'f'.repeat(64),original:'f'.repeat(64),image:'f'.repeat(64)})).rejects.toThrow(/limit/);
  });
  it('keeps image identities immutable', async () => {
    await insert(); await expect(db.exec("UPDATE commerce_bank_receipt_claims SET original_sha256='"+'f'.repeat(64)+"'")).rejects.toThrow(/immutable/);
  });
  it('keeps terminal assessment immutable', async () => {
    await insert();
    await db.exec("UPDATE commerce_bank_receipt_claims SET status='OCR_FAILED',assessed_at=CURRENT_TIMESTAMP,warnings=ARRAY['OCR_UNAVAILABLE']");
    await expect(db.exec("UPDATE commerce_bank_receipt_claims SET status='MATCHED_CLAIM'")).rejects.toThrow(/terminal/);
  });
  it('rejects closed requests', async () => {
    await db.exec("UPDATE commerce_bank_transfer_requests SET status='PAID'");
    await expect(insert()).rejects.toThrow(/pending/);
  });
  it('prevents the same normalized bank transaction on different claims', async () => {
    const first=await insert();
    const second=await insert({key:'d'.repeat(64),original:'d'.repeat(64),image:'e'.repeat(64)});
    await db.query("UPDATE commerce_bank_receipt_claims SET status='REVIEW_REQUIRED',assessed_at=CURRENT_TIMESTAMP,transaction_key_hash=$1 WHERE id=$2",['f'.repeat(64),(first.rows[0] as any).id]);
    await expect(db.query("UPDATE commerce_bank_receipt_claims SET status='REVIEW_REQUIRED',assessed_at=CURRENT_TIMESTAMP,transaction_key_hash=$1 WHERE id=$2",['f'.repeat(64),(second.rows[0] as any).id])).rejects.toThrow(/duplicate key/);
  });
  it('rejects a matched result without normalized OCR facts and confidence',async()=>{
    await insert();
    await expect(db.exec("UPDATE commerce_bank_receipt_claims SET status='MATCHED_CLAIM',assessed_at=CURRENT_TIMESTAMP")).rejects.toThrow(/check constraint/);
  });
  it('allows deletion marking but never clearing deletion history',async()=>{
    await insert();
    await db.exec("UPDATE commerce_bank_receipt_claims SET image_deleted_at=CURRENT_TIMESTAMP");
    await expect(db.exec("UPDATE commerce_bank_receipt_claims SET image_deleted_at=NULL")).rejects.toThrow(/deletion is immutable/);
  });
  it('never permits deleting receipt metadata',async()=>{
    await insert();await expect(db.exec('DELETE FROM commerce_bank_receipt_claims')).rejects.toThrow(/append only/);
  });
});
