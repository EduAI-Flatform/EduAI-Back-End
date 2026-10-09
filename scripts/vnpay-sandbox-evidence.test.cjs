const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInputs, assertSandbox, assertCanonicalBaseline, assertUnchanged, projectIpnEvidence } = require('./vnpay-sandbox-evidence.cjs');
const orderId = '11111111-1111-4111-8111-111111111111';
const baseline = () => ({ id: orderId, status: 'confirmed', fulfillmentStatus: 'fulfilled', payableAmountMinor: 20000n, currency: 'VND', confirmedSettlementId: 's1', paymentAttempts: [{ id: 'a1', orderId, provider: 'vnpay', status: 'paid', amountMinor: 20000n, currency: 'VND', providerOrderCode: 123n, providerPaymentIdentity: '123', createdAt: new Date(), events: [{ id: 'e1', provider: 'vnpay', nextStatus: 'paid', amountMinor: 20000n, currency: 'VND', providerPaymentIdentity: '123', providerSettlementReference: '999', providerEventIdentity: 'vnpay:ipn-event', receivedAt: new Date() }] }], settlements: [{ id: 's1', orderId, paymentAttemptId: 'a1', paymentEventId: 'e1', provider: 'vnpay', kind: 'provider_collection', disposition: 'matched', amountMinor: 20000n, currency: 'VND', providerSettlementReference: '999' }], fulfillmentEffects: [{ id: 'f1' }] });

test('rejects malformed identity, mode, and revision before runtime loading', () => {
  assert.doesNotThrow(() => validateInputs(orderId, 'inspect', 'a'.repeat(40)));
  for (const args of [['bad', 'inspect', 'a'.repeat(40)], [orderId, 'run', 'a'.repeat(40)], [orderId, 'inspect', 'main']]) assert.throws(() => validateInputs(...args));
});
test('requires exact approved UAT endpoints and deployment class', () => {
  const config = { app: { nodeEnv: 'production', deploymentClass: 'uat' }, vnpay: { environment: 'sandbox', paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html', apiUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction', returnUrl: 'https://eduai.giaoducso.org.vn/payments/return', ipnUrl: 'https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/vnpay' } };
  assert.doesNotThrow(() => assertSandbox(config));
  assert.throws(() => assertSandbox({ ...config, app: { deploymentClass: 'production' } }));
  assert.throws(() => assertSandbox({ ...config, vnpay: { ...config.vnpay, apiUrl: 'https://sandbox.vnpayment.vn.evil.test/transaction' } }));
  assert.throws(() => assertSandbox({ ...config, app: { ...config.app, nodeEnv: 'test' } }));
  assert.throws(() => assertSandbox({ ...config, vnpay: { ...config.vnpay, returnUrl: 'https://other.test/payments/return' } }));
});
test('reconciliation accepts only already fulfilled canonical paid settlement', () => {
  assert.equal(assertCanonicalBaseline(baseline()).id, 'a1');
  for (const field of ['status', 'fulfillmentStatus']) { const order = baseline(); order[field] = 'pending'; assert.throws(() => assertCanonicalBaseline(order)); }
  const wrongAmount = baseline(); wrongAmount.settlements[0].amountMinor = 1n; assert.throws(() => assertCanonicalBaseline(wrongAmount));
  const duplicate = baseline(); duplicate.settlements.push({ ...duplicate.settlements[0], id: 's2' }); assert.throws(() => assertCanonicalBaseline(duplicate));
  const wrongEvent = baseline(); wrongEvent.settlements[0].paymentEventId = 'other'; assert.throws(() => assertCanonicalBaseline(wrongEvent));
});
test('financial rows and identities must remain unchanged after QueryDR', () => {
  const before = baseline();
  assert.doesNotThrow(() => assertUnchanged(before, structuredClone(before)));
  const after = structuredClone(before); after.paymentAttempts[0].events.push({ id: 'new-event' }); assert.throws(() => assertUnchanged(before, after));
  const changed = structuredClone(before); changed.settlements[0].amountMinor = 1n; assert.throws(() => assertUnchanged(before, changed));
});

test('IPN evidence requires verified matching paid facts and redacts unrelated logs and sensitive fields', () => {
  const attempt = baseline().paymentAttempts[0];
  const evidence = { event: 'vnpay_ipn_verified', txnRef: '123', transactionNo: '999', amountMinor: '20000', currency: 'VND', responseCode: '00', transactionStatus: '00', acknowledgmentCode: '00', signatureValid: true, merchantVerified: true };
  const actualLog = { ...evidence, event: undefined, message: 'vnpay_ipn_verified', context: 'VnPayIpnService', timestamp: '2026-10-09T12:00:00.000Z', level: 'log' };
  const logs = ['unrelated secret diagnostic', JSON.stringify({ ...actualLog, txnRef: 'other', token: 'sensitive' }), JSON.stringify({ ...actualLog, signatureValid: false }), JSON.stringify({ ...actualLog, secureHash: 'sensitive', secret: 'sensitive' })].join('\n');
  assert.deepEqual(projectIpnEvidence(logs, attempt), [{ ...evidence, timestamp: actualLog.timestamp }]);
  for (const change of [{ amountMinor: '1' }, { transactionNo: 'other' }, { transactionStatus: '02' }, { acknowledgmentCode: '02' }, { merchantVerified: false }, { context: 'WrongService' }]) assert.deepEqual(projectIpnEvidence(JSON.stringify({ ...actualLog, ...change }), attempt), []);
});
