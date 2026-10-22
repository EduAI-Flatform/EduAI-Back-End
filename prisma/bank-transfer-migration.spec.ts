import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');

describe('Manual bank settlement provenance on PostgreSQL', () => {
  let db: PGlite;
  let id: Record<string, string>;
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    const root = join(__dirname, 'migrations');
    for (const directory of readdirSync(root).sort()) {
      const path = join(root, directory, 'migration.sql');
      if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    }
  }, 120_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    id = Object.fromEntries(['seller','buyer','admin1','admin2','role','course','product','order','line','attempt','request','evidence','event','settlement','pendingOp','paidOp','confirmedOp'].map(k => [k,randomUUID()]));
    await db.exec('BEGIN');
    await db.exec(`
      INSERT INTO users(id,email,password_hash,full_name,updated_at) VALUES
        ('${id.seller}','seller@example.test','hash','Seller',CURRENT_TIMESTAMP),
        ('${id.buyer}','buyer@example.test','hash','Buyer',CURRENT_TIMESTAMP),
        ('${id.admin1}','admin1@example.test','hash','Admin 1',CURRENT_TIMESTAMP),
        ('${id.admin2}','admin2@example.test','hash','Admin 2',CURRENT_TIMESTAMP);
      INSERT INTO roles(id,name,updated_at) VALUES('${id.role}','platform_admin',CURRENT_TIMESTAMP);
      INSERT INTO user_roles(user_id,role_id) VALUES ('${id.admin1}','${id.role}'),('${id.admin2}','${id.role}');
      INSERT INTO courses(id,instructor_id,title,slug,level,status,visibility,price_amount_minor,price_currency,updated_at)
        VALUES('${id.course}','${id.seller}','Bank fixture','bank-fixture','beginner','published','public',1000,'VND',CURRENT_TIMESTAMP);
      INSERT INTO commerce_products(id,type,course_id,seller_id,status,updated_at)
        VALUES('${id.product}','course','${id.course}','${id.seller}','draft',CURRENT_TIMESTAMP);
      UPDATE commerce_products SET status='active' WHERE id='${id.product}';
      INSERT INTO commerce_orders(id,order_number,buyer_id,status,fulfillment_status,subtotal_amount_minor,discount_amount_minor,payable_amount_minor,currency,pricing_policy_version,updated_at)
        VALUES('${id.order}','BANK-TEST','${id.buyer}','pending_payment','not_started',1000,0,1000,'VND','v1',CURRENT_TIMESTAMP);
      INSERT INTO commerce_order_lines(id,order_id,product_id,product_type,product_reference_id,seller_id,display_title,quantity,unit_list_price_amount_minor,subtotal_amount_minor,discount_amount_minor,final_amount_minor,currency)
        VALUES('${id.line}','${id.order}','${id.product}','course','${id.course}','${id.seller}','Bank fixture',1,1000,1000,0,1000,'VND');
      INSERT INTO commerce_payment_attempts(id,order_id,provider,local_request_identity,provider_payment_identity,status,amount_minor,currency,updated_at)
        VALUES('${id.attempt}','${id.order}','bank_transfer','${randomUUID()}','${id.request}','created',1000,'VND',CURRENT_TIMESTAMP);
      UPDATE commerce_payment_attempts SET status='pending',status_operation_id='${id.pendingOp}' WHERE id='${id.attempt}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id)
        VALUES('payment','${id.attempt}','created','pending','system','${id.pendingOp}');
      INSERT INTO commerce_bank_transfer_requests(id,order_id,payment_attempt_id,bank_name,bank_bin,account_number,beneficiary_name,transfer_content,amount_minor,created_at,expires_at)
        VALUES('${id.request}','${id.order}','${id.attempt}','TEST BANK','970422','0000000000','SANDBOX ONLY','EDUAIBANKTEST',1000,CURRENT_TIMESTAMP-INTERVAL '1 minute',CURRENT_TIMESTAMP+INTERVAL '15 minutes');
      UPDATE commerce_bank_transfer_requests SET status='UNDER_REVIEW' WHERE id='${id.request}';
    `);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  const evidence = async (overrides: Record<string,string> = {}) => {
    const v = { bank:"'970422'", account:"'0000000000'", amount:'1000', content:"'EDUAIBANKTEST'", occurred:"CURRENT_TIMESTAMP-INTERVAL '30 seconds'", exception:'NULL', transaction:"'BANK-TXN-1'", ...overrides };
    await db.exec(`INSERT INTO commerce_bank_statement_evidence(id,request_id,bank_bin,account_number,transaction_id,amount_minor,transfer_content,occurred_at,statement_reference,statement_sha256,recorded_by_id,exception_reason)
      VALUES('${id.evidence}','${id.request}',${v.bank},${v.account},${v.transaction},${v.amount},${v.content},${v.occurred},'synthetic://statement-1','${'a'.repeat(64)}','${id.admin1}',${v.exception})`);
  };
  const approvals = async (count=2) => {
    for (const actor of [id.admin1,id.admin2].slice(0,count)) await db.exec(`INSERT INTO commerce_bank_approvals(evidence_id,actor_id) VALUES('${id.evidence}','${actor}')`);
  };
  const event = async () => db.exec(`INSERT INTO commerce_payment_events(id,payment_attempt_id,provider,provider_event_identity,provider_payment_identity,provider_settlement_reference,amount_minor,currency,next_status,provider_occurred_at)
    SELECT '${id.event}','${id.attempt}','bank_transfer','${id.evidence}','${id.request}','${id.evidence}',1000,'VND','paid',occurred_at FROM commerce_bank_statement_evidence WHERE id='${id.evidence}'`);
  const settlement = async (settledAt = "(SELECT occurred_at FROM commerce_bank_statement_evidence WHERE id='" + id.evidence + "')") => db.exec(`INSERT INTO commerce_settlements(id,order_id,payment_attempt_id,payment_event_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency,settled_at)
    VALUES('${id.settlement}','${id.order}','${id.attempt}','${id.event}','provider_collection','matched','bank_transfer','${id.evidence}',1000,'VND',${settledAt})`);

  it('accepts two independent active admins and canonical settlement before paid/order confirmation', async () => {
    await evidence(); await approvals(); await event(); await settlement();
    await db.exec(`
      UPDATE commerce_payment_attempts SET status='paid',status_operation_id='${id.paidOp}',paid_at=CURRENT_TIMESTAMP WHERE id='${id.attempt}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id)
        VALUES('payment','${id.attempt}','pending','paid','system','${id.paidOp}');
      UPDATE commerce_bank_transfer_requests SET status='PAID' WHERE id='${id.request}';
      UPDATE commerce_orders SET status='confirmed',confirmed_settlement_id='${id.settlement}',confirmed_at=CURRENT_TIMESTAMP,status_operation_id='${id.confirmedOp}' WHERE id='${id.order}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id)
        VALUES('order','${id.order}','pending_payment','confirmed','system','${id.confirmedOp}');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    expect((await db.query<{status:string}>(`SELECT status FROM commerce_bank_transfer_requests WHERE id='${id.request}'`)).rows).toEqual([{status:'PAID'}]);
    expect((await db.query('SELECT * FROM commerce_settlements')).rows).toHaveLength(1);
  });
  it.each([
    ['underpayment',{amount:'999'}], ['overpayment',{amount:'1001'}],
    ['wrong account',{account:"'0000000001'"}], ['wrong bank',{bank:"'970436'"}],
    ['wrong reference',{content:"'WRONG'"}], ['before request',{occurred:"CURRENT_TIMESTAMP-INTERVAL '2 minutes'"}],
    ['after expiry',{occurred:"CURRENT_TIMESTAMP+INTERVAL '16 minutes'"}],
    ['future occurrence',{occurred:"CURRENT_TIMESTAMP+INTERVAL '1 minute'"}], ['suspected evidence',{exception:"'SUSPECTED'"}],
  ])('rejects %s even with two approvals', async (_name,changes) => {
    await evidence(changes as Record<string,string>); await approvals(); await event();
    await expect(settlement()).rejects.toThrow(/bank settlement requires/);
  });
  it('rejects one-admin settlement', async () => {
    await evidence(); await approvals(1); await event(); await expect(settlement()).rejects.toThrow(/bank settlement requires/);
  });
  it('rejects the same admin approving twice', async () => {
    await evidence(); await approvals(1); await expect(approvals(1)).rejects.toThrow(/duplicate key/);
  });
  it('rejects approval from a buyer without finance authority', async () => {
    await evidence(); await expect(db.exec(`INSERT INTO commerce_bank_approvals(evidence_id,actor_id) VALUES('${id.evidence}','${id.buyer}')`)).rejects.toThrow(/active platform admin/);
  });
  it('rechecks admin authority at settlement after approval', async () => {
    await evidence(); await approvals(); await event(); await db.exec(`UPDATE users SET status='suspended' WHERE id='${id.admin2}'`);
    await expect(settlement()).rejects.toThrow(/bank settlement requires/);
  });
  it.each(['EXPIRED','CANCELLED','NEEDS_SUPPORT'])('rejects settlement for request state %s', async status => {
    await evidence(); await approvals(); await event(); await db.exec(`UPDATE commerce_bank_transfer_requests SET status='${status}' WHERE id='${id.request}'`);
    await expect(settlement()).rejects.toThrow(/bank settlement requires/);
  });
  it('rejects direct PAID request without canonical settlement', async () => {
    await expect(db.exec(`UPDATE commerce_bank_transfer_requests SET status='PAID' WHERE id='${id.request}'`)).rejects.toThrow(/canonical settlement/);
  });
  it('rejects direct fulfillment while order is unpaid', async () => {
    await expect(db.exec(`UPDATE commerce_orders SET fulfillment_status='processing',fulfillment_operation_id='${randomUUID()}' WHERE id='${id.order}'`)).rejects.toThrow();
  });
  it.each(['amount_minor=1001',"account_number='0000000001'","transfer_content='OTHER'","expires_at=expires_at+INTERVAL '1 minute'"])('keeps request snapshot immutable: %s', async change => {
    await expect(db.exec(`UPDATE commerce_bank_transfer_requests SET ${change} WHERE id='${id.request}'`)).rejects.toThrow(/snapshot is immutable/);
  });
  it.each(['UPDATE commerce_bank_statement_evidence SET amount_minor=999','DELETE FROM commerce_bank_statement_evidence'])('keeps evidence append-only: %s', async sql => {
    await evidence(); await expect(db.exec(sql)).rejects.toThrow(/append only/);
  });
  it.each(['UPDATE commerce_bank_approvals SET approved_at=CURRENT_TIMESTAMP','DELETE FROM commerce_bank_approvals'])('keeps approvals append-only: %s', async sql => {
    await evidence(); await approvals(); await expect(db.exec(sql)).rejects.toThrow(/append only/);
  });
  it('reserves normalized bank transaction identity only once', async () => {
    await evidence(); id.evidence=randomUUID(); await expect(evidence()).rejects.toThrow(/duplicate key/);
  });
  it.each(["'bank-txn-1'","' BANK-TXN-1 '"])('rejects noncanonical transaction identity %s', async transaction => {
    await expect(evidence({transaction})).rejects.toThrow(/check constraint/);
  });
  it('rejects replaying canonical settlement', async () => {
    await evidence(); await approvals(); await event(); await settlement(); id.settlement=randomUUID(); await expect(settlement()).rejects.toThrow(/duplicate key/);
  });
  it('rejects a forged paid attempt even with a matching lifecycle event', async () => {
    await expect(db.exec(`UPDATE commerce_payment_attempts SET status='paid',status_operation_id='${id.paidOp}',paid_at=CURRENT_TIMESTAMP WHERE id='${id.attempt}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id)
        VALUES('payment','${id.attempt}','pending','paid','system','${id.paidOp}');
      SET CONSTRAINTS ALL IMMEDIATE;`)).rejects.toThrow(/evidence/);
  });
  it.each(['PAID','UNDER_REVIEW','EXPIRED','CANCELLED'])('rejects forged initial request state %s', async state => {
    await expect(db.exec(`INSERT INTO commerce_bank_transfer_requests
      SELECT '${randomUUID()}',order_id,payment_attempt_id,bank_name,bank_bin,account_number,beneficiary_name,'FORGED',amount_minor,'${state}',created_at,expires_at
      FROM commerce_bank_transfer_requests WHERE id='${id.request}'`)).rejects.toThrow(/bind pending matching/);
  });
  it('rejects a pending request bound to another payment identity', async () => {
    await expect(db.exec(`INSERT INTO commerce_bank_transfer_requests
      SELECT '${randomUUID()}',order_id,payment_attempt_id,bank_name,bank_bin,account_number,beneficiary_name,'FORGED',amount_minor,'PENDING',created_at,expires_at
      FROM commerce_bank_transfer_requests WHERE id='${id.request}'`)).rejects.toThrow(/bind pending matching/);
  });
  it('cannot reopen a cancelled request', async () => {
    await db.exec(`UPDATE commerce_bank_transfer_requests SET status='CANCELLED' WHERE id='${id.request}'`);
    await expect(db.exec(`UPDATE commerce_bank_transfer_requests SET status='UNDER_REVIEW' WHERE id='${id.request}'`)).rejects.toThrow(/invalid bank request transition/);
  });
  it('cannot remove a bank request snapshot', async () => {
    await expect(db.exec(`DELETE FROM commerce_bank_transfer_requests WHERE id='${id.request}'`)).rejects.toThrow(/cannot be deleted/);
  });
  it.each(['UPDATE commerce_bank_support_requests SET reason=\'changed reason\'','DELETE FROM commerce_bank_support_requests'])('keeps buyer support append-only: %s', async sql => {
    await db.exec(`INSERT INTO commerce_bank_support_requests(id,request_id,actor_id,reason,operation_key_hash)
      VALUES('${randomUUID()}','${id.request}','${id.buyer}','Please investigate this payment','${'b'.repeat(64)}')`);
    await expect(db.exec(sql)).rejects.toThrow(/append only/);
  });
  it('rejects a settlement timestamp different from the actual bank occurrence', async () => {
    await evidence(); await approvals(); await event();
    await expect(settlement('CURRENT_TIMESTAMP')).rejects.toThrow(/bank settlement requires/);
  });
});
