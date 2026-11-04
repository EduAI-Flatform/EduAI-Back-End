import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { buildRuntimeGdsWithdrawalPrivilegeStatement } = require('../scripts/membership-runtime-privileges.cjs');

describe('GDS withdrawal PostgreSQL invariants (synthetic data only)', () => {
  let db: PGlite;
  let ownerId: string;
  let adminId: string;
  let otherAdminId: string;
  let walletId: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,status text NOT NULL,payable_amount_minor bigint NOT NULL,currency text NOT NULL,confirmed_settlement_id uuid);
      CREATE TABLE commerce_settlements(id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES commerce_orders(id),amount_minor bigint NOT NULL,
        currency text NOT NULL,kind text NOT NULL,disposition text NOT NULL);
      CREATE TABLE revenue_order_snapshots(id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES commerce_orders(id));
      CREATE TABLE revenue_earning_periods(id uuid PRIMARY KEY, seller_id uuid NOT NULL REFERENCES users(id),
        snapshot_id uuid NOT NULL REFERENCES revenue_order_snapshots(id),amount_minor bigint NOT NULL,due_at timestamp(3) NOT NULL);
      CREATE TABLE revenue_ledger_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period_id uuid NOT NULL REFERENCES revenue_earning_periods(id),
        kind varchar(30) NOT NULL, amount_minor bigint NOT NULL, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    for (const migration of [
      '20261102030000_add_gds_internal_prepaid_journal',
      '20261103040000_harden_gds_runtime_projection',
      '20261104100000_add_gds_withdrawals',
    ]) {
      try { await db.exec(readFileSync(join(__dirname, 'migrations', migration, 'migration.sql'), 'utf8')); }
      catch (error) {
        const detail = error as Error & { internalQuery?: string; internalPosition?: string; where?: string };
        throw new Error(`${migration}: ${detail.message}; ${detail.where ?? ''}; ${detail.internalQuery ?? ''}; ${detail.internalPosition ?? ''}`);
      }
    }
    await db.exec(`CREATE ROLE gds_withdrawal_test_runtime NOLOGIN;
      GRANT USAGE ON SCHEMA public TO gds_withdrawal_test_runtime;
      GRANT SELECT,INSERT ON gds_internal_wallets TO gds_withdrawal_test_runtime;
      GRANT UPDATE(updated_at) ON gds_internal_wallets TO gds_withdrawal_test_runtime;
      GRANT SELECT ON revenue_earning_periods,revenue_ledger_entries,revenue_order_snapshots,
        commerce_orders,commerce_settlements TO gds_withdrawal_test_runtime;`);
    await db.exec(buildRuntimeGdsWithdrawalPrivilegeStatement('postgresql://gds_withdrawal_test_runtime:unused@localhost/synthetic'));
  }, 30_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    ownerId = randomUUID(); adminId = randomUUID(); otherAdminId = randomUUID(); walletId = randomUUID();
    await db.exec('BEGIN');
    for (const id of [ownerId, adminId, otherAdminId]) await db.query('INSERT INTO users(id) VALUES($1)', [id]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [walletId, ownerId]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function rejected(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT expected_rejection');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT expected_rejection; RELEASE SAVEPOINT expected_rejection'); }
  }
  async function balance() {
    const result = await db.query<{ available: string; held: string; debt: string }>(
      'SELECT available_minor::text AS available,held_minor::text AS held,debt_minor::text AS debt FROM gds_internal_wallets WHERE id=$1', [walletId]);
    return result.rows[0];
  }
  async function enable() {
    await db.exec("UPDATE gds_withdrawal_settings SET admission_enabled=true,processing_enabled=true WHERE id='global'");
  }
  async function credit(amount = 200000) {
    const topupId = randomUUID();
    await db.query(`INSERT INTO gds_internal_topups
      (id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,$4,$5,9000001234,'G00ABC123',$6,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [topupId, ownerId, walletId, 'b'.repeat(64), amount, 'a'.repeat(64)]);
    await db.query("UPDATE gds_internal_topups SET status='PENDING_PAYOS',payment_link_id=$2 WHERE id=$1", [topupId, `link:${topupId}`]);
    await db.query(`UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',collection_reference=$2,
      signature_verified_at=CURRENT_TIMESTAMP,provider_reconciled_at=CURRENT_TIMESTAMP WHERE id=$1`, [topupId, `collection:${topupId}`]);
    await db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,topup_id,collection_reference)
      VALUES($1,$2,'TOPUP_CREDIT',$3::bigint,$3::bigint,0,-$3::bigint,$4,$5)`, [walletId, `topup:${topupId}`, amount, topupId, `collection:${topupId}`]);
  }
  async function request(amount = 50000, overrides: { key?: string; version?: number; min?: number; max?: number } = {}) {
    const id = randomUUID();
    await db.query(`INSERT INTO gds_withdrawals(id,wallet_id,owner_id,request_key_hash,amount_minor,bank_code,account_number,account_holder,
      settings_version,minimum_minor,maximum_minor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'VCB','0123456789','NGUYEN VAN A',$6,$7,$8,CURRENT_TIMESTAMP-INTERVAL '1 second',CURRENT_TIMESTAMP)`,
    [id, walletId, ownerId, overrides.key ?? randomUUID().replace(/-/g, '').repeat(2), amount,
      overrides.version ?? 1, overrides.min ?? 50000, overrides.max ?? 10000000]);
    return id;
  }
  async function event(id: string, from: string | null, to: string, actor = adminId,
    proof: { reference: string; transferredAt: string } | null = null) {
    await db.query(`INSERT INTO gds_withdrawal_events(withdrawal_id,actor_id,from_status,to_status,reason,bank_transaction_ref,transferred_at)
      VALUES($1,$2,$3,$4,'Synthetic test evidence',$5,$6)`,
    [id, actor, from, to, proof?.reference ?? null, proof?.transferredAt ?? null]);
  }
  async function period(amount: number, historical = false, options: { activate?: boolean; project?: boolean } = {}) {
    if (options.activate !== false) await enable();
    const periodId = randomUUID();
    const orderId = randomUUID(); const settlementId = randomUUID(); const snapshotId = randomUUID();
    await db.query("INSERT INTO commerce_orders(id,status,payable_amount_minor,currency,confirmed_settlement_id) VALUES($1,'confirmed',$2,'VND',$3)",
      [orderId, amount, settlementId]);
    await db.query("INSERT INTO commerce_settlements(id,order_id,amount_minor,currency,kind,disposition) VALUES($1,$2,$3,'VND','provider_collection','matched')",
      [settlementId, orderId, amount]);
    await db.query('INSERT INTO revenue_order_snapshots(id,order_id) VALUES($1,$2)', [snapshotId, orderId]);
    await db.query(`INSERT INTO revenue_earning_periods(id,seller_id,snapshot_id,amount_minor,due_at)
      VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP-INTERVAL '1 day')`, [periodId, ownerId, snapshotId, amount]);
    await db.query(`INSERT INTO revenue_ledger_entries(period_id,kind,amount_minor,created_at)
      SELECT $1,'recognized',$2,CASE WHEN $3::int IS NULL THEN clock_timestamp()
        ELSE revenue_cutoff_at+($3::int * INTERVAL '1 second') END FROM gds_withdrawal_settings WHERE id='global'`,
    [periodId, amount, historical ? -1 : null]);
    const id = randomUUID();
    if (options.project !== false) {
      await db.query('INSERT INTO gds_revenue_projections(id,period_id,wallet_id,review_required) VALUES($1,$2,$3,$4)',
        [id, periodId, walletId, historical]);
    }
    return { id, periodId, orderId, settlementId };
  }
  const effect = (id: string, revision: number, delta: number, available: number, debt: number) => db.query(`
    INSERT INTO gds_revenue_effects(projection_id,revision,delta_minor,available_delta_minor,debt_delta_minor)
    VALUES($1,$2,$3,$4,$5)`, [id, revision, delta, available, debt]);

  it('starts with configurable 50000–10000000 limits and both financial switches off', async () => {
    const result = await db.query(`SELECT minimum_minor::text AS min,maximum_minor::text AS max,
      admission_enabled AS admission,processing_enabled AS processing FROM gds_withdrawal_settings`);
    expect(result.rows).toEqual([{ min: '50000', max: '10000000', admission: false, processing: false }]);
    await credit();
    await rejected(() => request(), /admission or balance invalid/);
    await rejected(() => db.exec('UPDATE gds_withdrawal_settings SET minimum_minor=0'), /check constraint/);
    await rejected(() => db.exec('UPDATE gds_withdrawal_settings SET minimum_minor=10000001'), /check constraint/);
  });

  it('preserves verified topup posting and refuses direct balance or debt mutation', async () => {
    await credit();
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
    for (const column of ['available_minor', 'held_minor', 'debt_minor']) {
      await rejected(() => db.query(`UPDATE gds_internal_wallets SET ${column}=1 WHERE id=$1`, [walletId]), /journal-controlled/);
    }
  });

  it('requires runtime-created wallets to start with zero available, held and debt balances', async () => {
    const newOwner = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [newOwner]);
    for (const column of ['available_minor', 'held_minor', 'debt_minor']) {
      await rejected(async () => {
        await db.exec('SET LOCAL ROLE gds_withdrawal_test_runtime');
        return db.query(`INSERT INTO gds_internal_wallets(buyer_id,${column},updated_at) VALUES($1,1,CURRENT_TIMESTAMP)`, [newOwner]);
      }, /Runtime wallets must start at zero/);
    }
  });

  it('reserves exactly once, enforces configured boundaries and rejects insufficient spendable balance', async () => {
    await credit(); await enable();
    const key = 'c'.repeat(64);
    await request(150000, { key });
    expect(await balance()).toEqual({ available: '50000', held: '150000', debt: '0' });
    await rejected(() => request(150000, { key }), /admission or balance invalid|duplicate key/);
    await rejected(() => request(50001), /admission or balance invalid/);
    await rejected(() => request(49999), /check constraint/);
    await rejected(() => request(10000001), /admission or balance invalid|check constraint/);
    expect(await balance()).toEqual({ available: '50000', held: '150000', debt: '0' });
  });

  it('snapshots limits and preserves an existing request when admin changes settings', async () => {
    await credit(); await enable();
    const id = await request();
    await db.exec('UPDATE gds_withdrawal_settings SET minimum_minor=100000,maximum_minor=500000,version=2');
    await rejected(() => request(), /admission or balance invalid/);
    const result = await db.query('SELECT minimum_minor::text AS min,maximum_minor::text AS max,settings_version AS version FROM gds_withdrawals WHERE id=$1', [id]);
    expect(result.rows).toEqual([{ min: '50000', max: '10000000', version: 1 }]);
    await request(100000, { version: 2, min: 100000, max: 500000 });
  });

  it('records the creation event once and keeps audit history immutable', async () => {
    await credit(); await enable(); const id = await request();
    await event(id, null, 'PENDING', ownerId);
    await rejected(() => event(id, null, 'PENDING', ownerId), /invalid creation event/);
    await rejected(() => db.exec('DELETE FROM gds_withdrawal_events'), /append-only/);
    await rejected(() => db.exec("UPDATE gds_withdrawal_events SET reason='changed'"), /append-only/);
  });

  it('cancels or rejects only an eligible state and releases held value once', async () => {
    await credit(); await enable(); const id = await request();
    await event(id, 'PENDING', 'CANCELLED', ownerId);
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
    await rejected(() => event(id, 'PENDING', 'CANCELLED', ownerId), /invalid transition/);
    await rejected(() => db.query("UPDATE gds_withdrawals SET status='PENDING' WHERE id=$1", [id]), /event-controlled/);
    const second = await request();
    await event(second, 'PENDING', 'APPROVED');
    await rejected(() => event(second, 'APPROVED', 'CANCELLED', ownerId), /invalid transition/);
    await event(second, 'APPROVED', 'REJECTED');
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
  });

  it('requires a distinct admin, claims a transfer and never releases an uncertain outcome', async () => {
    await credit(); await enable(); const id = await request();
    await rejected(() => event(id, 'PENDING', 'APPROVED', ownerId), /actor invalid/);
    await event(id, 'PENDING', 'APPROVED');
    await event(id, 'APPROVED', 'PROCESSING');
    await rejected(() => event(id, 'PROCESSING', 'REJECTED'), /invalid transition/);
    await rejected(() => event(id, 'PROCESSING', 'CANCELLED', ownerId), /invalid transition/);
    await rejected(() => event(id, 'PROCESSING', 'FAILED', otherAdminId), /claimed by another admin/);
    expect(await balance()).toEqual({ available: '150000', held: '50000', debt: '0' });
    await event(id, 'PROCESSING', 'FAILED');
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
    await rejected(() => event(id, 'PROCESSING', 'FAILED'), /invalid transition/);
  });

  it('serializes wallet spending against a withdrawal reserve without allowing overdraft', async () => {
    await credit(); await enable(); await request(150000);
    await rejected(() => db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,'checkout-too-large','RESERVE',50001,-50001,50001,0,'synthetic-order')`, [walletId]), /check constraint/);
    expect(await balance()).toEqual({ available: '50000', held: '150000', debt: '0' });
  });

  it('requires bank evidence to mark paid, captures once and rejects transfer-reference reuse', async () => {
    await credit(); await enable(); const id = await request();
    await event(id, 'PENDING', 'APPROVED'); await event(id, 'APPROVED', 'PROCESSING');
    await rejected(() => event(id, 'PROCESSING', 'PAID'), /check constraint|payment proof|bank evidence/);
    // Entire fixture is a rollback transaction: PostgreSQL CURRENT_TIMESTAMP is frozen at BEGIN.
    const timestamp = await db.query<{ value: string }>(`SELECT to_char(CURRENT_TIMESTAMP-INTERVAL '1 millisecond', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value`);
    const proof = { reference: 'SYNTHETIC-BANK-TXN-1', transferredAt: timestamp.rows[0].value };
    await event(id, 'PROCESSING', 'PAID', adminId, proof);
    expect(await balance()).toEqual({ available: '150000', held: '0', debt: '0' });
    await rejected(() => event(id, 'PROCESSING', 'PAID', adminId, proof), /invalid transition/);
    const second = await request();
    await event(second, 'PENDING', 'APPROVED'); await event(second, 'APPROVED', 'PROCESSING');
    await rejected(() => event(second, 'PROCESSING', 'PAID', adminId, proof), /duplicate key/);
    expect(await balance()).toEqual({ available: '100000', held: '50000', debt: '0' });
  });

  it('rejects bank timestamps before the request or implausibly in the future', async () => {
    await credit(); await enable(); const id = await request();
    await event(id, 'PENDING', 'APPROVED'); await event(id, 'APPROVED', 'PROCESSING');
    await rejected(() => event(id, 'PROCESSING', 'PAID', adminId,
      { reference: 'SYNTHETIC-OLD-TIME', transferredAt: '2000-01-01T00:00:00.000Z' }), /timestamp|bank evidence|transfer.*time/);
    await rejected(() => event(id, 'PROCESSING', 'PAID', adminId,
      { reference: 'SYNTHETIC-FUTURE-TIME', transferredAt: new Date(Date.now() + 86_400_000).toISOString() }), /timestamp|bank evidence|transfer.*time/);
    expect(await balance()).toEqual({ available: '150000', held: '50000', debt: '0' });
  });

  it('credits each recognized revenue source exactly once and rejects fabricated effects', async () => {
    const p = await period(120000);
    await effect(p.id, 1, 120000, 120000, 0);
    expect(await balance()).toEqual({ available: '120000', held: '0', debt: '0' });
    await rejected(() => effect(p.id, 1, 120000, 120000, 0), /duplicate key|revision mismatch/);
    await rejected(() => effect(p.id, 2, 120000, 120000, 0), /source or balance mismatch/);
    await rejected(() => db.exec('UPDATE gds_revenue_effects SET delta_minor=1'), /append-only/);
    await rejected(() => db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,'forged-revenue-credit','REVENUE_CREDIT',1000,1000,0,-1000,$2)`, [walletId, randomUUID()]), /missing or mismatched source/);
    await rejected(() => db.query('UPDATE gds_revenue_projections SET applied_net_minor=0,revision=0 WHERE id=$1', [p.id]), /effect-controlled/);
  });

  it('refuses revenue without an exact verified settlement, before maturity or beyond its source amount', async () => {
    const p = await period(120000);
    for (const mutation of [
      () => db.query("UPDATE commerce_orders SET status='pending_payment' WHERE id=$1", [p.orderId]),
      () => db.query('UPDATE commerce_orders SET confirmed_settlement_id=NULL WHERE id=$1', [p.orderId]),
      () => db.query('UPDATE commerce_settlements SET amount_minor=120001 WHERE id=$1', [p.settlementId]),
      () => db.query("UPDATE commerce_settlements SET currency='USD' WHERE id=$1", [p.settlementId]),
      () => db.query("UPDATE commerce_settlements SET disposition='duplicate_collection' WHERE id=$1", [p.settlementId]),
      () => db.query("UPDATE revenue_earning_periods SET due_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE id=$1", [p.periodId]),
      () => db.query('UPDATE revenue_earning_periods SET amount_minor=119999 WHERE id=$1', [p.periodId]),
    ]) {
      await rejected(async () => { await mutation(); await effect(p.id, 1, 120000, 120000, 0); }, /verified settlement|bounded recognized/);
    }
    expect(await balance()).toEqual({ available: '0', held: '0', debt: '0' });
    await effect(p.id, 1, 120000, 120000, 0);
    expect(await balance()).toEqual({ available: '120000', held: '0', debt: '0' });
  });

  it('keeps historical earnings in review and subtracts confirmed external payouts before wallet credit', async () => {
    const p = await period(120000, true);
    await rejected(() => effect(p.id, 1, 120000, 120000, 0), /requires review/);
    await rejected(() => db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,historical_paid_minor=20000 WHERE id=$1`, [p.id, adminId]), /review invalid/);
    await rejected(() => db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,review_reason='Synthetic statement',historical_paid_minor=20000 WHERE id=$1`, [p.id, ownerId]), /review invalid/);
    await rejected(() => db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,review_reason='Synthetic statement',historical_paid_minor=120001 WHERE id=$1`, [p.id, adminId]), /review invalid/);
    await db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,review_reason='Synthetic statement: already paid 20000',historical_paid_minor=20000 WHERE id=$1`, [p.id, adminId]);
    await effect(p.id, 1, 100000, 100000, 0);
    expect(await balance()).toEqual({ available: '100000', held: '0', debt: '0' });
    await rejected(() => db.query('UPDATE gds_revenue_projections SET historical_paid_minor=0 WHERE id=$1', [p.id]), /review is immutable/);
  });

  it('records historical refund debt even when external payouts exceed remaining net earnings', async () => {
    const p = await period(100000, true);
    await db.query("INSERT INTO revenue_ledger_entries(period_id,kind,amount_minor) VALUES($1,'refund_recognized',-50000)", [p.periodId]);
    await db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,review_reason='Synthetic statement: paid 100000 before refund',historical_paid_minor=100000 WHERE id=$1`, [p.id, adminId]);
    await effect(p.id, 1, -50000, 0, 50000);
    expect(await balance()).toEqual({ available: '0', held: '0', debt: '50000' });
    const next = await period(75000);
    await effect(next.id, 1, 75000, 25000, -50000);
    expect(await balance()).toEqual({ available: '25000', held: '0', debt: '0' });
  });

  it('captures the historical cutoff at first activation and never moves it on later toggles', async () => {
    const initial = await db.query<{ cutoff: string; activated: string | null }>(
      'SELECT revenue_cutoff_at::text AS cutoff,revenue_activated_at::text AS activated FROM gds_withdrawal_settings');
    expect(initial.rows[0].activated).toBeNull();
    // Use a bounded 10ms margin around millisecond timestamp storage to avoid rounding ambiguity.
    await db.exec('SELECT pg_sleep(0.01)');
    const p = await period(100000, false, { activate: false, project: false });
    await db.exec('SELECT pg_sleep(0.01)');
    await enable();
    const first = await db.query<{ cutoff: string; activated: string; historical: boolean; afterMigration: boolean }>(`
      SELECT s.revenue_cutoff_at::text AS cutoff,s.revenue_activated_at::text AS activated,
      e.created_at<=s.revenue_cutoff_at AS historical,e.created_at>$2::timestamp AS "afterMigration"
      FROM gds_withdrawal_settings s,revenue_ledger_entries e WHERE e.period_id=$1`, [p.periodId, initial.rows[0].cutoff]);
    expect(first.rows[0].historical).toBe(true);
    expect(first.rows[0].afterMigration).toBe(true);
    expect(first.rows[0].activated).toBe(first.rows[0].cutoff);
    await db.query('INSERT INTO gds_revenue_projections(id,period_id,wallet_id,review_required) VALUES($1,$2,$3,true)', [p.id, p.periodId, walletId]);
    await rejected(() => effect(p.id, 1, 100000, 100000, 0), /requires review/);
    await db.exec('UPDATE gds_withdrawal_settings SET processing_enabled=false');
    await enable();
    const later = await db.query('SELECT revenue_cutoff_at::text AS cutoff,revenue_activated_at::text AS activated FROM gds_withdrawal_settings');
    expect(later.rows).toEqual([{ cutoff: first.rows[0].cutoff, activated: first.rows[0].activated }]);
    await rejected(() => db.exec("UPDATE gds_withdrawal_settings SET revenue_cutoff_at=revenue_cutoff_at+INTERVAL '1 day'"), /cutoff|activation|immutable/i);
  });

  it('refunds consume only available funds, preserve holds, block cash-out and repay debt with new income', async () => {
    const p = await period(120000);
    await effect(p.id, 1, 120000, 120000, 0);
    await enable(); const withdrawalId = await request(100000);
    await db.query("INSERT INTO revenue_ledger_entries(period_id,kind,amount_minor) VALUES($1,'refund_recognized',-120000)", [p.periodId]);
    await effect(p.id, 2, -120000, -20000, 100000);
    expect(await balance()).toEqual({ available: '0', held: '100000', debt: '100000' });
    await rejected(() => request(), /admission or balance invalid/);
    await event(withdrawalId, 'PENDING', 'APPROVED');
    await rejected(() => event(withdrawalId, 'APPROVED', 'PROCESSING'), /blocked by wallet or debt/);
    const next = await period(150000);
    await effect(next.id, 1, 150000, 50000, -100000);
    expect(await balance()).toEqual({ available: '50000', held: '100000', debt: '0' });
    await event(withdrawalId, 'APPROVED', 'PROCESSING');
  });

  it('allows pending cancellation during an admission stop and preserves suspended-wallet recovery', async () => {
    await credit(); await enable(); const id = await request();
    await db.exec("UPDATE gds_withdrawal_settings SET admission_enabled=false; UPDATE gds_internal_wallets SET status='SUSPENDED'");
    await event(id, 'PENDING', 'CANCELLED', ownerId);
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
  });

  it('runtime grants allow definer-backed request and cancellation without direct financial updates', async () => {
    await credit(); await enable();
    await db.exec('SET LOCAL ROLE gds_withdrawal_test_runtime');
    const id = await request();
    await event(id, null, 'PENDING', ownerId);
    expect(await balance()).toEqual({ available: '150000', held: '50000', debt: '0' });
    await rejected(() => db.query("UPDATE gds_withdrawals SET status='PAID' WHERE id=$1", [id]), /permission denied/);
    await rejected(() => db.query('UPDATE gds_withdrawals SET amount_minor=1 WHERE id=$1', [id]), /permission denied/);
    await rejected(() => db.query('UPDATE gds_internal_wallets SET available_minor=1 WHERE id=$1', [walletId]), /permission denied/);
    await event(id, 'PENDING', 'CANCELLED', ownerId);
    expect(await balance()).toEqual({ available: '200000', held: '0', debt: '0' });
  });

  it('runtime grants allow reviewed revenue effects but cannot rewrite the projection or approved review identity', async () => {
    const p = await period(100000, true);
    await db.exec('SET LOCAL ROLE gds_withdrawal_test_runtime');
    await db.query(`UPDATE gds_revenue_projections SET review_required=false,reviewed_by_id=$2,
      reviewed_at=CURRENT_TIMESTAMP,review_reason='Synthetic review through bounded runtime role',historical_paid_minor=0 WHERE id=$1`, [p.id, adminId]);
    await effect(p.id, 1, 100000, 100000, 0);
    expect(await balance()).toEqual({ available: '100000', held: '0', debt: '0' });
    await rejected(() => db.query('UPDATE gds_revenue_projections SET applied_net_minor=0 WHERE id=$1', [p.id]), /permission denied/);
    await rejected(() => db.query('UPDATE gds_revenue_projections SET revision=0 WHERE id=$1', [p.id]), /permission denied/);
    await rejected(() => db.query('UPDATE gds_revenue_projections SET reviewed_by_id=$2 WHERE id=$1', [p.id, otherAdminId]), /review is immutable/);
    await rejected(() => db.query('UPDATE gds_revenue_projections SET historical_paid_minor=1 WHERE id=$1', [p.id]), /review is immutable/);
    await rejected(() => db.query('UPDATE gds_revenue_effects SET delta_minor=1 WHERE projection_id=$1', [p.id]), /permission denied/);
  });

  it('runtime cannot attach privileged projection functions to an alternate trigger table', async () => {
    await db.exec('SET LOCAL ROLE gds_withdrawal_test_runtime; CREATE TEMP TABLE alternate_gds_trigger(id uuid)');
    for (const name of ['gds_withdrawal_new', 'gds_withdrawal_event_apply', 'gds_extended_journal_apply', 'gds_revenue_effect_apply']) {
      await rejected(() => db.exec(`CREATE TRIGGER alternate_projection AFTER INSERT ON alternate_gds_trigger
        FOR EACH ROW EXECUTE FUNCTION public.${name}()`), /permission denied for function/);
    }
  });
});
