import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('affiliate to existing GDS PostgreSQL journal (synthetic only)', () => {
  let db: PGlite;
  let owner: string, wallet: string, order: string, settlement: string, attribution: string, policy: string, line: string;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,status text,payable_amount_minor bigint,currency text,confirmed_settlement_id uuid,fulfillment_status text);
      CREATE TABLE commerce_settlements(id uuid PRIMARY KEY,order_id uuid,amount_minor bigint,currency text,kind text,disposition text,settled_at timestamp(3));
      CREATE TABLE revenue_order_snapshots(id uuid PRIMARY KEY,order_id uuid,basis_amount_minor bigint,platform_amount_minor bigint,seller_amount_minor bigint);
      CREATE TABLE revenue_earning_periods(id uuid PRIMARY KEY,seller_id uuid,snapshot_id uuid,amount_minor bigint,due_at timestamp(3));
      CREATE TABLE revenue_ledger_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),period_id uuid,kind text,amount_minor bigint,created_at timestamp(3));
      CREATE TABLE platform_policy_revisions(id uuid PRIMARY KEY,"group" text,content jsonb,status text,effective_at timestamp(3));
      CREATE TABLE commerce_refunds(id uuid PRIMARY KEY,order_id uuid,settlement_id uuid,status text,currency text,amount_minor bigint,recorded_at timestamp(3));
      CREATE TABLE commerce_refund_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),refund_id uuid,order_line_id uuid,amount_minor bigint);`);
    for (const migration of ['20261102030000_add_gds_internal_prepaid_journal','20261103040000_harden_gds_runtime_projection',
      '20261104100000_add_gds_withdrawals','20261111160000_affiliate','20261111180000_affiliate_wallet']) {
      await db.exec(readFileSync(join(__dirname, 'migrations', migration, 'migration.sql'), 'utf8'));
    }
  }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    [owner, wallet, order, settlement, attribution, policy, line] = Array.from({ length: 7 }, () => randomUUID());
    await db.exec('BEGIN');
    await db.query('INSERT INTO users VALUES($1)', [owner]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [wallet, owner]);
    await db.exec("UPDATE gds_withdrawal_settings SET processing_enabled=true,admission_enabled=true,minimum_minor=1 WHERE id='global'");
    await db.query(`INSERT INTO commerce_orders VALUES($1,'confirmed',1000,'VND',$2,'fulfilled')`, [order, settlement]);
    await db.query(`INSERT INTO commerce_settlements VALUES($1,$2,1000,'VND','provider_collection','matched',CURRENT_TIMESTAMP-INTERVAL '1 day')`, [settlement, order]);
    await db.query(`INSERT INTO revenue_order_snapshots VALUES($1,$2,1000,200,800)`, [line, order]);
    const content = { enabled: true, currency: 'VND', commissionBase: 'net_paid_after_recorded_refunds', attributionModel: 'first_touch',
      fundingSource: 'platform_fee', allocationPrecedence: 'seller_entitlements_first', commissionBps: 1000, holdDays: 0, subAffiliateEnabled: false };
    await db.query(`INSERT INTO platform_policy_revisions VALUES($1,'affiliate',$2,'scheduled',CURRENT_TIMESTAMP-INTERVAL '3 days')`, [policy, JSON.stringify(content)]);
    const identity = randomUUID(), visit = randomUUID(), buyer = randomUUID();
    await db.query('INSERT INTO users VALUES($1)', [buyer]);
    await db.query(`INSERT INTO affiliate_identities(id,owner_id,kind,code) VALUES($1,$2,'general',$3)`, [identity, owner, randomUUID()]);
    await db.query(`INSERT INTO affiliate_visits(id,token_hash,identity_id,policy_revision_id,expires_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+INTERVAL '1 day')`, [visit, randomUUID(), identity, policy]);
    await db.query(`INSERT INTO affiliate_attributions(id,order_id,identity_id,buyer_id,visit_id,policy_revision_id,created_at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP-INTERVAL '2 days')`, [attribution, order, identity, buyer, visit, policy]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  async function accrual(delta: number, net = 1000) {
    const id = randomUUID();
    await db.query(`INSERT INTO affiliate_accruals(id,attribution_id,source_digest,delta_minor,qualifying_amount_minor,commission_bps,currency,hold_until)
      SELECT $1,$2,$3,$4,$5,1000,'VND',settled_at FROM commerce_settlements WHERE id=$6`, [id, attribution, randomUUID(), delta, net, settlement]);
    return id;
  }
  async function effect(accrualId: string, delta: number, cash = delta, debt = 0) {
    return db.query(`INSERT INTO affiliate_wallet_effects(accrual_id,wallet_id,delta_minor,available_delta_minor,debt_delta_minor) VALUES($1,$2,$3,$4,$5)`, [accrualId, wallet, delta, cash, debt]);
  }
  async function balance() {
    return (await db.query('SELECT available_minor::text AS cash,held_minor::text AS held,debt_minor::text AS debt FROM gds_internal_wallets WHERE id=$1', [wallet])).rows[0];
  }
  async function rejected(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT reject');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT reject; RELEASE SAVEPOINT reject'); }
  }
  it('credits the same GDS journal once and rejects replay or forged deltas', async () => {
    const a = await accrual(100);
    await rejected(() => effect(a, 101), /posting mismatch/);
    await effect(a, 100); expect(await balance()).toEqual({ cash: '100', held: '0', debt: '0' });
    await rejected(() => effect(a, 100), /unique constraint/);
    expect((await db.query('SELECT count(*)::int AS n FROM gds_internal_journal')).rows[0]).toEqual({ n: 1 });
  });
  it('preserves seller entitlements and rejects insufficient platform funds', async () => {
    await db.query('UPDATE revenue_order_snapshots SET platform_amount_minor=50,seller_amount_minor=950 WHERE id=$1', [line]);
    const a = await accrual(100); await rejected(() => effect(a, 100), /AFFILIATE_PLATFORM_FEE_INSUFFICIENT/);
    expect(await balance()).toEqual({ cash: '0', held: '0', debt: '0' });
    expect((await db.query('SELECT seller_amount_minor::text AS amount FROM revenue_order_snapshots WHERE id=$1', [line])).rows[0]).toEqual({ amount: '950' });
  });
  it('keeps effect audit immutable and rejects forged journal events', async () => {
    const a = await accrual(100); await effect(a, 100);
    await rejected(() => db.query('UPDATE affiliate_wallet_effects SET delta_minor=99 WHERE accrual_id=$1', [a]), /append-only/);
    await rejected(() => db.query('DELETE FROM affiliate_wallet_effects WHERE accrual_id=$1', [a]), /append-only/);
    await rejected(() => db.query(`INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      SELECT wallet_id,'forged-event','REVENUE_CREDIT',100,100,0,-100,id::text FROM affiliate_wallet_effects WHERE accrual_id=$1`, [a]), /missing or mismatched source/);
    expect(await balance()).toEqual({ cash: '100', held: '0', debt: '0' });
  });
  it('refuses processing pause, future holds and unconfigured frozen funding', async () => {
    const a = await accrual(100);
    await db.exec("UPDATE gds_withdrawal_settings SET processing_enabled=false WHERE id='global'");
    await rejected(() => effect(a, 100), /processing unavailable/);
    await db.exec("UPDATE gds_withdrawal_settings SET processing_enabled=true WHERE id='global'");
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{holdDays}','7') WHERE id=$1`, [policy]);
    await rejected(() => effect(a, 100), /hold invalid/);
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{fundingSource}','"unconfigured"') WHERE id=$1`, [policy]);
    await rejected(() => effect(a, 100), /funding or processing unavailable/);
    expect(await balance()).toEqual({ cash: '0', held: '0', debt: '0' });
  });
  it('recovers a full refund while preserving the existing manual withdrawal hold', async () => {
    await effect(await accrual(100), 100);
    const withdrawal = randomUUID();
    await db.query(`INSERT INTO gds_withdrawals(id,wallet_id,owner_id,request_key_hash,amount_minor,bank_code,account_number,account_holder,settings_version,minimum_minor,maximum_minor,updated_at)
      VALUES($1,$2,$3,$4,100,'VCB','123456','TEST OWNER',1,1,10000000,CURRENT_TIMESTAMP)`, [withdrawal, wallet, owner, randomUUID().replace(/-/g,'').repeat(2)]);
    expect(await balance()).toEqual({ cash: '0', held: '100', debt: '0' });
    const refund = randomUUID();
    await db.query(`INSERT INTO commerce_refunds VALUES($1,$2,$3,'recorded','VND',1000,CURRENT_TIMESTAMP)`, [refund, order, settlement]);
    await db.query('INSERT INTO commerce_refund_allocations(refund_id,order_line_id,amount_minor) VALUES($1,$2,1000)', [refund, line]);
    await db.exec("UPDATE gds_withdrawal_settings SET processing_enabled=false WHERE id='global'");
    await effect(await accrual(-100, 0), -100, 0, 100);
    expect(await balance()).toEqual({ cash: '0', held: '100', debt: '100' });
    for (const kind of ['RESERVE','CAPTURE']) {
      await rejected(() => db.query(`INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
        VALUES($1,$2,$3,1,$4,$5,$6,$7)`, [wallet, 'debt-spend-' + kind, kind, kind === 'RESERVE' ? -1 : 0,
        kind === 'RESERVE' ? 1 : -1, kind === 'RESERVE' ? 0 : 1, randomUUID()]), /GDS_SPENDING_DEBT_BLOCKED/);
    }
  });
});
