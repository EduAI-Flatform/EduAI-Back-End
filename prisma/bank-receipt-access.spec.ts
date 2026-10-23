import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('Unverified access database provenance',()=>{
  let db:PGlite; let ids:Record<string,string>;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`CREATE TYPE course_access_source_type AS ENUM('course_purchase','membership');
      CREATE TABLE users(id uuid PRIMARY KEY,status text DEFAULT 'active',deleted_at timestamp);
      CREATE TABLE roles(id uuid PRIMARY KEY,name text); CREATE TABLE user_roles(user_id uuid,role_id uuid);
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,buyer_id uuid,status text DEFAULT 'pending_payment',confirmed_settlement_id uuid,payable_amount_minor bigint DEFAULT 1000,currency text DEFAULT 'VND');
      CREATE TABLE commerce_order_lines(id uuid PRIMARY KEY,order_id uuid,product_type text,product_reference_id uuid);
      CREATE TABLE commerce_bank_receipt_claims(id uuid PRIMARY KEY,order_id uuid,buyer_id uuid,status text DEFAULT 'MATCHED_CLAIM');
      CREATE TABLE commerce_settlements(id uuid PRIMARY KEY,order_id uuid,disposition text,kind text,amount_minor bigint,currency text);
      CREATE TABLE course_access_grants(id uuid PRIMARY KEY,user_id uuid,course_id uuid,source_type course_access_source_type,source_id text,status text DEFAULT 'active');
      CREATE TABLE service_entitlement_grants(id uuid PRIMARY KEY,user_id uuid,source_type text,source_id text,status text DEFAULT 'active');
      CREATE TABLE membership_subscriptions(id uuid PRIMARY KEY,user_id uuid,source_order_line_id uuid,status text DEFAULT 'active');`);
    await db.exec(readFileSync(join(__dirname,'migrations/20261023020000_add_receipt_access/migration.sql'),'utf8'));
  },30_000);
  afterAll(async()=>{await db.close();});
  beforeEach(async()=>{
    ids=Object.fromEntries(['buyer','other','order','line','claim','generation','course','resource'].map(k=>[k,randomUUID()]));
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1),($2)',[ids.buyer,ids.other]);
    await db.query('INSERT INTO commerce_orders(id,buyer_id) VALUES($1,$2)',[ids.order,ids.buyer]);
    await db.query("INSERT INTO commerce_order_lines(id,order_id,product_type,product_reference_id) VALUES($1,$2,'course',$3)",[ids.line,ids.order,ids.course]);
    await db.query('INSERT INTO commerce_bank_receipt_claims(id,order_id,buyer_id) VALUES($1,$2,$3)',[ids.claim,ids.order,ids.buyer]);
  });
  afterEach(async()=>{await db.exec('ROLLBACK');});
  const generation=(buyer=ids.buyer)=>db.query(`INSERT INTO commerce_receipt_access_generations(id,order_id,claim_id,buyer_id,created_by_id,generation,access_starts_at)
    VALUES($1,$2,$3,$4,$4,1,CURRENT_TIMESTAMP)`,[ids.generation,ids.order,ids.claim,buyer]);
  it('binds generation to exact claim/order owner',async()=>{
    await expect(generation(ids.other)).rejects.toThrow(/owner/);
  });
  it('rejects marking receipt access paid without canonical settlement',async()=>{
    await generation();
    await expect(db.exec("UPDATE commerce_receipt_access_generations SET status='VERIFIED_PAID',closed_at=CURRENT_TIMESTAMP")).rejects.toThrow(/canonical/);
  });
  it('keeps access provenance immutable',async()=>{
    await generation();await expect(db.query('UPDATE commerce_receipt_access_generations SET claim_id=$1',[randomUUID()])).rejects.toThrow(/immutable/);
  });
  it('rejects orphan unverified course grants at commit boundary',async()=>{
    await generation();
    await db.query("INSERT INTO course_access_grants(id,user_id,course_id,source_type,source_id) VALUES($1,$2,$3,'unverified_receipt_access',$4)",[ids.resource,ids.buyer,ids.course,ids.generation+':'+ids.line]);
    await expect(db.exec('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/ledger/);
  });
  it('retains exact immutable effect and leaves payment pending',async()=>{
    await generation();
    await db.query("INSERT INTO course_access_grants(id,user_id,course_id,source_type,source_id) VALUES($1,$2,$3,'unverified_receipt_access',$4)",[ids.resource,ids.buyer,ids.course,ids.generation+':'+ids.line]);
    await db.query("INSERT INTO commerce_receipt_access_effects(id,generation_id,order_line_id,effect_kind,resource_type,resource_id) VALUES($1,$2,$3,'COURSE_ACCESS','course_access_grant',$4)",[randomUUID(),ids.generation,ids.line,ids.resource]);
    await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
    expect((await db.query('SELECT status FROM commerce_orders')).rows).toEqual([{status:'pending_payment'}]);
    await expect(db.exec('DELETE FROM commerce_receipt_access_effects')).rejects.toThrow(/append only/);
  });
});
