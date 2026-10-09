const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function validateInputs(orderId, mode, sha) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId || '') || !['inspect', 'reconcile'].includes(mode) || !/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Invalid bounded evidence inputs');
}
function assertSandbox(config) {
  if (config.app.nodeEnv !== 'production' || config.app.deploymentClass !== 'uat' || config.vnpay.environment !== 'sandbox' || config.vnpay.paymentUrl !== 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html' || config.vnpay.apiUrl !== 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction' || config.vnpay.returnUrl !== 'https://eduai.giaoducso.org.vn/payments/return' || config.vnpay.ipnUrl !== 'https://api.eduai.giaoducso.org.vn/api/v1/payments/webhooks/vnpay') throw new Error('Approved sandbox UAT configuration required');
}
function assertCanonicalBaseline(order) {
  if (!order || order.status !== 'confirmed' || order.fulfillmentStatus !== 'fulfilled' || order.currency !== 'VND' || order.payableAmountMinor <= 0n || order.settlements.length !== 1 || order.paymentAttempts.length !== 1 || !order.fulfillmentEffects.length) throw new Error('Already fulfilled single-settlement order required');
  const attempt = order.paymentAttempts[0];
  const settlement = order.settlements[0];
  const event = attempt.events[0];
  if (attempt.events.length !== 1 || attempt.provider !== 'vnpay' || attempt.status !== 'paid' || attempt.orderId !== order.id || attempt.providerOrderCode == null || attempt.providerPaymentIdentity !== String(attempt.providerOrderCode) || settlement.id !== order.confirmedSettlementId || settlement.orderId !== order.id || settlement.paymentAttemptId !== attempt.id || settlement.paymentEventId !== event?.id || settlement.provider !== 'vnpay' || settlement.kind !== 'provider_collection' || settlement.disposition !== 'matched' || event.provider !== 'vnpay' || event.nextStatus !== 'paid' || event.providerPaymentIdentity !== attempt.providerPaymentIdentity || !/^[0-9]{1,15}$/.test(event.providerSettlementReference || '') || event.providerSettlementReference !== settlement.providerSettlementReference || [attempt, settlement, event].some((row) => row.currency !== 'VND' || row.amountMinor !== order.payableAmountMinor)) throw new Error('Canonical payment facts do not match');
  // QueryDR and IPN have distinct event digests despite sharing the vnpay prefix.
  const queryDigest = createHash('sha256').update(['vnpay-querydr-event-v1', attempt.providerPaymentIdentity, event.providerSettlementReference, event.amountMinor.toString(), '00', '00'].join('|')).digest('hex');
  if (event.providerEventIdentity === `vnpay:${queryDigest}`) throw new Error('Baseline must predate QueryDR settlement evidence');
  return attempt;
}
function financialSnapshot(order) {
  return { status: order.status, fulfillmentStatus: order.fulfillmentStatus, confirmedSettlementId: order.confirmedSettlementId, attempts: order.paymentAttempts.map(({ id, status, providerPaymentIdentity, events }) => ({ id, status, providerPaymentIdentity, events })), settlements: order.settlements, effects: order.fulfillmentEffects };
}
function assertUnchanged(before, after) {
  if (!isDeepStrictEqual(financialSnapshot(before), financialSnapshot(after))) throw new Error('Financial evidence changed during QueryDR');
}
function projectIpnEvidence(logs, attempt) {
  const event = attempt.events[0];
  return logs.split(/\r?\n/).flatMap((line) => {
    const start = line.indexOf('{');
    if (start < 0) return [];
    try {
      const item = JSON.parse(line.slice(start));
      if (item.message !== 'vnpay_ipn_verified' || item.context !== 'VnPayIpnService' || !Number.isFinite(Date.parse(item.timestamp)) || item.txnRef !== attempt.providerPaymentIdentity || item.transactionNo !== event.providerSettlementReference || item.amountMinor !== attempt.amountMinor.toString() || item.currency !== 'VND' || item.responseCode !== '00' || item.transactionStatus !== '00' || item.acknowledgmentCode !== '00' || item.signatureValid !== true || item.merchantVerified !== true) return [];
      return [{ event: item.message, timestamp: new Date(item.timestamp).toISOString(), txnRef: item.txnRef, transactionNo: item.transactionNo, amountMinor: item.amountMinor, currency: 'VND', responseCode: '00', transactionStatus: '00', acknowledgmentCode: '00', signatureValid: true, merchantVerified: true }];
    } catch { return []; }
  }).slice(-1);
}
const orderInclude = {
  paymentAttempts: { orderBy: { id: 'asc' }, include: { events: { orderBy: { id: 'asc' } } } },
  settlements: { orderBy: { id: 'asc' } },
  fulfillmentEffects: { orderBy: { id: 'asc' } },
};
function projectOrder(order) {
  if (!order) throw new Error('Requested order not found');
  return { orderId: order.id, orderNumber: order.orderNumber, status: order.status, fulfillmentStatus: order.fulfillmentStatus, amountMinor: order.payableAmountMinor.toString(), currency: order.currency, confirmedAt: order.confirmedAt, attempts: order.paymentAttempts.map((attempt) => ({ id: attempt.id, provider: attempt.provider, status: attempt.status, createdAt: attempt.createdAt, providerStatusCheckedAt: attempt.providerStatusCheckedAt, events: attempt.events.map((event) => ({ id: event.id, nextStatus: event.nextStatus, amountMinor: event.amountMinor.toString(), currency: event.currency, receivedAt: event.receivedAt })) })), settlements: order.settlements.map((settlement) => ({ id: settlement.id, paymentAttemptId: settlement.paymentAttemptId, paymentEventId: settlement.paymentEventId, amountMinor: settlement.amountMinor.toString(), currency: settlement.currency, kind: settlement.kind, disposition: settlement.disposition, settledAt: settlement.settledAt, recordedAt: settlement.recordedAt })), counts: { paymentEvents: order.paymentAttempts.reduce((count, attempt) => count + attempt.events.length, 0), settlements: order.settlements.length, fulfillmentEffects: order.fulfillmentEffects.length } };
}
async function main() {
  const [orderId, mode, sha] = process.argv.slice(2);
  validateInputs(orderId, mode, sha);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sha) throw new Error('Deployed source revision mismatch');
  require('dotenv').config({ quiet: true });
  const load = (path) => require(`../dist/src/${path}`);
  const { ConfigService } = require('@nestjs/config');
  const config = new (load('config/app-config.service').AppConfigService)(new ConfigService(load('config/configuration').default()));
  assertSandbox(config);
  const prisma = new (load('prisma/prisma.service').PrismaService)();
  try {
    await prisma.$connect();
    const before = await prisma.commerceOrder.findUnique({ where: { id: orderId }, include: orderInclude });
    console.log(JSON.stringify({ phase: 'beforeQueryDr', revision: sha, order: projectOrder(before) }));
    if (mode === 'inspect') return;
    const attempt = assertCanonicalBaseline(before);
    const ipn = projectIpnEvidence(execFileSync('pm2', ['logs', 'eduai-backend', '--lines', '3000', '--nostream'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }), attempt);
    if (!ipn.length) throw new Error('Matching verified successful IPN runtime evidence required');
    console.log(JSON.stringify({ phase: 'verifiedIpnBeforeQueryDr', evidence: ipn[0] }));
    const audit = new (load('common/audit/audit.service').AuditService)(prisma);
    const courseAccess = new (load('modules/access/course-access.service').CourseAccessService)(prisma);
    const notifications = new (load('modules/notifications/notifications.service').NotificationsService)(prisma);
    const { CommerceFulfillmentService } = load('modules/payments/commerce-fulfillment.service');
    class BoundedFulfillment extends CommerceFulfillmentService {
      async dispatchPending() { /* Existing runtime owns notification delivery; never drain unrelated rows. */ }
    }
    const fulfillment = new BoundedFulfillment(prisma, courseAccess, audit, notifications);
    const disabled = new (load('modules/payments/disabled-payment.provider').DisabledPaymentProvider)();
    const vnpay = new (load('modules/payments/vnpay-payment.provider').VnPayPaymentProvider)(config.vnpay);
    const registry = new (load('modules/payments/payment-provider.registry').DefaultPaymentProviderRegistry)({ defaultProvider: 'vnpay', providers: { payos: disabled, vnpay }, enabled: { payos: false, vnpay: true }, disabled });
    const webhook = new (load('modules/payments/payment-webhook.service').PaymentWebhookService)(prisma, audit, config, disabled, fulfillment);
    const monitoring = new (load('common/monitoring/monitoring.service').MonitoringService)(config);
    const reconciliation = new (load('modules/payments/payment-reconciliation.service').PaymentReconciliationService)(prisma, audit, config, disabled, webhook, fulfillment, monitoring, undefined, registry);
    const result = await reconciliation.recoverVnPayAttemptForLifecycle(attempt);
    const after = await prisma.commerceOrder.findUnique({ where: { id: orderId }, include: orderInclude });
    assertUnchanged(before, after);
    const observation = result.observation;
    console.log(JSON.stringify({ phase: 'afterQueryDr', financialRowsUnchanged: true, outcome: result.outcome, query: observation && { provider: observation.provider, trusted: observation.trusted, queryRequestStatus: observation.queryRequestStatus, transactionStatus: observation.transactionStatus, amountMinor: observation.amountMinor?.toString(), currency: observation.currency, paidAt: observation.paidAt, responseCode: observation.responseCode, transactionStatusCode: observation.transactionStatusCode }, order: projectOrder(after) }));
    if (result.outcome !== 'paid' || !observation || observation.trusted !== true || observation.queryRequestStatus !== 'success' || observation.transactionStatus !== 'paid') throw new Error('QueryDR did not confirm trusted paid status');
  } finally { await prisma.$disconnect(); }
}
module.exports = { validateInputs, assertSandbox, assertCanonicalBaseline, assertUnchanged, projectIpnEvidence };
if (require.main === module) main().catch(() => { console.error('Bounded VNPay evidence failed; no credentials or raw provider data emitted.'); process.exitCode = 1; });
