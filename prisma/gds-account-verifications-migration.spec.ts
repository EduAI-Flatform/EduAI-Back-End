import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { buildRuntimeGdsWithdrawalPrivilegeStatement, buildRuntimeGdsVerificationPrivilegeStatement } = require('../scripts/membership-runtime-privileges.cjs');

describe('GDS recipient verification PostgreSQL invariants (synthetic data only)', () => {
  let db: PGlite;
  let owner: string;
  let admin: string;
  let other: string;
  let wallet: string;
  type Destination = { owner: string; bank: string; account: string; name: string; bin: string; bankName: string; shortName: string };
  type Proof = Destination & { id: string; verifiedAt: string };
  const migration = (name: string) => readFileSync(join(__dirname, 'migrations', name, 'migration.sql'), 'utf8');

  async function initialize(database: PGlite, includeVerification = true) {
    await database.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,status text,payable_amount_minor bigint,currency text,confirmed_settlement_id uuid);
      CREATE TABLE commerce_settlements(id uuid PRIMARY KEY,order_id uuid,amount_minor bigint,currency text,kind text,disposition text);
      CREATE TABLE revenue_order_snapshots(id uuid PRIMARY KEY,order_id uuid);
      CREATE TABLE revenue_earning_periods(id uuid PRIMARY KEY,seller_id uuid,snapshot_id uuid,amount_minor bigint,due_at timestamp(3));
      CREATE TABLE revenue_ledger_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),period_id uuid,kind varchar(30),amount_minor bigint,created_at timestamp(3) DEFAULT CURRENT_TIMESTAMP);`);
    for (const name of ['20261102030000_add_gds_internal_prepaid_journal', '20261103040000_harden_gds_runtime_projection',
      '20261104100000_add_gds_withdrawals']) await database.exec(migration(name));
    if (includeVerification) await database.exec(migration('20261104120000_add_gds_account_verifications'));
  }
  beforeAll(async () => {
    db = new PGlite();
    await initialize(db);
    await db.exec(`CREATE ROLE gds_verification_test_runtime NOLOGIN;
      GRANT USAGE ON SCHEMA public TO gds_verification_test_runtime;
      GRANT SELECT,INSERT ON gds_internal_wallets TO gds_verification_test_runtime;
      GRANT UPDATE(updated_at) ON gds_internal_wallets TO gds_verification_test_runtime;`);
    const runtimeUrl = 'postgresql://gds_verification_test_runtime@localhost/synthetic';
    await db.exec(buildRuntimeGdsWithdrawalPrivilegeStatement(runtimeUrl));
    await db.exec(buildRuntimeGdsVerificationPrivilegeStatement(runtimeUrl));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    owner = randomUUID(); admin = randomUUID(); other = randomUUID(); wallet = randomUUID();
    await db.exec('BEGIN');
    await seedWallet(db, owner, wallet, [admin, other]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  async function seedWallet(database: PGlite, buyer: string, walletId: string, additionalUsers: string[] = []) {
    for (const id of [buyer, ...additionalUsers]) await database.query('INSERT INTO users(id) VALUES($1)', [id]);
    await database.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [walletId, buyer]);
    await database.exec("UPDATE gds_withdrawal_settings SET admission_enabled=true,processing_enabled=true WHERE id='global'");
    const topup = randomUUID();
    await database.query(`INSERT INTO gds_internal_topups(id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,$4,200000,9000001234,'G00ABC123',$5,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [topup, buyer, walletId, 'b'.repeat(64), 'a'.repeat(64)]);
    await database.query("UPDATE gds_internal_topups SET status='PENDING_PAYOS',payment_link_id=$2 WHERE id=$1", [topup, `link:${topup}`]);
    await database.query(`UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',collection_reference=$2,signature_verified_at=CURRENT_TIMESTAMP,provider_reconciled_at=CURRENT_TIMESTAMP WHERE id=$1`, [topup, `collection:${topup}`]);
    await database.query(`INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,topup_id,collection_reference)
      VALUES($1,$2,'TOPUP_CREDIT',200000,200000,0,-200000,$3,$4)`, [walletId, `topup:${topup}`, topup, `collection:${topup}`]);
  }

  const destination = (): Destination => ({ owner, bank: 'VCB', account: '0123456789', name: 'Đặng Văn Á', bin: '970436', bankName: 'Synthetic Bank', shortName: 'VCB' });
  async function rejected(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT expected_rejection');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT expected_rejection; RELEASE SAVEPOINT expected_rejection'); }
  }
  const mandatory = () => db.exec('UPDATE gds_withdrawal_settings SET account_verification_required=true');
  async function balance() {
    return (await db.query('SELECT available_minor::text AS available,held_minor::text AS held FROM gds_internal_wallets WHERE id=$1', [wallet])).rows[0];
  }
  async function proof(options: Partial<Destination> & { purpose?: string; withdrawal?: string; actor?: string; expiresInMs?: number; provider?: string } = {}): Promise<Proof> {
    const d = { ...destination(), ...options };
    const id = randomUUID();
    const row = await db.query<{ verifiedAt: string }>(`INSERT INTO gds_account_verifications(id,owner_id,actor_id,bank_code,bank_bin,bank_name,bank_short_name,
      account_number,account_holder,normalized_account_holder,provider,purpose,withdrawal_id,verified_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text,gds_normalize_bank_name($9::text),$13,$10,$11,
        clock_timestamp()-INTERVAL '1 second',clock_timestamp()+($12::int*INTERVAL '1 millisecond')) RETURNING verified_at::text AS "verifiedAt"`,
    [id, d.owner, options.actor ?? d.owner, d.bank, d.bin, d.bankName, d.shortName, d.account, d.name, options.purpose ?? 'CREATE', options.withdrawal ?? null, options.expiresInMs ?? 600000, options.provider ?? 'vietqr']);
    return { ...d, id, verifiedAt: row.rows[0].verifiedAt };
  }
  async function request(p?: Proof, overrides: Partial<Destination> = {}) {
    const d = { ...destination(), ...overrides };
    const id = randomUUID();
    await db.query(`INSERT INTO gds_withdrawals(id,wallet_id,owner_id,request_key_hash,amount_minor,bank_code,account_number,account_holder,
      settings_version,minimum_minor,maximum_minor,created_at,updated_at,verification_id,bank_bin,bank_name,bank_short_name,account_verified_at)
      VALUES($1,$2,$3,$4,50000,$5,$6,$7,1,50000,10000000,CURRENT_TIMESTAMP-INTERVAL '1 second',CURRENT_TIMESTAMP,$8,$9,$10,$11,$12)`,
    [id, wallet, d.owner, randomUUID().replace(/-/g, '').repeat(2), d.bank, d.account, d.name, p?.id ?? null,
      p?.bin ?? null, p?.bankName ?? null, p?.shortName ?? null, p?.verifiedAt ?? null]);
    return id;
  }
  const event = (id: string, from: string, to: string, actor = admin) => db.query(`INSERT INTO gds_withdrawal_events(withdrawal_id,actor_id,from_status,to_status,reason,bank_transaction_ref,transferred_at)
    VALUES($1,$2,$3,$4::text,'Synthetic reconciliation',$5,CASE WHEN $4::text='PAID' THEN CURRENT_TIMESTAMP-INTERVAL '1 millisecond' ELSE NULL END)`,
  [id, actor, from, to, to === 'PAID' ? `bank:${id}` : null]);
  async function approved(p?: Proof) { const id = await request(p); await event(id, 'PENDING', 'APPROVED'); return id; }

  it('defaults mandatory verification off and leaves legacy bank snapshots empty', async () => {
    expect((await db.query('SELECT account_verification_required AS required FROM gds_withdrawal_settings')).rows).toEqual([{ required: false }]);
    const id = await request();
    expect((await db.query('SELECT verification_id,bank_bin,bank_name,bank_short_name,account_verified_at FROM gds_withdrawals WHERE id=$1', [id])).rows)
      .toEqual([{ verification_id: null, bank_bin: null, bank_name: null, bank_short_name: null, account_verified_at: null }]);
  });
  it('preserves balances and request snapshots while adding explicit manual checks', async () => {
    const id = await approved();
    const previous = (await db.query('SELECT to_jsonb(r) AS snapshot FROM gds_withdrawals r WHERE id=$1', [id])).rows;
    const before = await balance();
    await db.exec(migration('20261105040000_add_gds_manual_recipient_checks'));
    expect((await db.query('SELECT to_jsonb(r) AS snapshot FROM gds_withdrawals r WHERE id=$1', [id])).rows).toEqual(previous);
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    await proof({ provider: 'admin_manual', purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await rejected(() => event(id, 'APPROVED', 'PROCESSING', other), /requires fresh matching verification/);
    await event(id, 'APPROVED', 'PROCESSING');
    expect(await balance()).toEqual(before);
    await rejected(() => proof({ provider: 'admin_manual', purpose: 'TRANSFER', withdrawal: id, actor: other }), /request mismatch/);
    await event(id, 'PROCESSING', 'FAILED');
    expect(await balance()).toEqual({ available: '200000', held: '0' });
  });
  it('never accepts a manual check as CREATE evidence or as a substitute for mandatory lookup', async () => {
    await db.exec(migration('20261105040000_add_gds_manual_recipient_checks'));
    await rejected(() => proof({ provider: 'admin_manual' }), /check constraint/);
    const id = await approved();
    await mandatory();
    await rejected(() => proof({ provider: 'admin_manual', purpose: 'TRANSFER', withdrawal: id, actor: admin }), /request mismatch/);
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await event(id, 'APPROVED', 'PROCESSING');
  });
  it('does not allow an earlier manual check after mandatory policy is switched on', async () => {
    await db.exec(migration('20261105040000_add_gds_manual_recipient_checks'));
    const id = await approved();
    await proof({ provider: 'admin_manual', purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await mandatory();
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    expect(await balance()).toEqual({ available: '150000', held: '50000' });
  });
  it('preserves an existing reserved withdrawal and journal unchanged when applying the additive migration', async () => {
    const legacyDb = new PGlite();
    try {
      await initialize(legacyDb, false);
      const buyer = randomUUID(); const walletId = randomUUID(); const id = randomUUID();
      await seedWallet(legacyDb, buyer, walletId);
      await legacyDb.query(`INSERT INTO gds_withdrawals(id,wallet_id,owner_id,request_key_hash,amount_minor,bank_code,account_number,account_holder,
        settings_version,minimum_minor,maximum_minor,created_at,updated_at)
        VALUES($1,$2,$3,$4,50000,'VCB','0123456789','DANG VAN A',1,50000,10000000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [id, walletId, buyer, 'c'.repeat(64)]);
      const previousRequest = (await legacyDb.query('SELECT to_jsonb(r) AS snapshot FROM gds_withdrawals r')).rows;
      const previousJournal = (await legacyDb.query('SELECT to_jsonb(j) AS snapshot FROM gds_internal_journal j ORDER BY event_key')).rows;
      const previousWallet = (await legacyDb.query('SELECT to_jsonb(w) AS snapshot FROM gds_internal_wallets w')).rows;
      await legacyDb.exec(migration('20261104120000_add_gds_account_verifications'));
      expect((await legacyDb.query(`SELECT to_jsonb(r)-ARRAY['verification_id','bank_bin','bank_name','bank_short_name','account_verified_at'] AS snapshot FROM gds_withdrawals r`)).rows).toEqual(previousRequest);
      expect((await legacyDb.query('SELECT to_jsonb(j) AS snapshot FROM gds_internal_journal j ORDER BY event_key')).rows).toEqual(previousJournal);
      expect((await legacyDb.query('SELECT to_jsonb(w) AS snapshot FROM gds_internal_wallets w')).rows).toEqual(previousWallet);
      expect((await legacyDb.query('SELECT account_verification_required AS required FROM gds_withdrawal_settings')).rows).toEqual([{ required: false }]);
      expect((await legacyDb.query('SELECT verification_id,bank_bin,bank_name,bank_short_name,account_verified_at FROM gds_withdrawals')).rows)
        .toEqual([{ verification_id: null, bank_bin: null, bank_name: null, bank_short_name: null, account_verified_at: null }]);
    } finally { await legacyDb.close(); }
  }, 30_000);
  it('rejects missing proof before reserving money when verification is mandatory', async () => {
    await mandatory();
    await rejected(() => request(), /recipient verification required/);
    expect(await balance()).toEqual({ available: '200000', held: '0' });
    expect((await db.query("SELECT count(*)::int AS count FROM gds_internal_journal WHERE kind='WITHDRAWAL_RESERVE'")).rows).toEqual([{ count: 0 }]);
  });
  it.each(['bank_name', 'bank_short_name'])('rejects a %s snapshot without verification evidence', async (column) => {
    await rejected(() => db.query(`INSERT INTO gds_withdrawals(id,wallet_id,owner_id,request_key_hash,amount_minor,bank_code,account_number,account_holder,
      settings_version,minimum_minor,maximum_minor,created_at,updated_at,${column})
      VALUES($1,$2,$3,$4,50000,'VCB','0123456789','DANG VAN A',1,50000,10000000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'Synthetic Bank')`,
    [randomUUID(), wallet, owner, randomUUID().replace(/-/g, '').repeat(2)]), /verification snapshot without proof/);
    expect(await balance()).toEqual({ available: '200000', held: '0' });
  });
  it.each(['owner', 'bank', 'account', 'name'] as const)('rejects a proof bound to a different %s', async (field) => {
    await mandatory();
    const mismatches = { owner: other, bank: 'TPB', account: '9988776655', name: 'NGUYEN VAN B' };
    const p = await proof({ [field]: mismatches[field] });
    await rejected(() => request(p), /verification binding invalid/);
    expect(await balance()).toEqual({ available: '200000', held: '0' });
  });
  it('stores the exact verified destination, reserves once and rejects proof reuse', async () => {
    await mandatory(); const p = await proof(); const id = await request(p);
    expect((await db.query('SELECT verification_id,bank_bin,bank_name,bank_short_name,account_holder FROM gds_withdrawals WHERE id=$1', [id])).rows)
      .toEqual([{ verification_id: p.id, bank_bin: p.bin, bank_name: p.bankName, bank_short_name: p.shortName, account_holder: p.name }]);
    await rejected(() => request(p), /duplicate key/);
    expect(await balance()).toEqual({ available: '150000', held: '50000' });
  });
  it('rejects expired creation proofs without reserving money', async () => {
    const p = await proof({ expiresInMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 100));
    await rejected(() => request(p), /verification binding invalid/);
    expect(await balance()).toEqual({ available: '200000', held: '0' });
  });
  it('keeps proofs and withdrawal destination snapshots immutable', async () => {
    const p = await proof(); const id = await request(p);
    await rejected(() => db.query("UPDATE gds_account_verifications SET account_holder='CHANGED' WHERE id=$1", [p.id]), /append-only/);
    await rejected(() => db.query('DELETE FROM gds_account_verifications WHERE id=$1', [p.id]), /append-only/);
    for (const change of ["bank_bin='970423'", "bank_name='Other'", "verification_id=NULL", "account_verified_at=clock_timestamp()", 'amount_minor=60000']) {
      await rejected(() => db.query(`UPDATE gds_withdrawals SET ${change} WHERE id=$1`, [id]), /immutable identity/);
    }
  });
  it('normalizes Vietnamese names including Đ, case and whitespace', async () => {
    const result = await db.query('SELECT gds_normalize_bank_name($1) AS name', ['  Đặng   Văn Á  ']);
    expect(result.rows).toEqual([{ name: 'DANG VAN A' }]);
  });
  it('normalizes decomposed Unicode Vietnamese accents consistently with composed names', async () => {
    const result = await db.query('SELECT gds_normalize_bank_name($1) AS name', ['  Đặng   Văn Á  '.normalize('NFD')]);
    expect(result.rows).toEqual([{ name: 'DANG VAN A' }]);
  });
  it('normalizes tabs and newlines, including at name boundaries', async () => {
    const result = await db.query('SELECT gds_normalize_bank_name($1) AS name', ['\t\n Đặng\t Văn\nÁ \n\t']);
    expect(result.rows).toEqual([{ name: 'DANG VAN A' }]);
  });
  it('requires a fresh admin-bound transfer proof for a legacy request after policy activation', async () => {
    const id = await approved(); await mandatory();
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: other, name: '  DANG   VAN A  ' });
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin, name: 'dang van a' });
    await event(id, 'APPROVED', 'PROCESSING');
    expect((await db.query('SELECT status,processing_admin_id FROM gds_withdrawals WHERE id=$1', [id])).rows).toEqual([{ status: 'PROCESSING', processing_admin_id: admin }]);
  });
  it('does not let a proof for a different request or changed recipient authorize processing', async () => {
    const id = await approved(); const second = await approved(); await mandatory();
    await proof({ purpose: 'TRANSFER', withdrawal: second, actor: admin });
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    await rejected(() => proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin, name: 'DIFFERENT PERSON' }), /request mismatch/);
    await rejected(() => proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin, bank: 'TPB' }), /request mismatch/);
    await rejected(() => proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin, account: '9988776655' }), /request mismatch/);
    expect(await balance()).toEqual({ available: '100000', held: '100000' });
  });
  it('rejects an expired transfer proof and does not release held money', async () => {
    const id = await approved(); await mandatory();
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin, expiresInMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 100));
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    expect(await balance()).toEqual({ available: '150000', held: '50000' });
  });
  it('requires transfer re-verification for verified new requests even while policy is off', async () => {
    const id = await approved(await proof());
    await rejected(() => event(id, 'APPROVED', 'PROCESSING'), /requires fresh matching verification/);
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await event(id, 'APPROVED', 'PROCESSING');
  });
  it('preserves legacy processing while verification policy remains off', async () => {
    const id = await approved(); await event(id, 'APPROVED', 'PROCESSING');
    expect(await balance()).toEqual({ available: '150000', held: '50000' });
  });
  it.each(['PAID', 'FAILED'])('allows already-processing legacy requests to be %s without a provider proof', async (terminal) => {
    const id = await approved(); await event(id, 'APPROVED', 'PROCESSING'); await mandatory();
    await event(id, 'PROCESSING', terminal);
    expect(await balance()).toEqual({ available: terminal === 'PAID' ? '150000' : '200000', held: '0' });
    await rejected(() => event(id, 'PROCESSING', terminal), /invalid transition/);
  });
  it('cannot use transfer-purpose proof to create a new request', async () => {
    const id = await approved();
    const p = await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await rejected(() => request(p), /verification binding invalid/);
  });
  it('allows mandatory proof creation and processing under production-style bounded runtime grants', async () => {
    await mandatory();
    await db.exec('SET LOCAL ROLE gds_verification_test_runtime');
    const p = await proof(); const id = await approved(p);
    await proof({ purpose: 'TRANSFER', withdrawal: id, actor: admin });
    await event(id, 'APPROVED', 'PROCESSING');
    await rejected(() => db.query("UPDATE gds_account_verifications SET account_holder='CHANGED' WHERE id=$1", [p.id]), /permission denied/);
    await rejected(() => db.query('DELETE FROM gds_account_verifications WHERE id=$1', [p.id]), /permission denied/);
    expect(await balance()).toEqual({ available: '150000', held: '50000' });
  });
});
