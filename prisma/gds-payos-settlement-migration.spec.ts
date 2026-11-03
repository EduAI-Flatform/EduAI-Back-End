import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PayOS immutable QR and settlement reconciliation (synthetic PostgreSQL)', () => {
  let db: PGlite;
  let topup: string;
  let inbox: string;
  let wallet: string;
  const qr = 'a'.repeat(64);
  const settlement = 'b'.repeat(64);
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY)');
    for (const name of ['20261102030000_add_gds_internal_prepaid_journal',
      '20261102080000_add_gds_payos_inbox', '20261103010000_bind_gds_payos_receiving_account',
      '20261103020000_add_gds_payos_settlement_reconciliation']) {
      await db.exec(readFileSync(join(__dirname, 'migrations', name, 'migration.sql'), 'utf8'));
    }
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    topup = randomUUID(); inbox = randomUUID(); wallet = randomUUID();
    const buyer = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users VALUES($1)', [buyer]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,now())', [wallet, buyer]);
    await db.query(`INSERT INTO gds_internal_topups(id,buyer_id,wallet_id,request_key_hash,amount_minor,
      payos_order_code,transfer_memo,receiving_account_hash,payment_link_id,status,expires_at,updated_at)
      VALUES($1,$2,$3,$4,85000,40012345678,'G00000001',$4,'payos-link-a','PENDING_PAYOS',now()+interval '1 hour',now())`,
    [topup, buyer, wallet, qr]);
    await db.query(`INSERT INTO gds_internal_payos_inbox(id,topup_id,provider_event_identity,payos_order_code,
      payment_link_id,amount_minor,currency,receiving_account,receiving_account_hash,occurred_at,signature_verified_at)
      VALUES($1,$2,'bank-ref-001',40012345678,'payos-link-a',85000,'VND','VA_bank-123',$3,now(),now())`,
    [inbox, topup, settlement]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  async function reject(sql: string, params: unknown[] = [], pattern = /reconciliation|immutable|unique|proof|check/) {
    await db.exec('SAVEPOINT invalid');
    try { await expect(db.query(sql, params)).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT invalid; RELEASE SAVEPOINT invalid'); }
  }
  function proof(overrides: Record<string, string> = {}) {
    const fields: Record<string, string> = {
      topup_id: 'i.topup_id', inbox_id: 'i.id', provider_event_identity: 'i.provider_event_identity',
      payos_order_code: 'i.payos_order_code', payment_link_id: 'i.payment_link_id', amount_minor: 'i.amount_minor',
      currency: 'i.currency', qr_receiving_account_hash: 't.receiving_account_hash',
      settlement_receiving_account_hash: 'i.receiving_account_hash', occurred_at: 'i.occurred_at',
      signature_verified_at: 'i.signature_verified_at', provider_reconciled_at: 'i.signature_verified_at',
      ...overrides,
    };
    return `INSERT INTO gds_internal_payos_reconciliations(${Object.keys(fields).join(',')})
      SELECT ${Object.values(fields).join(',')} FROM gds_internal_payos_inbox i
      JOIN gds_internal_topups t ON t.id=i.topup_id WHERE i.id=$1`;
  }
  const bindSql = `UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',
    settlement_receiving_account_hash=$2,collection_reference='bank-ref-001',
    signature_verified_at=now(),provider_reconciled_at=now() WHERE id=$1`;
  const creditSql = `INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,
    available_delta_minor,held_delta_minor,clearing_delta_minor,topup_id,collection_reference)
    VALUES($1,'settlement-credit','TOPUP_CREDIT',85000,85000,0,-85000,$2,'bank-ref-001')`;

  it('recovers a REVIEW mismatch with new proof while preserving signed facts and QR identity', async () => {
    await db.query(`UPDATE gds_internal_payos_inbox SET status='REVIEW',review_reason='SIGNED_IDENTITY_OR_TERMINAL_CONFLICT' WHERE id=$1`, [inbox]);
    await db.query(proof(), [inbox]);
    await db.query(bindSql, [topup, settlement]);
    await db.query(creditSql, [wallet, topup]);
    expect((await db.query('SELECT receiving_account_hash,settlement_receiving_account_hash,status FROM gds_internal_topups WHERE id=$1', [topup])).rows)
      .toEqual([{ receiving_account_hash: qr, settlement_receiving_account_hash: settlement, status: 'CREDITED' }]);
    expect((await db.query('SELECT status FROM gds_internal_payos_inbox WHERE id=$1', [inbox])).rows).toEqual([{ status: 'REVIEW' }]);
    expect((await db.query('SELECT available_minor::text FROM gds_internal_wallets WHERE id=$1', [wallet])).rows).toEqual([{ available_minor: '85000' }]);
    await reject(creditSql, [wallet, topup]);
    await reject('UPDATE gds_internal_topups SET settlement_receiving_account_hash=$2 WHERE id=$1', [topup, qr]);
    await reject('UPDATE gds_internal_topups SET receiving_account_hash=$2 WHERE id=$1', [topup, settlement]);
    await reject('UPDATE gds_internal_payos_reconciliations SET amount_minor=1 WHERE topup_id=$1', [topup]);
    await reject('DELETE FROM gds_internal_payos_reconciliations WHERE topup_id=$1', [topup]);
    await reject('UPDATE gds_internal_payos_inbox SET status=\'RECEIVED\' WHERE id=$1', [inbox]);
  });
  it.each([
    ['amount_minor', '1'], ['payos_order_code', '40012345679'], ['payment_link_id', "'other-link'"],
    ['provider_event_identity', "'other-reference'"], ['currency', "'USD'"],
    ['qr_receiving_account_hash', "repeat('c',64)"], ['settlement_receiving_account_hash', "repeat('c',64)"],
    ['occurred_at', "i.occurred_at + interval '1 second'"],
    ['signature_verified_at', "i.signature_verified_at + interval '1 second'"],
    ['provider_reconciled_at', "i.signature_verified_at - interval '1 second'"],
  ])('rejects proof tampering: %s', async (field, value) => {
    await reject(proof({ [field]: value }), [inbox]);
  });
  it('requires proof before initial binding, verification or direct credit', async () => {
    await reject(bindSql, [topup, settlement]);
    await reject(`UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',collection_reference='bank-ref-001',
      signature_verified_at=now(),provider_reconciled_at=now() WHERE id=$1`, [topup]);
    await reject(creditSql, [wallet, topup], /not signed and reconciled|proof/);
    await reject('UPDATE gds_internal_topups SET settlement_receiving_account_hash=$2 WHERE id=$1', [topup, settlement]);
    await db.query(proof(), [inbox]);
    await reject(proof(), [inbox]);
    await reject(bindSql.replace("'bank-ref-001'", "'wrong-reference'"), [topup, settlement]);
  });
  it.each(["now()-interval '1 second'", "now()+interval '2 hours'"])(
    'rejects signed transfer outside intent lifetime: %s', async (time) => {
      // A separate immutable signed inbox row must not bless an out-of-window transfer.
      const otherInbox = randomUUID();
      await db.query(`INSERT INTO gds_internal_payos_inbox(id,topup_id,provider_event_identity,payos_order_code,
        payment_link_id,amount_minor,currency,receiving_account,receiving_account_hash,occurred_at,signature_verified_at)
        VALUES($1,$2,'outside-window',40012345678,'payos-link-a',85000,'VND','123456',$3,${time},now())`,
      [otherInbox, topup, settlement]);
      await reject(proof(), [otherInbox]);
    });
  it('does not resolve unrelated review reasons or rewrite terminal inbox rows', async () => {
    await db.query(`UPDATE gds_internal_payos_inbox SET status='REVIEW',review_reason='OTHER_REASON' WHERE id=$1`, [inbox]);
    await reject(proof(), [inbox]);
  });
  it('requires matching signed virtual-account evidence and keeps even null virtual hashes immutable', async () => {
    await reject('UPDATE gds_internal_payos_inbox SET virtual_receiving_account_hash=$2 WHERE id=$1', [inbox, qr]);
    const other = randomUUID();
    await db.query(`INSERT INTO gds_internal_payos_inbox(id,topup_id,provider_event_identity,payos_order_code,
      payment_link_id,amount_minor,currency,receiving_account,receiving_account_hash,virtual_receiving_account_hash,occurred_at,signature_verified_at)
      VALUES($1,$2,'contradictory-va',40012345678,'payos-link-a',85000,'VND','VA-bank_123',$3,$4,now(),now())`,
    [other, topup, settlement, settlement]);
    await reject(proof(), [other]);
    const matched = randomUUID();
    await db.query(`INSERT INTO gds_internal_payos_inbox(id,topup_id,provider_event_identity,payos_order_code,
      payment_link_id,amount_minor,currency,receiving_account,receiving_account_hash,virtual_receiving_account_hash,occurred_at,signature_verified_at)
      VALUES($1,$2,'matching-va',40012345678,'payos-link-a',85000,'VND','VA-bank_123',$3,$4,now(),now())`,
    [matched, topup, settlement, qr]);
    await db.query(proof(), [matched]);
  });
  it('rejects unsupported account characters and does not permit changing the lifetime lower bound', async () => {
    await reject(`INSERT INTO gds_internal_payos_inbox(topup_id,provider_event_identity,payos_order_code,
      payment_link_id,amount_minor,currency,receiving_account,receiving_account_hash,occurred_at,signature_verified_at)
      VALUES($1,'bad-account',40012345678,'payos-link-a',85000,'VND','bad account',$2,now(),now())`, [topup, settlement]);
    await reject(`UPDATE gds_internal_topups SET created_at=created_at-interval '1 day' WHERE id=$1`, [topup]);
  });
  it('rolls back proof, binding and journal together on transaction failure', async () => {
    await db.exec('SAVEPOINT before_settlement');
    await db.query(proof(), [inbox]);
    await db.query(bindSql, [topup, settlement]);
    await db.query(creditSql, [wallet, topup]);
    await db.exec('ROLLBACK TO SAVEPOINT before_settlement; RELEASE SAVEPOINT before_settlement');
    expect((await db.query('SELECT count(*)::int AS count FROM gds_internal_payos_reconciliations')).rows).toEqual([{ count: 0 }]);
    expect((await db.query('SELECT status,settlement_receiving_account_hash FROM gds_internal_topups WHERE id=$1', [topup])).rows)
      .toEqual([{ status: 'PENDING_PAYOS', settlement_receiving_account_hash: null }]);
    expect((await db.query('SELECT available_minor::text FROM gds_internal_wallets WHERE id=$1', [wallet])).rows).toEqual([{ available_minor: '0' }]);
  });
  it('preserves legacy no-inbox journal behavior without inventing a settlement binding', async () => {
    const legacy = randomUUID();
    await db.query(`INSERT INTO gds_internal_topups(id,buyer_id,wallet_id,request_key_hash,amount_minor,
      payos_order_code,transfer_memo,receiving_account_hash,payment_link_id,status,expires_at,updated_at)
      SELECT $1,buyer_id,wallet_id,repeat('d',64),85000,40012345679,'G00000002',receiving_account_hash,
      'legacy-link','PENDING_PAYOS',expires_at,now() FROM gds_internal_topups WHERE id=$2`, [legacy, topup]);
    await db.query(bindSql.replace("settlement_receiving_account_hash=$2,", '').replace("'bank-ref-001'", "'legacy-ref'"), [legacy]);
    await db.query(creditSql.replace("'bank-ref-001'", "'legacy-ref'"), [wallet, legacy]);
    expect((await db.query('SELECT settlement_receiving_account_hash FROM gds_internal_topups WHERE id=$1', [legacy])).rows)
      .toEqual([{ settlement_receiving_account_hash: null }]);
  });
});
