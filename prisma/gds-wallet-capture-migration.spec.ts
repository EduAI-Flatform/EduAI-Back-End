import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = (name: string) => readFileSync(join(__dirname, 'migrations', name, 'migration.sql'), 'utf8');

describe('PAYW-04C SQL wallet-capture proof (synthetic PostgreSQL only)', () => {
  let db: PGlite;
  let buyerId: string;
  let walletId: string;
  let orderId: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users(id uuid PRIMARY KEY);');
    await db.exec(migration('20261102030000_add_gds_internal_prepaid_journal'));
    await db.exec(`
      CREATE TYPE commerce_settlement_kind AS ENUM ('provider_collection', 'no_payment_required');
      CREATE TYPE commerce_settlement_disposition AS ENUM ('matched', 'duplicate_collection', 'late_collection', 'internal');
      CREATE TABLE commerce_orders (
        id uuid PRIMARY KEY, order_number text NOT NULL, cart_id uuid NOT NULL, buyer_id uuid NOT NULL,
        subtotal_amount_minor bigint NOT NULL, discount_amount_minor bigint NOT NULL DEFAULT 0,
        payable_amount_minor bigint NOT NULL, currency text NOT NULL DEFAULT 'VND',
        pricing_policy_version text NOT NULL DEFAULT 'test', created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status text NOT NULL DEFAULT 'pending_payment', status_operation_id uuid,
        fulfillment_status text NOT NULL DEFAULT 'not_started', fulfillment_operation_id uuid,
        confirmed_settlement_id uuid, confirmed_at timestamp, cancelled_at timestamp,
        expired_at timestamp, archived_at timestamp
      );
      CREATE TABLE commerce_payment_attempts(id uuid PRIMARY KEY, order_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE commerce_settlements (
        id uuid PRIMARY KEY, order_id uuid NOT NULL, payment_attempt_id uuid, payment_event_id uuid,
        kind commerce_settlement_kind NOT NULL, disposition commerce_settlement_disposition NOT NULL,
        provider text, provider_settlement_reference text, amount_minor bigint NOT NULL, currency text NOT NULL,
        CONSTRAINT commerce_settlements_shape_check CHECK (
          kind = 'provider_collection' OR kind = 'no_payment_required'
        )
      );
    `);
    await db.exec(migration('20261102050000_add_gds_wallet_capture_settlement_enum'));
    await db.exec(migration('20261102060000_add_gds_wallet_capture_settlement_proof'));
    await db.exec(migration('20261102070000_require_verified_gds_capture_for_order'));
    await db.exec(`CREATE TRIGGER commerce_orders_guard_update BEFORE UPDATE ON commerce_orders
      FOR EACH ROW EXECUTE FUNCTION commerce_guard_order_update();`);
  }, 30_000);

  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    buyerId = randomUUID(); walletId = randomUUID(); orderId = randomUUID();
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1)', [buyerId]);
    // Synthetic starting credit is inserted into the opening snapshot only;
    // all subsequent reserve/capture writes go through the immutable journal.
    await db.query(`INSERT INTO gds_internal_wallets(id,buyer_id,available_minor,updated_at)
      VALUES ($1,$2,100000,CURRENT_TIMESTAMP)`, [walletId, buyerId]);
    await db.query(`INSERT INTO commerce_orders
      (id,order_number,cart_id,buyer_id,subtotal_amount_minor,payable_amount_minor)
      VALUES ($1,'SYNTHETIC-CAPTURE',$2,$3,50000,50000)`, [orderId,randomUUID(),buyerId]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  async function rejected(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec('SAVEPOINT negative_attempt');
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT negative_attempt'); await db.exec('RELEASE SAVEPOINT negative_attempt'); }
  }

  const post = (kind: 'RESERVE' | 'CAPTURE') => {
    const deltas = kind === 'RESERVE' ? [-50000, 50000, 0] : [0, -50000, 50000];
    return db.query(`INSERT INTO gds_internal_journal
      (wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,$2,$3,50000,$4,$5,$6,$7)`, [walletId, `gds:${kind.toLowerCase()}:${orderId}`, kind, ...deltas, orderId]);
  };
  const settlement = () => db.query(`INSERT INTO commerce_settlements
    (id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
    VALUES ($1,$2,'wallet_capture','internal','gds',$3,50000,'VND')`,
  [randomUUID(),orderId,`gds:order:${orderId}`]);
  const confirm = () => db.query(`UPDATE commerce_orders SET status='confirmed', confirmed_at=CURRENT_TIMESTAMP,
    confirmed_settlement_id=(SELECT id FROM commerce_settlements WHERE order_id=$1 LIMIT 1),
    status_operation_id=$2 WHERE id=$1`, [orderId,randomUUID()]);

  it('rejects a fabricated wallet settlement that lacks a CAPTURE journal/hold', async () => {
    await settlement();
    await rejected(confirm, /confirming settlement must belong to the order and be confirmable/);
  });

  it('accepts exact reserve + capture + wallet settlement and preserves balances', async () => {
    await post('RESERVE'); await post('CAPTURE'); await settlement(); await confirm();
    expect((await db.query('SELECT status FROM commerce_orders WHERE id=$1', [orderId])).rows)
      .toEqual([{ status: 'confirmed' }]);
    expect((await db.query('SELECT available_minor::text,held_minor::text FROM gds_internal_wallets WHERE id=$1', [walletId])).rows)
      .toEqual([{ available_minor: '50000', held_minor: '0' }]);
    expect((await db.query('SELECT status FROM gds_internal_holds WHERE order_ref=$1', [orderId])).rows)
      .toEqual([{ status: 'CAPTURED' }]);
  });

  it('rejects confirmed GDS even with proof if an external payment attempt exists', async () => {
    await post('RESERVE'); await post('CAPTURE'); await settlement();
    await db.query('INSERT INTO commerce_payment_attempts(id,order_id,status) VALUES ($1,$2,\'pending\')',
    [randomUUID(),orderId]);
    await rejected(confirm, /confirming settlement must belong to the order and be confirmable/);
  });

  it('rejects spoofed wallet settlement shape and an order reference mismatch', async () => {
    await rejected(() => db.query(`INSERT INTO commerce_settlements
      (id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES ($1,$2,'wallet_capture','internal','payos',$3,50000,'VND')`,
    [randomUUID(),orderId,`gds:order:${orderId}`]), /check constraint/);
    await post('RESERVE'); await post('CAPTURE');
    await db.query(`INSERT INTO commerce_settlements
      (id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES ($1,$2,'wallet_capture','internal','gds','gds:order:wrong',50000,'VND')`,
    [randomUUID(),orderId]);
    await rejected(confirm, /confirming settlement must belong to the order and be confirmable/);
  });
});
