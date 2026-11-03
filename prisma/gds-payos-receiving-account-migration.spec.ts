import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PAYW-04 PayOS-provided beneficiary binding (synthetic PostgreSQL)', () => {
  let db: PGlite;
  let buyerId: string;
  let walletId: string;
  let topupId: string;
  const unbound = '0'.repeat(64);
  const bankHash = createHash('sha256').update('1234567890').digest('hex');

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY);');
    await db.exec(readFileSync(join(__dirname, 'migrations/20261102030000_add_gds_internal_prepaid_journal/migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(__dirname, 'migrations/20261103010000_bind_gds_payos_receiving_account/migration.sql'), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    buyerId = randomUUID(); walletId = randomUUID(); topupId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)', [buyerId]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [walletId, buyerId]);
    await db.query(`INSERT INTO gds_internal_topups
      (id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,$4,100000,900001234,'G0000ABCD',$5,CURRENT_TIMESTAMP + INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [topupId, buyerId, walletId, 'a'.repeat(64), unbound]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  const rejected = async (query: string, params: unknown[], message: RegExp) => {
    await db.exec('SAVEPOINT reject_invalid');
    try { await expect(db.query(query, params)).rejects.toThrow(message); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT reject_invalid'); await db.exec('RELEASE SAVEPOINT reject_invalid'); }
  };

  it('atomically binds exactly one valid account when first attaching a PayOS link', async () => {
    await db.query(`UPDATE gds_internal_topups SET status='PENDING_PAYOS',
      payment_link_id='payos-link-1', receiving_account_hash=$2 WHERE id=$1`, [topupId, bankHash]);
    expect((await db.query<{ receiving_account_hash: string; status: string }>(
      'SELECT receiving_account_hash,status FROM gds_internal_topups WHERE id=$1', [topupId],
    )).rows).toEqual([{ receiving_account_hash: bankHash, status: 'PENDING_PAYOS' }]);
    await rejected('UPDATE gds_internal_topups SET receiving_account_hash=$2 WHERE id=$1',
      [topupId, 'b'.repeat(64)], /immutable/);
    await rejected('UPDATE gds_internal_topups SET amount_minor=1 WHERE id=$1', [topupId], /immutable/);
  });

  it('cannot proceed with an unbound recipient or change account before linking', async () => {
    await rejected("UPDATE gds_internal_topups SET status='PENDING_PAYOS',payment_link_id='payos-link-1' WHERE id=$1",
      [topupId], /bound_link_check/);
    await rejected('UPDATE gds_internal_topups SET receiving_account_hash=$2 WHERE id=$1',
      [topupId, bankHash], /immutable/);
    await rejected("UPDATE gds_internal_topups SET status='PENDING_PAYOS',receiving_account_hash=$2 WHERE id=$1",
      [topupId, bankHash], /immutable/);
    await rejected("UPDATE gds_internal_topups SET status='PENDING_PAYOS',payment_link_id='payos-link-1',receiving_account_hash=$2 WHERE id=$1",
      [topupId, unbound], /bound_link_check/);
  });

  it('preserves legacy bound account immutability and rejects deleting the audit record', async () => {
    await rejected('DELETE FROM gds_internal_topups WHERE id=$1', [topupId], /append-only/);
    await db.query("UPDATE gds_internal_topups SET status='CANCELLED' WHERE id=$1", [topupId]);
    await rejected('UPDATE gds_internal_topups SET receiving_account_hash=$2 WHERE id=$1',
      [topupId, bankHash], /immutable/);
  });
});
