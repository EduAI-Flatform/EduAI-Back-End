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
      CREATE TYPE commerce_payment_status AS ENUM ('pending','paid','late_paid');
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
      CREATE TABLE commerce_payment_events(id uuid PRIMARY KEY, payment_attempt_id uuid, provider varchar(32),
        provider_settlement_reference varchar(128), next_status commerce_payment_status);
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
    const original = migration('20260824013000_add_commerce_persistence');
    // Execute the complete historical source validator, not a reconstructed stub.
    await db.exec(original.slice(original.indexOf('CREATE FUNCTION "commerce_validate_settlement"'),
      original.indexOf('CREATE FUNCTION "commerce_validate_reconciliation"')));
    await db.exec(migration('20261103030000_validate_gds_wallet_capture_settlement'));
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
    await rejected(settlement, /exact captured GDS proof/);
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

  it('rejects a competing provider attempt at settlement insertion', async () => {
    await post('RESERVE'); await post('CAPTURE');
    await db.query("INSERT INTO commerce_payment_attempts VALUES($1,$2,'pending')", [randomUUID(), orderId]);
    await rejected(settlement, /exact captured GDS proof/);
  });

  it('rejects proof belonging to another buyer', async () => {
    const other = randomUUID();
    await db.query('INSERT INTO users VALUES($1)', [other]);
    orderId = randomUUID();
    await db.query(`INSERT INTO commerce_orders(id,order_number,cart_id,buyer_id,subtotal_amount_minor,payable_amount_minor)
      VALUES($1,'OTHER-OWNER',$2,$3,50000,50000)`, [orderId, randomUUID(), other]);
    await post('RESERVE'); await post('CAPTURE');
    await rejected(settlement, /exact captured GDS proof/);
  });

  it.each(['cancelled', 'expired', 'late_payment_review', 'confirmed'])(
    'rejects a %s order even with capture proof', async (status) => {
      // Insert a separate authoritative order in this state: never disable a guard.
      const target = randomUUID();
      await db.query(`INSERT INTO commerce_orders(id,order_number,cart_id,buyer_id,subtotal_amount_minor,payable_amount_minor,status)
        VALUES($1,'TERMINAL',$2,$3,50000,50000,$4)`, [target, randomUUID(), buyerId, status]);
      orderId = target;
      await post('RESERVE'); await post('CAPTURE');
      await rejected(() => db.query(`INSERT INTO commerce_settlements(id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
        VALUES($1,$2,'wallet_capture','internal','gds',$3,50000,'VND')`, [randomUUID(), target, `gds:order:${target}`]), /exact captured GDS proof/);
    });

  it('rejects reserved-but-not-captured proof and missing canonical event identity', async () => {
    await post('RESERVE');
    await rejected(settlement, /exact captured GDS proof/);
    await db.query(`INSERT INTO gds_internal_journal(wallet_id,event_key,kind,amount_minor,available_delta_minor,held_delta_minor,clearing_delta_minor,order_ref)
      VALUES($1,'wrong-capture-key','CAPTURE',50000,0,-50000,50000,$2)`, [walletId, orderId]);
    await rejected(settlement, /exact captured GDS proof/);
  });

  it('rejects a capture amount differing from the authoritative order', async () => {
    orderId = randomUUID();
    await db.query(`INSERT INTO commerce_orders(id,order_number,cart_id,buyer_id,subtotal_amount_minor,payable_amount_minor)
      VALUES($1,'PROOF-AMOUNT',$2,$3,40000,40000)`, [orderId, randomUUID(), buyerId]);
    await post('RESERVE'); await post('CAPTURE');
    await rejected(() => db.query(`INSERT INTO commerce_settlements(id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES($1,$2,'wallet_capture','internal','gds',$3,40000,'VND')`, [randomUUID(),orderId,`gds:order:${orderId}`]), /exact captured GDS proof/);
  });

  it('rejects a second settlement for the same capture before confirmation', async () => {
    await post('RESERVE'); await post('CAPTURE'); await settlement();
    await rejected(settlement, /exact captured GDS proof/);
  });

  it.each([
    ['amount_minor', '49999'], ['currency', "'USD'"], ['disposition', "'matched'"],
    ['payment_attempt_id', "gen_random_uuid()"], ['payment_event_id', "gen_random_uuid()"],
  ])('rejects spoofed wallet settlement %s', async (field, value) => {
    await post('RESERVE'); await post('CAPTURE');
    const fields: Record<string, string> = { id: 'gen_random_uuid()', order_id: '$1', kind: "'wallet_capture'", disposition: "'internal'",
      provider: "'gds'", provider_settlement_reference: '$2', amount_minor: '50000', currency: "'VND'", [field]: value };
    await rejected(() => db.query(`INSERT INTO commerce_settlements(${Object.keys(fields).join(',')}) VALUES(${Object.values(fields).join(',')})`,
      [orderId, `gds:order:${orderId}`]), /authoritative order total|exact captured GDS proof/);
  });

  it('retains zero-payable settlement validation', async () => {
    const zero = randomUUID();
    await db.query(`INSERT INTO commerce_orders(id,order_number,cart_id,buyer_id,subtotal_amount_minor,payable_amount_minor)
      VALUES($1,'ZERO',$2,$3,0,0)`, [zero, randomUUID(), buyerId]);
    await db.query(`INSERT INTO commerce_settlements(id,order_id,kind,disposition,amount_minor,currency)
      VALUES($1,$2,'no_payment_required','internal',0,'VND')`, [randomUUID(), zero]);
    await rejected(() => db.query(`INSERT INTO commerce_settlements(id,order_id,kind,disposition,provider,amount_minor,currency)
      VALUES($1,$2,'no_payment_required','internal','gds',0,'VND')`, [randomUUID(), zero]), /invalid internal zero-payable settlement/);
  });

  it('retains exact external attempt/event proof and disposition validation', async () => {
    const attempt = randomUUID(), event = randomUUID();
    await db.query("INSERT INTO commerce_payment_attempts VALUES($1,$2,'paid')", [attempt, orderId]);
    await db.query("INSERT INTO commerce_payment_events VALUES($1,$2,'payos','external-reference','paid')", [event, attempt]);
    const external = (ref: string, disposition: string) => db.query(`INSERT INTO commerce_settlements
      (id,order_id,payment_attempt_id,payment_event_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES($1,$2,$3,$4,'provider_collection',$5,'payos',$6,50000,'VND')`, [randomUUID(),orderId,attempt,event,disposition,ref]);
    await rejected(() => external('spoofed-reference', 'matched'), /provider settlement does not match/);
    await rejected(() => external('external-reference', 'late_collection'), /disposition does not match/);
    await external('external-reference', 'matched');
  });

  it('rejects spoofed wallet settlement shape and an order reference mismatch', async () => {
    await rejected(() => db.query(`INSERT INTO commerce_settlements
      (id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES ($1,$2,'wallet_capture','internal','payos',$3,50000,'VND')`,
    [randomUUID(),orderId,`gds:order:${orderId}`]), /exact captured GDS proof/);
    await post('RESERVE'); await post('CAPTURE');
    await rejected(() => db.query(`INSERT INTO commerce_settlements
      (id,order_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency)
      VALUES ($1,$2,'wallet_capture','internal','gds','gds:order:wrong',50000,'VND')`,
    [randomUUID(),orderId]), /exact captured GDS proof/);
  });
});
