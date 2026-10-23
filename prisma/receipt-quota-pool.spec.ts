import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('receipt quota pool PostgreSQL boundary', () => {
  let db: PGlite;
  let buyer: string; let other: string; let order: string; let line: string; let version: string; let definition: string; let pool: string;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TYPE membership_plan_version_status AS ENUM ('draft','published');
      CREATE TABLE membership_plan_versions(id uuid PRIMARY KEY,status membership_plan_version_status DEFAULT 'draft');
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,buyer_id uuid REFERENCES users(id));
      CREATE TABLE commerce_order_lines(id uuid PRIMARY KEY,order_id uuid REFERENCES commerce_orders(id),product_type text,product_reference_id uuid);
      CREATE TABLE membership_checkout_intents(order_id uuid UNIQUE REFERENCES commerce_orders(id),version_id uuid REFERENCES membership_plan_versions(id),starts_at timestamp(3),ends_at timestamp(3));`);
    await db.exec(readFileSync(join(__dirname, 'migrations/20260824170000_add_service_entitlements/migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(__dirname, 'migrations/20261023021000_add_receipt_quota_pools/migration.sql'), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    [buyer, other, order, line, version, definition, pool] = Array.from({ length: 7 }, () => randomUUID());
    await db.exec('BEGIN');
    await db.query('INSERT INTO users(id) VALUES($1),($2)', [buyer, other]);
    await db.query('INSERT INTO membership_plan_versions(id) VALUES($1)', [version]);
    await db.query('INSERT INTO commerce_orders(id,buyer_id) VALUES($1,$2)', [order, buyer]);
    await db.query("INSERT INTO commerce_order_lines VALUES($1,$2,'membership',$3)", [line, order, version]);
    await db.query("INSERT INTO membership_checkout_intents VALUES($1,$2,'2026-10-01','2026-12-01')", [order, version]);
    await db.query(`INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id)
      VALUES($1,'SYNTHETIC_QUOTA','metered','calendar_month','Synthetic quota',$2)`, [definition, buyer]);
    await db.query(`INSERT INTO membership_plan_entitlements(version_id,definition_id,value_type,reset_period,quota,created_by_id)
      VALUES($1,$2,'metered','calendar_month',3,$3)`, [version, definition, buyer]);
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  const insertPool = (options: { id?: string; user?: string; quota?: number; lineId?: string } = {}) => db.query(`
    INSERT INTO service_entitlement_quota_pools(id,order_line_id,user_id,definition_id,value_type,reset_period,quota,starts_at,ends_at)
    VALUES($1,$2,$3,$4,'metered','calendar_month',$5,'2026-10-01','2026-12-01')`,
  [options.id ?? pool, options.lineId ?? line, options.user ?? buyer, definition, options.quota ?? 3]);
  const insertGrant = async (options: { poolId?: string | null; user?: string; quota?: number; sourceType?: string; sourceId?: string } = {}) => {
    const id = randomUUID();
    await db.query(`INSERT INTO service_entitlement_grants(id,user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at,quota_pool_id)
      VALUES($1,$2,$3,$4,$5,'metered','calendar_month',$6,'2026-10-01','2026-12-01',$7)`,
    [id, options.user ?? buyer, definition, options.sourceType ?? 'UNVERIFIED_RECEIPT_ACCESS', options.sourceId ?? `${randomUUID()}:${line}`, options.quota ?? 3,
      options.poolId === undefined ? pool : options.poolId]);
    return id;
  };
  const consume = (grantId: string, quantity: number, remaining: number, month = '10', userId = buyer) => db.query(`
    INSERT INTO service_entitlement_usage(grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [grantId, userId, randomUUID().replace(/-/g, '').repeat(2), 'b'.repeat(64), quantity,
    `2026-${month}-01`, month === '10' ? '2026-11-01' : '2026-12-01', remaining, `2026-${month}-23`]);
  const revoke = (grantId: string) => db.query("UPDATE service_entitlement_grants SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=$1", [grantId]);
  const rejects = async (operation: () => Promise<unknown>, message: RegExp) => {
    await db.exec('SAVEPOINT expected_rejection');
    await expect(operation()).rejects.toThrow(message);
    await db.exec('ROLLBACK TO SAVEPOINT expected_rejection');
  };

  it('counts consumed units across revoked, restored and canonical paid grants without fake usage', async () => {
    await insertPool();
    const early = await insertGrant();
    await consume(early, 2, 1);
    await revoke(early);
    const restored = await insertGrant();
    await consume(restored, 1, 0);
    await revoke(restored);
    const paid = await insertGrant({ sourceType: 'membership', sourceId: line });
    await rejects(() => consume(paid, 1, 0), /quota exhausted/);
    expect((await db.query('SELECT SUM(quantity)::text AS used,COUNT(*)::int AS count FROM service_entitlement_usage')).rows).toEqual([{ used: '3', count: 2 }]);
  });
  it('resets calendar-month quota without carrying usage into a different period', async () => {
    await insertPool(); const early = await insertGrant(); await consume(early, 3, 0); await revoke(early);
    const paid = await insertGrant({ sourceType: 'membership', sourceId: line });
    await consume(paid, 1, 2, '11');
    await rejects(() => consume(paid, 3, 0, '11'), /quota exhausted/);
  });
  it('keeps membership-term usage spent across months and verified conversion', async () => {
    const termDefinition = randomUUID(); const termPool = randomUUID(); const early = randomUUID(); const paid = randomUUID();
    await db.query(`INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id)
      VALUES($1,'SYNTHETIC_TERM','metered','membership_term','Synthetic term',$2)`, [termDefinition, buyer]);
    await db.query(`INSERT INTO membership_plan_entitlements(version_id,definition_id,value_type,reset_period,quota,created_by_id)
      VALUES($1,$2,'metered','membership_term',3,$3)`, [version, termDefinition, buyer]);
    await db.query(`INSERT INTO service_entitlement_quota_pools(id,order_line_id,user_id,definition_id,value_type,reset_period,quota,starts_at,ends_at)
      VALUES($1,$2,$3,$4,'metered','membership_term',3,'2026-10-01','2026-12-01')`, [termPool, line, buyer, termDefinition]);
    for (const [id, type, source] of [[early, 'UNVERIFIED_RECEIPT_ACCESS', `${randomUUID()}:${line}`], [paid, 'membership', line]]) {
      await db.query(`INSERT INTO service_entitlement_grants(id,user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at,quota_pool_id)
        VALUES($1,$2,$3,$4,$5,'metered','membership_term',3,'2026-10-01','2026-12-01',$6)`, [id, buyer, termDefinition, type, source, termPool]);
    }
    const termUsage = (grantId: string, quantity: number, remaining: number, at: string, key: string) => db.query(`
      INSERT INTO service_entitlement_usage(grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
      VALUES($1,$2,$3,$3,$4,'2026-10-01','2026-12-01',$5,$6)`, [grantId, buyer, key.repeat(64), quantity, remaining, at]);
    await termUsage(early, 2, 1, '2026-10-23', 'c');
    await revoke(early);
    await termUsage(paid, 1, 0, '2026-11-23', 'd');
    await rejects(() => termUsage(paid, 1, 0, '2026-11-24', 'e'), /quota exhausted/);
  });
  it('keeps independent membership lines in independent quota pools', async () => {
    await insertPool(); const early = await insertGrant(); await consume(early, 3, 0);
    const secondLine = randomUUID(); const secondPool = randomUUID();
    await db.query("INSERT INTO commerce_order_lines VALUES($1,$2,'membership',$3)", [secondLine, order, version]);
    await insertPool({ id: secondPool, lineId: secondLine });
    const independent = await insertGrant({ poolId: secondPool, sourceId: `${randomUUID()}:${secondLine}` });
    await consume(independent, 3, 0);
    expect((await db.query('SELECT SUM(quantity)::text AS used FROM service_entitlement_usage')).rows).toEqual([{ used: '6' }]);
  });
  it('rejects pool snapshots for another buyer, amount or nonmembership line', async () => {
    await rejects(() => insertPool({ user: other }), /membership order snapshot/);
    await rejects(() => insertPool({ quota: 4 }), /membership order snapshot/);
    await db.query("UPDATE commerce_order_lines SET product_type='course' WHERE id=$1", [line]);
    await rejects(() => insertPool(), /membership order snapshot/);
  });
  it('rejects grant mismatches and an unrelated canonical source', async () => {
    await insertPool();
    await rejects(() => insertGrant({ user: other }), /quota pool snapshot/);
    await rejects(() => insertGrant({ quota: 4 }), /quota pool snapshot/);
    await rejects(() => insertGrant({ sourceType: 'membership', sourceId: randomUUID() }), /quota pool snapshot/);
  });
  it('makes the pool and assignment immutable, including attaching a legacy grant', async () => {
    const legacy = await insertGrant({ poolId: null, sourceType: 'LEGACY', sourceId: 'legacy-term' });
    await insertPool();
    const early = await insertGrant();
    await rejects(() => db.query('UPDATE service_entitlement_quota_pools SET quota=4 WHERE id=$1', [pool]), /immutable/);
    await rejects(() => db.query('DELETE FROM service_entitlement_quota_pools WHERE id=$1', [pool]), /immutable/);
    await rejects(() => db.query('UPDATE service_entitlement_grants SET quota_pool_id=NULL WHERE id=$1', [early]), /assignment is immutable/);
    await rejects(() => db.query('UPDATE service_entitlement_grants SET quota_pool_id=$1 WHERE id=$2', [pool, legacy]), /assignment is immutable/);
  });
  it('rejects omission of pool on early or converted canonical grants', async () => {
    await insertPool();
    await rejects(() => insertGrant({ poolId: null }), /retain their quota pool/);
    await rejects(() => insertGrant({ poolId: null, sourceType: 'membership', sourceId: line }), /retain their quota pool/);
  });
  it('preserves the legacy nonpooled quota and owning grant checks', async () => {
    const legacy = await insertGrant({ poolId: null, sourceType: 'LEGACY', sourceId: 'legacy' });
    await consume(legacy, 3, 0);
    await rejects(() => consume(legacy, 1, 0), /quota exhausted/);
    await rejects(() => consume(legacy, 1, 0, '11', other), /owning grant/);
  });
  it('preserves window, status and remaining-snapshot protections for pooled grants', async () => {
    await insertPool(); const early = await insertGrant();
    await rejects(() => consume(early, 1, 0), /remaining snapshot/);
    await rejects(() => db.query(`INSERT INTO service_entitlement_usage(grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
      VALUES($1,$2,$3,$3,1,'2026-10-02','2026-11-01',2,'2026-10-23')`, [early, buyer, 'f'.repeat(64)]), /owning grant/);
    await revoke(early);
    await rejects(() => consume(early, 1, 2), /owning grant/);
  });
});
