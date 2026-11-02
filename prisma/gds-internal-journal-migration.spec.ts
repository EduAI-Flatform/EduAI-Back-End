import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PAYW-04I/B internal GDS prepaid journal (synthetic PostgreSQL only)', () => {
  let db: PGlite;
  let buyerId: string;
  let walletId: string;
  let topupId: string;
  const amount = '100000';
  const collection = 'sandbox:payos-transfer-001';

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY);');
    await db.exec(readFileSync(join(__dirname, 'migrations/20261102030000_add_gds_internal_prepaid_journal/migration.sql'), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    buyerId = randomUUID(); walletId = randomUUID(); topupId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)', [buyerId]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [walletId, buyerId]);
    await db.query(`INSERT INTO gds_internal_topups
      (id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,expires_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,9000001234,'G00ABC123',$6,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [topupId, buyerId, walletId, 'b'.repeat(64), amount, 'a'.repeat(64)]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function rejected(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT negative_attempt');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT negative_attempt'); await db.exec('RELEASE SAVEPOINT negative_attempt'); }
  }

  const snapshot = () => db.query<{ available_minor: string; held_minor: string }>(
    'SELECT available_minor::text,held_minor::text FROM gds_internal_wallets WHERE id=$1', [walletId],
  );
  const count = () => db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM gds_internal_journal');
  const credit = (event = 'payos-gds-topup:9000001234', reference = collection, id = topupId) => db.query(`
    INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,topup_id,collection_reference)
    VALUES ($1,$2,'TOPUP_CREDIT',100000,100000,0,-100000,$3,$4)`, [walletId, event, id, reference]);
  const postOrder = (kind: 'RESERVE' | 'CAPTURE' | 'RELEASE', orderRef = 'sandbox:order-1', value = 30000, event = `${kind}:sandbox:order-1`) => {
    const deltas = {
      RESERVE: [-value, value, 0], CAPTURE: [0, -value, value], RELEASE: [value, -value, 0],
    }[kind];
    return db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [walletId, event, kind, value, ...deltas, orderRef]);
  };
  const verifyCollection = async () => {
    await db.query(`UPDATE gds_internal_topups SET status='PENDING_PAYOS',payment_link_id='sandbox:payos-link-1',updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [topupId]);
    await db.query(`UPDATE gds_internal_topups SET status='PAYOS_VERIFIED',collection_reference=$2,
      signature_verified_at=CURRENT_TIMESTAMP,provider_reconciled_at=CURRENT_TIMESTAMP+INTERVAL '1 second',updated_at=CURRENT_TIMESTAMP
      WHERE id=$1`, [topupId, collection]);
  };

  it('starts at zero and refuses a credit from only a QR or browser return', async () => {
    expect((await snapshot()).rows).toEqual([{ available_minor: '0', held_minor: '0' }]);
    expect((await count()).rows).toEqual([{ count: 0 }]);
    await rejected(() => credit(), /not signed and reconciled/);
    expect((await snapshot()).rows[0].available_minor).toBe('0');
  });

  it('credits exactly 100000 once after verified + reconciled collection, without fee deduction', async () => {
    await verifyCollection();
    await credit();
    expect((await snapshot()).rows).toEqual([{ available_minor: '100000', held_minor: '0' }]);
    expect((await db.query('SELECT status FROM gds_internal_topups WHERE id=$1', [topupId])).rows).toEqual([{ status: 'CREDITED' }]);
    await rejected(() => credit(), /duplicate key/);
    await rejected(() => credit('different-key'), /duplicate key/);
    expect((await count()).rows).toEqual([{ count: 1 }]);
  });

  it('enforces balanced immutable postings and prevents direct balance edits', async () => {
    await verifyCollection(); await credit();
    await rejected(() => db.exec('UPDATE gds_internal_journal SET amount_minor=1'), /append-only/);
    await rejected(() => db.exec('DELETE FROM gds_internal_journal'), /append-only/);
    await rejected(() => db.query('UPDATE gds_internal_wallets SET available_minor=999999 WHERE id=$1', [walletId]), /journal-controlled/);
    await rejected(() => db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,'unbalanced','RESERVE',1000,-1000,1000,1,'sandbox:order-2')`, [walletId]), /check constraint/);
    expect((await snapshot()).rows[0].available_minor).toBe('100000');
  });

  it('reserves without overspending and captures or releases each hold only once', async () => {
    await verifyCollection(); await credit();
    await postOrder('RESERVE');
    expect((await snapshot()).rows).toEqual([{ available_minor: '70000', held_minor: '30000' }]);
    await rejected(() => postOrder('RESERVE', 'sandbox:order-big', 80000, 'reserve-too-much'), /check constraint/);
    await rejected(() => postOrder('RESERVE'), /duplicate key/);
    await rejected(() => postOrder('CAPTURE', 'sandbox:order-1', 29000, 'wrong-capture'), /missing, mismatched or terminal/);
    await postOrder('CAPTURE');
    expect((await snapshot()).rows).toEqual([{ available_minor: '70000', held_minor: '0' }]);
    await rejected(() => postOrder('CAPTURE', 'sandbox:order-1', 30000, 'repeat-capture'), /missing, mismatched or terminal/);
    await rejected(() => postOrder('RELEASE'), /missing, mismatched or terminal/);
    await postOrder('RESERVE', 'sandbox:order-2', 20000, 'reserve-order-2');
    await postOrder('RELEASE', 'sandbox:order-2', 20000, 'release-order-2');
    expect((await snapshot()).rows).toEqual([{ available_minor: '70000', held_minor: '0' }]);
  });

  it('prevents cross-buyer topup credits, transfer-reference reuse, and direct CREDITED edits', async () => {
    const otherBuyer = randomUUID(); const otherWallet = randomUUID(); const otherTopup = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [otherBuyer]);
    await db.query('INSERT INTO gds_internal_wallets(id,buyer_id,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [otherWallet, otherBuyer]);
    await rejected(() => db.query(`INSERT INTO gds_internal_topups
      (id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,expires_at,updated_at)
      VALUES($1,$2,$3,$4,100000,9000001235,'G00ABC124',$5,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [otherTopup, otherBuyer, walletId, 'c'.repeat(64), 'a'.repeat(64)]), /buyer\/wallet mismatch/);
    await rejected(() => db.query(`UPDATE gds_internal_topups SET status='CREDITED', credited_at=CURRENT_TIMESTAMP WHERE id=$1`, [topupId]), /check constraint|backwards/);
    await verifyCollection(); await credit();
    await rejected(() => db.query(`INSERT INTO gds_internal_topups
      (id,buyer_id,wallet_id,request_key_hash,amount_minor,payos_order_code,transfer_memo,receiving_account_hash,collection_reference,expires_at,updated_at)
      VALUES($1,$2,$3,$4,100000,9000001236,'G00ABC125',$5,$6,CURRENT_TIMESTAMP+INTERVAL '15 minutes',CURRENT_TIMESTAMP)`,
    [otherTopup, otherBuyer, otherWallet, 'd'.repeat(64), 'a'.repeat(64), collection]), /duplicate key/);
    await rejected(() => db.query('DELETE FROM gds_internal_topups WHERE id=$1', [topupId]), /append-only/);
  });
});
