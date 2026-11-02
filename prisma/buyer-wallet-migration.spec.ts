import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PAYW-04 shadow-wallet database boundary (no real money)', () => {
  let db: PGlite;
  let ownerId: string;
  let walletId: string;
  let orderId: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE commerce_orders(id uuid PRIMARY KEY);');
    await db.exec(readFileSync(join(__dirname, 'migrations/20261102010000_add_buyer_wallet_mirror/migration.sql'), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    ownerId = randomUUID(); walletId = randomUUID(); orderId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)', [ownerId]);
    await db.query('INSERT INTO commerce_orders(id) VALUES($1)', [orderId]);
    await db.query(`INSERT INTO buyer_wallet_links(id,buyer_id,partner_code,partner_wallet_ref,updated_at)
      VALUES($1,$2,'sandbox','sandbox-wallet-1',CURRENT_TIMESTAMP)`, [walletId, ownerId]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function expectRejected(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    await db.exec('SAVEPOINT wallet_negative_test');
    try {
      await expect(action()).rejects.toThrow(pattern);
    } finally {
      await db.exec('ROLLBACK TO SAVEPOINT wallet_negative_test');
      await db.exec('RELEASE SAVEPOINT wallet_negative_test');
    }
  }

  const event = (linkId: string, id = 'sandbox:event-1', transactionId = 'sandbox:tx-1', amount = '100000') =>
    db.query(`INSERT INTO buyer_wallet_verified_events
      (wallet_link_id,provider_event_id,provider_transaction_id,kind,amount_minor,occurred_at)
      VALUES($1,$2,$3,'FUNDS_CREDITED',$4,CURRENT_TIMESTAMP)`, [linkId, id, transactionId, amount]);

  it('starts empty: no fabricated wallet balance, no automatic provider event', async () => {
    expect((await db.query('SELECT COUNT(*)::int AS count FROM buyer_wallet_verified_events')).rows).toEqual([{ count: 0 }]);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM buyer_wallet_reservations')).rows).toEqual([{ count: 0 }]);
  });

  it('rejects duplicate partner credit across different users and wallets', async () => {
    await event(walletId);
    const other = randomUUID(); const otherWallet = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [other]);
    await db.query(`INSERT INTO buyer_wallet_links(id,buyer_id,partner_code,partner_wallet_ref,updated_at)
      VALUES($1,$2,'sandbox','sandbox-wallet-2',CURRENT_TIMESTAMP)`, [otherWallet, other]);
    await expectRejected(() => event(otherWallet), /duplicate key/);
  });

  it('rejects a re-used authenticated provider transaction ID', async () => {
    await event(walletId);
    await expectRejected(() => event(walletId, 'sandbox:event-2'), /duplicate key/);
  });

  it('keeps verified facts append-only and amounts strictly positive VND', async () => {
    await event(walletId);
    await expectRejected(() => db.exec("UPDATE buyer_wallet_verified_events SET amount_minor=999999"), /append-only/);
    await expectRejected(() => db.exec('DELETE FROM buyer_wallet_verified_events'), /append-only/);
    await expectRejected(() => event(walletId, 'sandbox:zero', 'sandbox:zero-tx', '0'), /check constraint/);
    await expectRejected(() => db.query(`INSERT INTO buyer_wallet_verified_events
      (wallet_link_id,provider_event_id,provider_transaction_id,kind,amount_minor,currency,occurred_at)
      VALUES($1,'sandbox:usd','sandbox:usd-tx','FUNDS_CREDITED',100,'USD',CURRENT_TIMESTAMP)`, [walletId]), /check constraint/);
  });

  it('prevents reusing a course/membership order reservation and invalid status', async () => {
    await db.query(`INSERT INTO buyer_wallet_reservations
      (wallet_link_id,order_id,provider_reservation_id,amount_minor,updated_at)
      VALUES($1,$2,'sandbox:reserve-1',50000,CURRENT_TIMESTAMP)`, [walletId, orderId]);
    await expectRejected(() => db.query(`INSERT INTO buyer_wallet_reservations
      (wallet_link_id,order_id,provider_reservation_id,amount_minor,updated_at)
      VALUES($1,$2,'sandbox:reserve-2',50000,CURRENT_TIMESTAMP)`, [walletId, orderId]), /duplicate key/);
    await expectRejected(() => db.exec("UPDATE buyer_wallet_reservations SET status='PAID_BY_BROWSER'"), /check constraint/);
  });
});
