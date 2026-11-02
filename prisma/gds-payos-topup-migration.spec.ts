import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PAYW-04 PayOS topup intent (collection never mints wallet funds)', () => {
  let db: PGlite;
  let buyerId: string;
  let topupId: string;
  const hash = 'a'.repeat(64);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE commerce_orders(id uuid PRIMARY KEY);');
    await db.exec(readFileSync(join(__dirname, 'migrations/20261102010000_add_buyer_wallet_mirror/migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(__dirname, 'migrations/20261102020000_add_gds_payos_topup_intents/migration.sql'), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    buyerId = randomUUID(); topupId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)', [buyerId]);
    await db.query(`INSERT INTO buyer_wallet_payos_topups
      (id,buyer_id,request_key_hash,amount_minor,payos_order_code,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,100000,900000001234,$4,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [topupId, buyerId, 'b'.repeat(64), hash]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function negative(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT topup_negative');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT topup_negative'); await db.exec('RELEASE SAVEPOINT topup_negative'); }
  }

  it('starts unpaid and has no provider wallet-credit event', async () => {
    const { rows } = await db.query('SELECT status,collection_reference,partner_credit_event_id FROM buyer_wallet_payos_topups');
    expect(rows).toEqual([{ status: 'CREATED', collection_reference: null, partner_credit_event_id: null }]);
  });

  it('prevents duplicate payment codes and replayed idempotency identities', async () => {
    const otherId = randomUUID();
    await negative(() => db.query(`INSERT INTO buyer_wallet_payos_topups
      (id,buyer_id,request_key_hash,amount_minor,payos_order_code,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,100000,900000001234,$4,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [otherId, buyerId, 'c'.repeat(64), hash]), /duplicate key/);
    await negative(() => db.query(`INSERT INTO buyer_wallet_payos_topups
      (id,buyer_id,request_key_hash,amount_minor,payos_order_code,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,100000,900000001235,$4,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [otherId, buyerId, 'b'.repeat(64), hash]), /duplicate key/);
  });

  it('requires PayOS verification and partner credit in order, then blocks reversal', async () => {
    await db.query("UPDATE buyer_wallet_payos_topups SET status='PENDING_PAYOS',payos_payment_link_id='payos-link-1' WHERE id=$1", [topupId]);
    await negative(() => db.query("UPDATE buyer_wallet_payos_topups SET status='CREDITED',partner_credit_event_id='fake-credit',credited_at=CURRENT_TIMESTAMP WHERE id=$1", [topupId]), /backwards|check constraint/);
    await negative(() => db.query("UPDATE buyer_wallet_payos_topups SET status='PAYOS_VERIFIED',collection_reference='payos-transfer-1' WHERE id=$1", [topupId]), /check constraint/);
    await db.query("UPDATE buyer_wallet_payos_topups SET status='PAYOS_VERIFIED',collection_reference='payos-transfer-1',payos_verified_at=CURRENT_TIMESTAMP WHERE id=$1", [topupId]);
    await negative(() => db.query("UPDATE buyer_wallet_payos_topups SET partner_credit_event_id='unverified-partner' WHERE id=$1", [topupId]), /check constraint/);
    await db.query("UPDATE buyer_wallet_payos_topups SET status='PENDING_PARTNER' WHERE id=$1", [topupId]);
    await db.query("UPDATE buyer_wallet_payos_topups SET status='CREDITED',partner_credit_event_id='partner-credit-1',credited_at=CURRENT_TIMESTAMP WHERE id=$1", [topupId]);
    await negative(() => db.query("UPDATE buyer_wallet_payos_topups SET status='PAYOS_VERIFIED' WHERE id=$1", [topupId]), /backwards/);
    await negative(() => db.query('UPDATE buyer_wallet_payos_topups SET amount_minor=1 WHERE id=$1', [topupId]), /immutable/);
    await negative(() => db.query('DELETE FROM buyer_wallet_payos_topups WHERE id=$1', [topupId]), /append-only/);
  });

  it('permits cancelled-then-late collection review but never credits from UI cancellation', async () => {
    await db.query("UPDATE buyer_wallet_payos_topups SET status='CANCELLED' WHERE id=$1", [topupId]);
    await db.query("UPDATE buyer_wallet_payos_topups SET status='REVIEW',collection_reference='late-bank-transfer' WHERE id=$1", [topupId]);
    await negative(() => db.query("UPDATE buyer_wallet_payos_topups SET status='CREDITED',partner_credit_event_id='fake-credit',credited_at=CURRENT_TIMESTAMP WHERE id=$1", [topupId]), /backwards/);
  });

  it('rejects zero/negative amounts, non-VND and forged receiving-account hash', async () => {
    await negative(() => db.query('UPDATE buyer_wallet_payos_topups SET receiving_account_hash=$1 WHERE id=$2', ['not-a-hash', topupId]), /immutable/);
    const id = randomUUID();
    await negative(() => db.query(`INSERT INTO buyer_wallet_payos_topups
      (id,buyer_id,request_key_hash,amount_minor,currency,payos_order_code,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,0,'USD',900000001236,$4,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [id, buyerId, 'd'.repeat(64), hash]), /check constraint/);
  });
});
