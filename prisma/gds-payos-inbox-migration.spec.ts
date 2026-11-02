import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string) => readFileSync(join(__dirname, 'migrations', name, 'migration.sql'), 'utf8');

describe('PAYW-04E signed PayOS inbox and atomic credit (synthetic PostgreSQL)', () => {
  let db: PGlite;
  let userId: string;
  let walletId: string;
  let topupId: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users (id uuid PRIMARY KEY);');
    await db.exec(migration('20261102030000_add_gds_internal_prepaid_journal'));
    await db.exec(migration('20261102080000_add_gds_payos_inbox'));
  }, 30_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    userId = randomUUID(); walletId = randomUUID(); topupId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES ($1)', [userId]);
    await db.query(`INSERT INTO gds_internal_wallets(id,buyer_id,updated_at)
      VALUES($1,$2,CURRENT_TIMESTAMP)`, [walletId, userId]);
    await db.query(`INSERT INTO gds_internal_topups (
      id,buyer_id,wallet_id,request_key_hash,amount_minor,currency,payos_order_code,
      transfer_memo,receiving_account_hash,payment_link_id,expires_at,updated_at,status
    ) VALUES($1,$2,$3,$4,85000,'VND',40012345678,'G00000001',$5,'payos-link-a',
      CURRENT_TIMESTAMP + INTERVAL '1 hour',CURRENT_TIMESTAMP,'PENDING_PAYOS')`,
    [topupId, userId, walletId, 'a'.repeat(64), 'b'.repeat(64)]);
    await db.query(`INSERT INTO gds_internal_payos_inbox (
      topup_id,provider_event_identity,payos_order_code,payment_link_id,amount_minor,
      currency,receiving_account,receiving_account_hash,occurred_at,signature_verified_at
    ) VALUES($1,'bank-ref-001',40012345678,'payos-link-a',85000,'VND',
      '123456789012',$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [topupId, 'b'.repeat(64)]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function reject(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT rejected');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally {
      await db.exec('ROLLBACK TO SAVEPOINT rejected');
      await db.exec('RELEASE SAVEPOINT rejected');
    }
  }

  async function credit() {
    await db.query(`UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',
      collection_reference='bank-ref-001',signature_verified_at=CURRENT_TIMESTAMP,
      provider_reconciled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [topupId]);
    await db.query(`INSERT INTO gds_internal_journal (
      wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,
      clearing_delta_minor,topup_id,collection_reference
    ) VALUES($1,'payos-gds-topup:40012345678','TOPUP_CREDIT',85000,85000,0,-85000,
      $2,'bank-ref-001')`, [walletId, topupId]);
    await db.query(`UPDATE gds_internal_payos_inbox SET status='PROCESSED',
      processed_at=CURRENT_TIMESTAMP,attempt_count=attempt_count+1
      WHERE provider_event_identity='bank-ref-001'`);
  }

  it('keeps webhook facts immutable and globally unique', async () => {
    await reject(() => db.query(`UPDATE gds_internal_payos_inbox SET amount_minor=100000
      WHERE topup_id=$1`, [topupId]), /immutable/);
    await reject(() => db.query(`DELETE FROM gds_internal_payos_inbox WHERE topup_id=$1`, [topupId]), /cannot be deleted/);
    await reject(() => db.query(`INSERT INTO gds_internal_payos_inbox (
      topup_id,provider_event_identity,payos_order_code,payment_link_id,amount_minor,
      currency,receiving_account,receiving_account_hash,occurred_at,signature_verified_at
    ) VALUES($1,'bank-ref-001',40012345678,'payos-link-a',85000,'VND',
      '123456789012',$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [topupId, 'b'.repeat(64)]), /unique constraint/);
    expect((await db.query('SELECT status FROM gds_internal_payos_inbox WHERE topup_id=$1', [topupId])).rows)
      .toEqual([{ status: 'RECEIVED' }]);
  });

  it('cannot credit until verified and provider-reconciled timestamps are recorded', async () => {
    await reject(() => db.query(`INSERT INTO gds_internal_journal (
      wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,
      clearing_delta_minor,topup_id,collection_reference
    ) VALUES($1,'fake-credit','TOPUP_CREDIT',85000,85000,0,-85000,$2,'bank-ref-001')`,
    [walletId, topupId]), /not signed and reconciled/);
    expect((await db.query('SELECT available_minor::text FROM gds_internal_wallets WHERE id=$1', [walletId])).rows)
      .toEqual([{ available_minor: '0' }]);
  });

  it('credits exactly 85000 once and makes topup, journal and inbox terminal together', async () => {
    await credit();
    expect((await db.query(`SELECT status FROM gds_internal_topups WHERE id=$1`, [topupId])).rows)
      .toEqual([{ status: 'CREDITED' }]);
    expect((await db.query('SELECT available_minor::text FROM gds_internal_wallets WHERE id=$1', [walletId])).rows)
      .toEqual([{ available_minor: '85000' }]);
    expect((await db.query('SELECT status FROM gds_internal_payos_inbox WHERE topup_id=$1', [topupId])).rows)
      .toEqual([{ status: 'PROCESSED' }]);
    await reject(() => db.query(`UPDATE gds_internal_payos_inbox SET status='RECEIVED'
      WHERE topup_id=$1`, [topupId]), /immutable/);
    await reject(() => db.query(`INSERT INTO gds_internal_journal (
      wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,
      clearing_delta_minor,topup_id,collection_reference
    ) VALUES($1,'payos-gds-topup:40012345678','TOPUP_CREDIT',85000,85000,0,-85000,$2,'bank-ref-001')`,
    [walletId, topupId]), /unique constraint/);
  });

  it('rolls back all three records if the process crashes before commit', async () => {
    await db.exec('SAVEPOINT before_processing');
    await credit();
    await db.exec('ROLLBACK TO SAVEPOINT before_processing');
    await db.exec('RELEASE SAVEPOINT before_processing');
    expect((await db.query('SELECT status FROM gds_internal_topups WHERE id=$1', [topupId])).rows)
      .toEqual([{ status: 'PENDING_PAYOS' }]);
    expect((await db.query('SELECT status FROM gds_internal_payos_inbox WHERE topup_id=$1', [topupId])).rows)
      .toEqual([{ status: 'RECEIVED' }]);
    expect((await db.query('SELECT available_minor::text FROM gds_internal_wallets WHERE id=$1', [walletId])).rows)
      .toEqual([{ available_minor: '0' }]);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM gds_internal_journal')).rows)
      .toEqual([{ count: 0 }]);
  });
});
