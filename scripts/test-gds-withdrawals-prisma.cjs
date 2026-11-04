'use strict';
// Disposable CI PostgreSQL only; never loads .env or calls a payment provider.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true', 'CI disposable database required');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { RevenueFinanceService } = require('../dist/src/modules/revenue-sharing/revenue-finance.service.js');
  const { GdsRevenueWalletService } = require('../dist/src/modules/wallet/gds-revenue-wallet.service.js');
  const { GdsWithdrawalService } = require('../dist/src/modules/wallet/gds-withdrawal.service.js');
  const { buildRuntimeGdsPrivilegeStatement, buildRuntimeGdsWithdrawalPrivilegeStatement } = require('./membership-runtime-privileges.cjs');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const revenue = new GdsRevenueWalletService(db, config, new RevenueFinanceService(db));
  const service = new GdsWithdrawalService(db, config, revenue);
  const input = { amountMinor: '150000', bankCode: 'MB', accountNumber: '123456789', accountHolder: 'SYNTHETIC TEST ONLY' };
  const admin = randomUUID(), otherAdmin = randomUUID();
  async function user(opening = 200000n) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${id}@synthetic.invalid`, fullName: 'Synthetic GDS withdrawal' } });
    // Owner-only opening fixtures, confined to the guarded disposable DB above.
    const wallet = await db.gdsInternalWallet.create({ data: { buyerId: id, availableMinor: opening } });
    return { id, wallet };
  }
  async function settle(promise) { return Promise.allSettled(promise); }
  const balance = id => db.gdsInternalWallet.findUniqueOrThrow({ where: { buyerId: id } });
  try {
    await db.user.createMany({ data: [admin, otherAdmin].map(id => ({ id, email: `${id}@synthetic.invalid`, fullName: 'Synthetic GDS operator' })) });
    await db.gdsWithdrawalSettings.update({ where: { id: 'global' }, data: { minimumMinor: 50000n, maximumMinor: 10000000n, admissionEnabled: true, processingEnabled: true } });

    const a = await user();
    const raced = await settle([service.create(a.id, input, randomUUID()), service.create(a.id, input, randomUUID())]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(a.id)).availableMinor, 50000n);
    assert.equal((await balance(a.id)).heldMinor, 150000n);
    console.log('GDS_CONCURRENT_WITHDRAWALS=PASS');

    const b = await user();
    const sameKey = randomUUID();
    const duplicates = await Promise.all([service.create(b.id, input, sameKey), service.create(b.id, input, sameKey)]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    assert.equal(await db.gdsWithdrawal.count({ where: { ownerId: b.id } }), 1);
    assert.equal((await balance(b.id)).heldMinor, 150000n);
    console.log('GDS_IDEMPOTENCY_RACE=PASS');

    const c = await user();
    const orderRef = `ci:competing-checkout:${randomUUID()}`;
    const spendRace = await settle([
      service.create(c.id, input, randomUUID()),
      db.gdsInternalJournal.create({ data: { walletId: c.wallet.id, eventKey: `ci:reserve:${randomUUID()}`, kind: 'RESERVE', amountMinor: 150000n,
        availableDeltaMinor: -150000n, heldDeltaMinor: 150000n, clearingDeltaMinor: 0n, orderRef } }),
    ]);
    assert.equal(spendRace.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(c.id)).availableMinor, 50000n);
    assert.equal((await balance(c.id)).heldMinor, 150000n);
    console.log('GDS_WITHDRAWAL_VS_CHECKOUT_RESERVE=PASS');

    const d = await user();
    const request = await service.create(d.id, input, randomUUID());
    const stateRace = await settle([
      service.act(d.id, request.id, 'cancel', { reason: 'Synthetic owner cancellation' }, true),
      service.act(admin, request.id, 'approve', { reason: 'Synthetic admin approval' }),
    ]);
    assert.equal(stateRace.filter(r => r.status === 'fulfilled').length, 1);
    const state = await db.gdsWithdrawal.findUniqueOrThrow({ where: { id: request.id } });
    if (state.status === 'APPROVED') await service.act(admin, request.id, 'reject', { reason: 'Synthetic cleanup before transfer' });
    assert.equal((await balance(d.id)).availableMinor, 200000n);
    assert.equal((await balance(d.id)).heldMinor, 0n);
    console.log('GDS_CANCEL_VS_APPROVE=PASS');

    const e = await user();
    const payable = await service.create(e.id, input, randomUUID());
    await service.act(admin, payable.id, 'approve', { reason: 'Synthetic account checked' });
    const claims = await settle([service.act(admin, payable.id, 'process', { reason: 'Claim' }), service.act(otherAdmin, payable.id, 'process', { reason: 'Claim' })]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    const claimed = await db.gdsWithdrawal.findUniqueOrThrow({ where: { id: payable.id } });
    const proof = { reason: 'Synthetic bank statement checked', bankTransactionRef: `ci:${randomUUID()}`, transferredAt: new Date().toISOString() };
    await assert.rejects(service.act(e.id, payable.id, 'cancel', { reason: 'Too late' }, true));
    const pays = await settle([service.act(claimed.processingAdminId, payable.id, 'pay', proof), service.act(claimed.processingAdminId, payable.id, 'pay', proof)]);
    assert.equal(pays.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(e.id)).availableMinor, 50000n);
    assert.equal((await balance(e.id)).heldMinor, 0n);
    assert.equal(await db.gdsInternalJournal.count({ where: { orderRef: payable.id, kind: 'WITHDRAWAL_PAID' } }), 1);
    console.log('GDS_TRANSFER_CLAIM_AND_PAID_RACE=PASS');

    // Exercise real Prisma calls under the bounded production-style role.
    const role = `gds_withdraw_${randomUUID().replaceAll('-', '')}`;
    await db.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const statement of [buildRuntimeGdsPrivilegeStatement(`postgresql://${role}@localhost/test`), buildRuntimeGdsWithdrawalPrivilegeStatement(`postgresql://${role}@localhost/test`)].join(';').split(';').filter(x => x.trim())) {
      await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe(`GRANT SELECT ON revenue_earning_periods, revenue_ledger_entries TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT(migration_name,checksum,finished_at,rolled_back_at) ON _prisma_migrations TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON audit_logs TO "${role}"`);
    const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` }) });
    try {
      const runtimeRevenue = new GdsRevenueWalletService(runtime, config, new RevenueFinanceService(runtime));
      const runtimeService = new GdsWithdrawalService(runtime, config, runtimeRevenue);
      const f = await user();
      const created = await runtimeService.create(f.id, { ...input, amountMinor: '50000' }, randomUUID());
      await runtimeService.act(f.id, created.id, 'cancel', { reason: 'Synthetic runtime recovery' }, true);
      assert.equal((await balance(f.id)).availableMinor, 200000n);
      await assert.rejects(runtime.gdsInternalWallet.update({ where: { id: f.wallet.id }, data: { debtMinor: 1n } }));
      await assert.rejects(runtime.gdsWithdrawal.update({ where: { id: created.id }, data: { status: 'PAID' } }));
      console.log('GDS_WITHDRAWAL_RESTRICTED_RUNTIME=PASS');
      const { configureGdsWithdrawals, parseArguments } = require('./configure-gds-withdrawals.cjs');
      const { Client } = require('pg');
      const { execFileSync } = require('node:child_process');
      class RuntimeClient extends Client { constructor(config) { super({ ...config, options: `-c role=${role}` }); } }
      const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
      const activation = await configureGdsWithdrawals(parseArguments(['--action','enable','--minimum','10000','--maximum','10000000','--expected-sha',sha,'--authorize-production-withdrawals']), {
        environment: { NODE_ENV: 'production', DEPLOYMENT_CLASS: 'production', DATABASE_URL: process.env.DATABASE_URL }, ClientConstructor: RuntimeClient,
      });
      assert.equal(activation.minimumMinor, '10000'); assert.equal(activation.admissionEnabled, true);
      console.log('GDS_WITHDRAWAL_OWNER_APPROVED_ACTIVATION=PASS');
    } finally { await runtime.$disconnect(); }
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
