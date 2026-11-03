/** Bounded UAT recovery. Defaults to a read-only dry-run; never creates PayOS links. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PayOS } = require('@payos/node');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { PayosPaymentProvider } = require('../dist/src/modules/payments/payos-payment.provider');
const { GdsInternalJournalService } = require('../dist/src/modules/wallet/gds-internal-journal.service');
const { GdsPayosInboxService } = require('../dist/src/modules/wallet/gds-payos-inbox.service');
const { reconcileSignedGdsPayosTopup } = require('../dist/src/modules/wallet/gds-payos-reconciliation');

async function main() {
  const args = process.argv.slice(2);
  const memos = [];
  let apply = false, uat = false, expectedAmount, maxTotal;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--apply') apply = true;
    else if (option === '--uat') uat = true;
    else if (option === '--memo') memos.push(args[++i]);
    else if (option === '--expected-amount') expectedAmount = args[++i];
    else if (option === '--max-total') maxTotal = args[++i];
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  if (!uat || !memos.length || memos.length > 2 || new Set(memos).size !== memos.length ||
      memos.some(memo => typeof memo !== 'string' || !/^G[A-Z0-9]{8}$/.test(memo)) ||
      !/^[1-9]\d{0,7}$/.test(expectedAmount ?? '') || !/^[1-9]\d{0,7}$/.test(maxTotal ?? '')) {
    throw new Error('EXPLICIT_BOUNDED_UAT_SCOPE_REQUIRED');
  }
  const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
  if (!['development', 'test'].includes(env.NODE_ENV) || env.DEPLOYMENT_CLASS === 'production' ||
      env.PAYOS_ENVIRONMENT !== 'production' || !env.DATABASE_URL ||
      !env.PAYOS_CLIENT_ID || !env.PAYOS_API_KEY || !env.PAYOS_CHECKSUM_KEY) {
    throw new Error('ISOLATED_UAT_CONFIGURATION_REQUIRED');
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  try {
    const migrationName = '20261103020000_add_gds_payos_settlement_reconciliation';
    const checksum = createHash('sha256').update(fs.readFileSync(path.join(__dirname,
      '../prisma/migrations', migrationName, 'migration.sql'))).digest('hex');
    const migration = await db.$queryRawUnsafe(
      'SELECT checksum FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', migrationName);
    if (migration.length !== 1 || migration[0].checksum !== checksum) throw new Error('REVIEWED_MIGRATION_REQUIRED');
    const topups = await db.gdsInternalTopup.findMany({ where: { transferMemo: { in: memos } }, include: { payosInbox: true } });
    if (topups.length !== memos.length || new Set(topups.map(t => t.transferMemo)).size !== memos.length ||
        new Set(topups.map(t => t.buyerId)).size !== 1 ||
        topups.some(t => t.amountMinor !== BigInt(expectedAmount) || t.currency !== 'VND') ||
        topups.reduce((sum, t) => sum + t.amountMinor, 0n) > BigInt(maxTotal)) {
      throw new Error('EXACT_INTENT_SCOPE_MISMATCH');
    }
    const sdk = new PayOS({ clientId: env.PAYOS_CLIENT_ID, apiKey: env.PAYOS_API_KEY,
      checksumKey: env.PAYOS_CHECKSUM_KEY, baseURL: 'https://api-merchant.payos.vn',
      logger: null, logLevel: 'off', maxRetries: 0, timeout: 10000 });
    const provider = new PayosPaymentProvider(sdk);
    const config = { app: { nodeEnv: env.NODE_ENV, deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
    const service = new GdsPayosInboxService(db, config, provider, new GdsInternalJournalService(db, config));
    const scope = [];
    for (let index = 0; index < memos.length; index++) {
      const topup = topups.find(t => t.transferMemo === memos[index]);
      const existingProof = await db.gdsInternalPayosReconciliation.findUnique({ where: { topupId: topup.id } });
      if (topup.status === 'CREDITED' && existingProof) {
        const journal = await db.gdsInternalJournal.findUnique({ where: { topupId: topup.id } });
        if (!journal || journal.kind !== 'TOPUP_CREDIT' || journal.amountMinor !== topup.amountMinor ||
            journal.collectionReference !== existingProof.providerEventIdentity ||
            topup.collectionReference !== existingProof.providerEventIdentity ||
            topup.receivingAccountHash !== existingProof.qrReceivingAccountHash ||
            topup.settlementReceivingAccountHash !== existingProof.settlementReceivingAccountHash) {
          throw new Error('EXISTING_CREDIT_EVIDENCE_MISMATCH');
        }
        console.log(JSON.stringify({ case: index + 1, status: 'ALREADY_CREDITED', noWrite: true }));
        continue;
      }
      const candidates = topup.payosInbox.filter(i => i.status === 'REVIEW' &&
        i.reviewReason === 'SIGNED_IDENTITY_OR_TERMINAL_CONFLICT');
      if (topup.status !== 'PENDING_PAYOS' || candidates.length !== 1 || existingProof) {
        throw new Error('EXACT_REVIEW_STATE_REQUIRED');
      }
      const inbox = candidates[0];
      await reconcileSignedGdsPayosTopup({ ...topup, currency: 'VND', partnerCreditEventId: null }, {
        provider: 'payos', providerCode: '00', responseCode: '00',
        providerOrderReference: inbox.payosOrderCode.toString(), localOrderReference: Number(inbox.payosOrderCode),
        providerPaymentIdentity: inbox.paymentLinkId, providerEventIdentity: inbox.providerEventIdentity,
        providerSettlementReference: inbox.providerEventIdentity, amountMinor: inbox.amountMinor,
        currency: inbox.currency, receivingAccount: inbox.receivingAccount, occurredAt: inbox.occurredAt,
        ...(inbox.virtualReceivingAccountHash ? { verifiedVirtualAccountHash: inbox.virtualReceivingAccountHash } : {}),
      }, { provider, sandboxEnabled: true, nodeEnv: env.NODE_ENV, deploymentClass: 'uat', now: () => new Date() }, inbox.signatureVerifiedAt);
      scope.push({ index, topup, inbox });
      console.log(JSON.stringify({ case: index + 1, status: 'VERIFIED_DRY_RUN', amountMinor: topup.amountMinor.toString(), write: false }));
    }
    // Verify every scoped transfer before any write; service queries PayOS again during apply.
    if (apply) {
      for (const { index, topup, inbox } of scope) {
        const outcome = await service.processReviewed(inbox.id);
        const current = await db.gdsInternalTopup.findUniqueOrThrow({ where: { id: topup.id } });
        const journal = await db.gdsInternalJournal.findUnique({ where: { topupId: topup.id } });
        const proof = await db.gdsInternalPayosReconciliation.findUnique({ where: { topupId: topup.id } });
        if (outcome !== 'PROCESSED' || current.status !== 'CREDITED' || !journal || !proof ||
            journal.amountMinor !== topup.amountMinor || journal.collectionReference !== inbox.providerEventIdentity ||
            proof.inboxId !== inbox.id || current.receivingAccountHash !== topup.receivingAccountHash) {
          throw new Error('RECOVERY_NOT_CONFIRMED');
        }
        console.log(JSON.stringify({ case: index + 1, status: 'CREDITED_VERIFIED', amountMinor: journal.amountMinor.toString(),
          proofRecorded: true, qrBindingUnchanged: true, originalInboxUnchanged: true }));
      }
    }
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  const reason = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)
    ? error.message : 'RECONCILIATION_OR_STORAGE_FAILURE';
  console.error(JSON.stringify({ stopped: true, reason })); process.exitCode = 1;
});
