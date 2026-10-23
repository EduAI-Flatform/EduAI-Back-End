'use strict';
// Disposable CI PostgreSQL only. This script never loads dotenv or application config.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');

async function main() {
  const raw = process.env.PAYW_TEST_DATABASE_URL;
  assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.ok(raw, 'PAYW_TEST_DATABASE_URL required');
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Local CI database only');
  assert.equal(url.pathname, '/eduai_payw_ci', 'Dedicated disposable database required');
  assert.equal(url.search, '', 'Connection overrides are forbidden');
  const pool = new Pool({ connectionString: raw, max: 8 });
  const clients = [];
  try {
    const schema = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.equal(schema.rowCount, 0, 'Refusing a nonempty database');
    const root = join(__dirname, '../prisma/migrations');
    for (const directory of readdirSync(root).sort()) {
      const path = join(root, directory, 'migration.sql');
      if (existsSync(path)) await pool.query(readFileSync(path, 'utf8'));
    }
    // Distinct backends are observed before starting concurrent service transactions.
    const a = await pool.connect(); const b = await pool.connect();
    try {
      const pids = await Promise.all([a.query('SELECT pg_backend_pid() AS pid'), b.query('SELECT pg_backend_pid() AS pid')]);
      assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);
    } finally { a.release(); b.release(); }
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { PrismaClient } = require('../dist/generated/prisma/client.js');
    const { BankTransferService } = require('../dist/src/modules/payments/bank-transfer.service.js');
    const { BankReceiptService } = require('../dist/src/modules/payments/bank-transfer-receipt.service.js');
    const { decodeReceiptImage } = require('../dist/src/modules/payments/bank-transfer-receipt-image.js');
    const sharp = require('sharp');
    const { requireBankTransferProof } = require('../dist/src/modules/payments/bank-transfer-proof.js');
    const ids = Object.fromEntries(['seller','buyer','admin1','admin2','role','course','product'].map(k => [k,randomUUID()]));
    process.env.BANK_TRANSFER_SANDBOX_ENABLED = 'true';
    process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS = [ids.admin1,ids.admin2].join(',');
    process.env.BANK_RECEIPT_SANDBOX_ENABLED = 'true';
    process.env.BANK_RECEIPT_SYNTHETIC_BUYER_IDS = ids.buyer;
    await pool.query(`INSERT INTO users(id,email,password_hash,full_name,updated_at) VALUES
      ($1,'seller@example.test','hash','Seller',NOW()),($2,'buyer@example.test','hash','Buyer',NOW()),
      ($3,'admin1@example.test','hash','Admin 1',NOW()),($4,'admin2@example.test','hash','Admin 2',NOW())`, [ids.seller,ids.buyer,ids.admin1,ids.admin2]);
    await pool.query("INSERT INTO roles(id,name,updated_at) VALUES($1,'platform_admin',NOW())",[ids.role]);
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$3),($2,$3)',[ids.admin1,ids.admin2,ids.role]);
    await pool.query(`INSERT INTO courses(id,instructor_id,title,slug,level,status,visibility,price_amount_minor,price_currency,updated_at)
      VALUES($1,$2,'Bank concurrency','bank-concurrency','beginner','published','public',1000,'VND',NOW())`,[ids.course,ids.seller]);
    await pool.query("INSERT INTO commerce_products(id,type,course_id,seller_id,status,updated_at) VALUES($1,'course',$2,$3,'draft',NOW())",[ids.product,ids.course,ids.seller]);
    await pool.query("UPDATE commerce_products SET status='active' WHERE id=$1",[ids.product]);
    // Marker represents the idempotent fulfillment boundary, never a real enrollment.
    await pool.query('CREATE TABLE payw_test_fulfillment_markers(settlement_id uuid PRIMARY KEY REFERENCES commerce_settlements(id),order_id uuid NOT NULL)');
    const services = [];
    const receiptServices = [];
    const receiptOcrOutputs = new Map();
    const receiptImages = new Map();
    const receiptStorage = {
      put: async (id, buffer) => { receiptImages.set(id, Buffer.from(buffer)); },
      read: async id => receiptImages.get(id),
      remove: async id => { receiptImages.delete(id); },
    };
    const receiptOcr = { assess: async buffer => {
      const result=receiptOcrOutputs.get(createHash('sha256').update(buffer).digest('hex'));
      assert.ok(result, 'Every OCR image must be an explicitly registered synthetic fixture');
      return result;
    } };
    for (let i=0;i<2;i++) {
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 4 }) });
      await client.$connect(); clients.push(client);
      const audit = { record: async (input, tx) => tx.auditLog.create({data:{actorKind:input.actorKind ?? 'USER',actorId:input.actorId ?? null,action:input.action,targetType:input.target.type,targetId:input.target.id,metadataJson:input.metadata ?? {}}}) };
      const fulfillment = { fulfillConfirmedPayment: async (orderId, settlementId) => client.$transaction(async tx => {
        await requireBankTransferProof(tx, orderId, settlementId);
        await tx.$executeRawUnsafe('INSERT INTO payw_test_fulfillment_markers(settlement_id,order_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING',settlementId,orderId);
      }) };
      services.push(new BankTransferService(client,{app:{nodeEnv:'test'}},audit,fulfillment));
      receiptServices.push(new BankReceiptService(client,{app:{nodeEnv:'test'}},audit,receiptStorage,receiptOcr));
    }
    const order = async () => {
      const oid=randomUUID(); const connection=await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(`INSERT INTO commerce_orders(id,order_number,buyer_id,status,fulfillment_status,subtotal_amount_minor,discount_amount_minor,payable_amount_minor,currency,pricing_policy_version,updated_at)
          VALUES($1,$2,$3,'pending_payment','not_started',1000,0,1000,'VND','v1',NOW())`,[oid,'RACE'+oid.replace(/-/g,''),ids.buyer]);
        await connection.query(`INSERT INTO commerce_order_lines(id,order_id,product_id,product_type,product_reference_id,seller_id,display_title,quantity,unit_list_price_amount_minor,subtotal_amount_minor,discount_amount_minor,final_amount_minor,currency)
          VALUES($1,$2,$3,'course',$4,$5,'Bank concurrency',1,1000,1000,0,1000,'VND')`,[randomUUID(),oid,ids.product,ids.course,ids.seller]);
        await connection.query('COMMIT');
      } catch(e) { await connection.query('ROLLBACK'); throw e; } finally {connection.release();}
      return oid;
    };
    const key=()=>randomUUID();
    const request = async oid => (await pool.query('SELECT * FROM commerce_bank_transfer_requests WHERE order_id=$1',[oid])).rows[0];
    const facts = r => ({bankBin:r.bank_bin,accountNumber:r.account_number,transactionId:'TXN-'+randomUUID().toUpperCase(),amountMinor:'1000',transferContent:r.transfer_content,occurredAt:new Date().toISOString(),statementReference:'synthetic://ci-statement',statementSha256:createHash('sha256').update(r.id).digest('hex'),source:'BANK_STATEMENT_CHECKED'});
    const count = async (table, oid) => Number((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE order_id=$1`,[oid])).rows[0].count);
    const prepare = async () => { const oid=await order(); await services[0].create(ids.buyer,oid,key()); const r=await request(oid); const f=facts(r); const e=await services[0].recordStatement(ids.admin1,r.id,key(),f); return {oid,r,f,e}; };

    const oid=await order(); const createKey=key();
    const creates=await Promise.all(services.map(s=>s.create(ids.buyer,oid,createKey)));
    assert.equal(creates[0].payment.id,creates[1].payment.id);
    assert.equal(await count('commerce_payment_attempts',oid),1);
    assert.equal(await count('commerce_bank_transfer_requests',oid),1);
    console.log('PASS concurrent create idempotency');

    const supportKey=key();
    await Promise.all(services.map(s=>s.support(ids.buyer,oid,supportKey,'Synthetic support request only')));
    assert.equal(await count('commerce_settlements',oid),0);
    assert.equal(await count('payw_test_fulfillment_markers',oid),0);
    const supportCount=await pool.query('SELECT count(*)::int AS count FROM commerce_bank_support_requests WHERE request_id=$1',[(await request(oid)).id]);
    assert.equal(supportCount.rows[0].count,1);
    console.log('PASS support replay never settles');

    const prepareReceipt = async () => {
      const orderId=await order(); await services[0].create(ids.buyer,orderId,key());
      return { orderId, bankRequest:await request(orderId) };
    };
    const receiptFile = async (bankRequest, color, transactionId=null, compressionLevel=9) => {
      const buffer=await sharp({create:{width:64,height:64,channels:3,background:color}}).png({compressionLevel}).toBuffer();
      const file={buffer,size:buffer.length,mimetype:'image/png'};
      const image=await decodeReceiptImage(file);
      receiptOcrOutputs.set(image.imageSha256,{confidence:99,warnings:[],fields:{
        bankBin:bankRequest.bank_bin,accountNumber:bankRequest.account_number,beneficiaryName:bankRequest.beneficiary_name,
        amountMinor:bankRequest.amount_minor.toString(),transferContent:bankRequest.transfer_content,
        occurredAt:new Date().toISOString(),transactionId,
      }});
      return file;
    };
    const assertReceiptNonfinancial = async orderId => {
      assert.equal(await count('commerce_settlements',orderId),0);
      assert.equal(await count('payw_test_fulfillment_markers',orderId),0);
      const state=(await pool.query('SELECT status,fulfillment_status,confirmed_settlement_id FROM commerce_orders WHERE id=$1',[orderId])).rows[0];
      assert.deepEqual(state,{status:'pending_payment',fulfillment_status:'not_started',confirmed_settlement_id:null});
      const attempt=(await pool.query('SELECT status FROM commerce_payment_attempts WHERE order_id=$1',[orderId])).rows;
      assert.deepEqual(attempt,[{status:'pending'}]);
    };
    const entitlementCounts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM course_access_grants) AS course_grants,
      (SELECT count(*)::int FROM membership_subscriptions) AS memberships,
      (SELECT count(*)::int FROM service_entitlement_grants) AS service_grants`)).rows[0];
    const beforeReceiptEntitlements=await entitlementCounts();

    const replayReceipt=await prepareReceipt();
    const replayFile=await receiptFile(replayReceipt.bankRequest,'#110011'); const replayKey=key();
    const receiptReplay=await Promise.all(receiptServices.map(service=>service.upload(ids.buyer,replayReceipt.orderId,replayKey,replayFile)));
    assert.equal(receiptReplay[0].id,receiptReplay[1].id);
    assert.equal(await count('commerce_bank_receipt_claims',replayReceipt.orderId),1);
    const replayState=(await pool.query('SELECT status FROM commerce_bank_receipt_claims WHERE order_id=$1',[replayReceipt.orderId])).rows[0];
    assert.equal(replayState.status,'MATCHED_CLAIM');
    await assertReceiptNonfinancial(replayReceipt.orderId);
    console.log('PASS receipt concurrent same-key replay creates one nonfinancial claim');

    const cappedReceipt=await prepareReceipt();
    const cappedFiles=await Promise.all(['#220001','#220002','#220003','#220004'].map(color=>receiptFile(cappedReceipt.bankRequest,color)));
    const cappedResults=await Promise.allSettled(cappedFiles.map((file,index)=>receiptServices[index%2].upload(ids.buyer,cappedReceipt.orderId,key(),file)));
    const cappedSuccesses=cappedResults.filter(result=>result.status==='fulfilled').length;
    assert.ok(cappedSuccesses>=1 && cappedSuccesses<=3);
    assert.ok(cappedResults.some(result=>result.status==='rejected'));
    for(const result of cappedResults) {
      if(result.status==='rejected') assert.ok(result.reason?.code==='P2034' || /RECEIPT_UPLOAD_LIMIT|RECEIPT_CONCURRENT_OPERATION/.test(result.reason?.message ?? ''),
        'Competing receipt uploads may reject only for the upload cap or bounded serialization retry exhaustion');
    }
    let cappedCount=await count('commerce_bank_receipt_claims',cappedReceipt.orderId);
    assert.ok(cappedCount>=1 && cappedCount<=3);
    // Retry exhaustion is allowed under contention; it must never evade the DB cap.
    // Complete remaining capacity sequentially, then prove a fresh fourth claim fails.
    for(let fill=0;fill<3 && cappedCount<3;fill++) {
      const fillFile=await receiptFile(cappedReceipt.bankRequest,['#225500','#225501','#225502'][fill]);
      await receiptServices[0].upload(ids.buyer,cappedReceipt.orderId,key(),fillFile);
      cappedCount=await count('commerce_bank_receipt_claims',cappedReceipt.orderId);
    }
    const fourthFile=await receiptFile(cappedReceipt.bankRequest,'#22ffff');
    await assert.rejects(receiptServices[0].upload(ids.buyer,cappedReceipt.orderId,key(),fourthFile),/RECEIPT_UPLOAD_LIMIT/);
    assert.equal(await count('commerce_bank_receipt_claims',cappedReceipt.orderId),3);
    await assertReceiptNonfinancial(cappedReceipt.orderId);
    console.log('PASS receipt four-way competing uploads never exceed three-claim limit');

    const canonicalA=await prepareReceipt(); const canonicalB=await prepareReceipt();
    const canonicalFileA=await receiptFile(canonicalA.bankRequest,'#330033',null,0);
    const canonicalFileB=await receiptFile(canonicalB.bankRequest,'#330033',null,9);
    assert.notEqual(createHash('sha256').update(canonicalFileA.buffer).digest('hex'),createHash('sha256').update(canonicalFileB.buffer).digest('hex'));
    assert.equal((await decodeReceiptImage(canonicalFileA)).imageSha256,(await decodeReceiptImage(canonicalFileB)).imageSha256);
    const canonicalCollision=await Promise.allSettled([
      receiptServices[0].upload(ids.buyer,canonicalA.orderId,key(),canonicalFileA),
      receiptServices[1].upload(ids.buyer,canonicalB.orderId,key(),canonicalFileB),
    ]);
    assert.equal(canonicalCollision.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(canonicalCollision.filter(result=>result.status==='rejected').length,1);
    assert.equal(await count('commerce_bank_receipt_claims',canonicalA.orderId)+await count('commerce_bank_receipt_claims',canonicalB.orderId),1);
    await assertReceiptNonfinancial(canonicalA.orderId); await assertReceiptNonfinancial(canonicalB.orderId);
    console.log('PASS receipt cross-order canonical image replay rejected despite different PNG encodings');

    for(let receiptRace=0;receiptRace<10;receiptRace++) {
    const transactionA=await prepareReceipt(); const transactionB=await prepareReceipt();
    const receiptTransactionId='RECEIPT-TX-'+randomUUID().toUpperCase();
    const transactionFileA=await receiptFile(transactionA.bankRequest,'#44'+receiptRace.toString(16).padStart(2,'0')+'01',receiptTransactionId);
    const transactionFileB=await receiptFile(transactionB.bankRequest,'#44'+receiptRace.toString(16).padStart(2,'0')+'02',receiptTransactionId);
    const transactionClaims=await Promise.all([
      receiptServices[0].upload(ids.buyer,transactionA.orderId,key(),transactionFileA),
      receiptServices[1].upload(ids.buyer,transactionB.orderId,key(),transactionFileB),
    ]);
    assert.deepEqual(transactionClaims.map(claim=>claim.status).sort(),['MATCHED_CLAIM','REVIEW_REQUIRED']);
    assert.ok(transactionClaims.some(claim=>claim.warnings.includes('TRANSACTION_REUSED')));
    const transactionRows=(await pool.query('SELECT transaction_key_hash FROM commerce_bank_receipt_claims WHERE order_id=ANY($1::uuid[])',[[transactionA.orderId,transactionB.orderId]])).rows;
    assert.equal(transactionRows.length,2);assert.equal(transactionRows.filter(row=>row.transaction_key_hash!==null).length,1);
    await assertReceiptNonfinancial(transactionA.orderId);await assertReceiptNonfinancial(transactionB.orderId);
    assert.deepEqual(await entitlementCounts(),beforeReceiptEntitlements);
    console.log('PASS receipt scoped transaction replay requires review; no settlements, fulfillment or entitlements created');

    }

    const same = await prepare();
    const repeats=await Promise.all(services.map(s=>s.approve(ids.admin1,same.e.id,key(),same.f)));
    assert.ok(repeats.every(r=>r.status==='UNDER_REVIEW'));
    const approvals=await pool.query('SELECT count(*)::int AS count FROM commerce_bank_approvals WHERE evidence_id=$1',[same.e.id]);
    assert.equal(approvals.rows[0].count,1); assert.equal(await count('commerce_settlements',same.oid),0);
    console.log('PASS same actor concurrent approval counts once');

    const dual=await prepare();
    await Promise.all([services[0].approve(ids.admin1,dual.e.id,key(),dual.f),services[1].approve(ids.admin2,dual.e.id,key(),dual.f)]);
    assert.equal(await count('commerce_settlements',dual.oid),1);
    assert.equal(await count('payw_test_fulfillment_markers',dual.oid),1);
    const events=await pool.query('SELECT count(*)::int AS count FROM commerce_payment_events WHERE payment_attempt_id=$1',[dual.r.payment_attempt_id]);
    assert.equal(events.rows[0].count,1);
    await Promise.all(services.map((s,i)=>s.approve(i?ids.admin2:ids.admin1,dual.e.id,key(),dual.f)));
    assert.equal(await count('commerce_settlements',dual.oid),1); assert.equal(await count('payw_test_fulfillment_markers',dual.oid),1);
    console.log('PASS distinct concurrent approvals and canonical replay settle/fulfill once');

    const first=await prepare(); const otherId=await order(); await services[0].create(ids.buyer,otherId,key()); const other=await request(otherId);
    const shared='TXN-'+randomUUID().toUpperCase(); const f1={...facts(first.r),transactionId:shared}; const f2={...facts(other),transactionId:shared};
    const collision=await Promise.allSettled([services[0].recordStatement(ids.admin1,first.r.id,key(),f1),services[1].recordStatement(ids.admin2,other.id,key(),f2)]);
    assert.equal(collision.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(collision.filter(r=>r.status==='rejected').length,1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM commerce_bank_statement_evidence WHERE transaction_id=$1',[shared])).rows[0].count,1);
    assert.equal(await count('commerce_settlements',first.oid),0); assert.equal(await count('commerce_settlements',otherId),0);
    console.log('PASS cross-order bank transaction collision');

    // Repeat the cancel/second-approval race; either serialized winner is valid.
    for(let i=0;i<5;i++) {
      const race=await prepare(); await services[0].approve(ids.admin1,race.e.id,key(),race.f);
      const results=await Promise.allSettled([services[0].cancel(ids.buyer,race.oid,key()),services[1].approve(ids.admin2,race.e.id,key(),race.f)]);
      assert.ok(results.some(r=>r.status==='fulfilled'));
      const state=await request(race.oid); const n=await count('commerce_settlements',race.oid); const m=await count('payw_test_fulfillment_markers',race.oid);
      assert.ok(['PAID','CANCELLED'].includes(state.status));
      assert.equal(n,state.status==='PAID'?1:0); assert.equal(m,n);
      const actual=(await pool.query('SELECT status FROM commerce_orders WHERE id=$1',[race.oid])).rows[0].status;
      assert.equal(actual,state.status==='PAID'?'confirmed':'cancelled');
    }
    console.log('PASS cancel versus approval races (5 iterations)');
    await require('./test-receipt-quota-concurrency.cjs')(pool);
    await require('./test-receipt-access-concurrency.cjs')({clients,pool,ids,prepareReceipt,receiptFile,receiptServices,facts,key});
    await require('./test-receipt-membership-concurrency.cjs')({clients,pool,ids,receiptStorage,receiptOcr,receiptFile,facts,key});
    console.log('PAYW_POSTGRES_CONCURRENCY=PASS; live PostgreSQL, two independent Prisma clients, 4 receipt race scenarios, synthetic money only');
  } finally {
    for(const client of clients) await client.$disconnect();
    await pool.end();
  }
}
main().catch(error => { console.error('PAYW_POSTGRES_CONCURRENCY=FAIL',error.name,error.code ?? '',error.message); process.exitCode=1; });
