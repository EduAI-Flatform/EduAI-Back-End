'use strict';
// Called only by the disposable-local-PostgreSQL harness after its safety checks/migrations.
const assert = require('node:assert/strict');
module.exports = async function receiptAccessConcurrency(context) {
  const { clients, pool, ids, prepareReceipt, receiptFile, receiptServices, facts, key } = context;
  const { BankReceiptAccessService } = require('../dist/src/modules/payments/bank-receipt-access.service.js');
  const { CourseAccessService } = require('../dist/src/modules/access/course-access.service.js');
  const { CommerceFulfillmentService } = require('../dist/src/modules/payments/commerce-fulfillment.service.js');
  const { BankTransferService } = require('../dist/src/modules/payments/bank-transfer.service.js');
  const access = []; const banks = [];
  for (const client of clients) {
    const config = { app: { nodeEnv: 'test' } };
    const audit = { record: async (input, tx) => tx.auditLog.create({ data: { actorKind: input.actorKind ?? 'USER',
      actorId: input.actorId ?? null, action: input.action, targetType: input.target.type,
      targetId: input.target.id, metadataJson: input.metadata ?? {} } }) };
    const course = new CourseAccessService(client, config);
    const service = new BankReceiptAccessService(client, course, audit, config);
    const fulfillment = new CommerceFulfillmentService(client, course, audit, { createForUser: async () => {} }, service);
    access.push(service); banks.push(new BankTransferService(client, config, audit, fulfillment));
  }
  process.env.BANK_RECEIPT_SYNTHETIC_SELLER_IDS = ids.seller;
  process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED = 'true';
  const fixture = await prepareReceipt();
  const file = await receiptFile(fixture.bankRequest, '#193a8e');
  const claim = await receiptServices[0].upload(ids.buyer, fixture.orderId, key(), file);
  assert.equal(claim.status, 'MATCHED_CLAIM');
  const grants = await Promise.all(access.map(service => service.grantForClaim(ids.buyer, claim.id)));
  assert.equal(grants[0].generationId, grants[1].generationId);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM commerce_receipt_access_generations WHERE order_id=$1', [fixture.orderId])).rows[0].n), 1);
  assert.equal((await pool.query('SELECT status FROM commerce_orders WHERE id=$1', [fixture.orderId])).rows[0].status, 'pending_payment');
  console.log('PASS concurrent full receipt grant is idempotent and nonfinancial');
  const revokeKey = key();
  await Promise.all(access.map(service => service.revoke(ids.admin1, claim.id, revokeKey, { reason: 'Synthetic receipt access revoked', expectedGeneration: 1 })));
  assert.equal((await access[0].describeClaim(ids.buyer, claim.id)).state, 'REVOKED');
  const restoreKey = key();
  const restores = await Promise.all(access.map(service => service.restore(ids.admin1, claim.id, restoreKey, { reason: 'Synthetic corrected receipt access', expectedGeneration: 1 })));
  assert.equal(restores[0].generation, 2); assert.equal(restores[0].generationId, restores[1].generationId);
  const windows = (await pool.query('SELECT access_starts_at FROM commerce_receipt_access_generations WHERE order_id=$1 ORDER BY generation', [fixture.orderId])).rows;
  assert.equal(windows[0].access_starts_at.getTime(), windows[1].access_starts_at.getTime());
  console.log('PASS concurrent source-exact revoke and restore retain original access window');
  const f = facts(fixture.bankRequest);
  const evidence = await banks[0].recordStatement(ids.admin1, fixture.bankRequest.id, key(), f);
  await banks[0].approve(ids.admin1, evidence.id, key(), f);
  const outcomes = await Promise.allSettled([
    banks[1].approve(ids.admin2, evidence.id, key(), f),
    access[0].revoke(ids.admin1, claim.id, key(), { reason: 'Synthetic payment race revocation', expectedGeneration: 2 }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  const state = await access[0].describeClaim(ids.buyer, claim.id);
  assert.equal(state.state, 'VERIFIED_PAID');
  const sources = (await pool.query('SELECT source_type::text,status::text FROM course_access_grants WHERE user_id=$1 AND source_id IN (SELECT id::text FROM commerce_order_lines WHERE order_id=$2)', [ids.buyer, fixture.orderId])).rows;
  assert.deepEqual(sources, [{ source_type: 'course_purchase', status: 'active' }]);
  const early = (await pool.query("SELECT c.status::text FROM course_access_grants c JOIN commerce_receipt_access_effects e ON e.resource_id=c.id JOIN commerce_receipt_access_generations g ON g.id=e.generation_id WHERE g.order_id=$1", [fixture.orderId])).rows;
  assert.ok(early.length === 2 && early.every(row => row.status === 'revoked'));
  await assert.rejects(access[0].revoke(ids.admin1, claim.id, key(), { reason: 'Synthetic late revocation attempt', expectedGeneration: 2 }), /ORDER_ALREADY_VERIFIED/);
  console.log('PASS real dual-approval payment versus receipt revocation preserves canonical purchase access');
  delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
};