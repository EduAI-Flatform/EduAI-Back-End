'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
// Isolated schema inside the already-validated, disposable CI database only.
module.exports = async function quotaConcurrency(pool) {
  const schema = 'payw_quota_' + randomUUID().replace(/-/g, '');
  const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
  const [setup, a, b] = clients;
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const client of clients) await client.query(`SET search_path TO ${schema}, public`);
    await setup.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TYPE membership_plan_version_status AS ENUM ('draft','published');
      CREATE TABLE membership_plan_versions(id uuid PRIMARY KEY,status membership_plan_version_status DEFAULT 'draft');
      CREATE TABLE commerce_orders(id uuid PRIMARY KEY,buyer_id uuid REFERENCES users(id));
      CREATE TABLE commerce_order_lines(id uuid PRIMARY KEY,order_id uuid REFERENCES commerce_orders(id),product_type text,product_reference_id uuid);
      CREATE TABLE membership_checkout_intents(order_id uuid UNIQUE REFERENCES commerce_orders(id),version_id uuid REFERENCES membership_plan_versions(id),starts_at timestamp(3),ends_at timestamp(3));`);
    for (const migration of ['20260824170000_add_service_entitlements', '20261023021000_add_receipt_quota_pools']) {
      await setup.query(readFileSync(join(__dirname, '../prisma/migrations', migration, 'migration.sql'), 'utf8'));
    }
    const ids = Object.fromEntries(['buyer','order','line','version','definition','pool','old','a','b'].map(k => [k,randomUUID()]));
    await setup.query('INSERT INTO users VALUES($1)', [ids.buyer]);
    await setup.query('INSERT INTO membership_plan_versions(id) VALUES($1)', [ids.version]);
    await setup.query('INSERT INTO commerce_orders VALUES($1,$2)', [ids.order,ids.buyer]);
    await setup.query("INSERT INTO commerce_order_lines VALUES($1,$2,'membership',$3)", [ids.line,ids.order,ids.version]);
    await setup.query("INSERT INTO membership_checkout_intents VALUES($1,$2,'2026-10-01','2026-12-01')", [ids.order,ids.version]);
    await setup.query("INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id) VALUES($1,'SYNTHETIC_QUOTA','metered','calendar_month','Synthetic quota',$2)", [ids.definition,ids.buyer]);
    await setup.query("INSERT INTO membership_plan_entitlements(version_id,definition_id,value_type,reset_period,quota,created_by_id) VALUES($1,$2,'metered','calendar_month',3,$3)", [ids.version,ids.definition,ids.buyer]);
    await setup.query("INSERT INTO service_entitlement_quota_pools(id,order_line_id,user_id,definition_id,value_type,reset_period,quota,starts_at,ends_at) VALUES($1,$2,$3,$4,'metered','calendar_month',3,'2026-10-01','2026-12-01')", [ids.pool,ids.line,ids.buyer,ids.definition]);
    for (const name of ['old','a','b']) await setup.query("INSERT INTO service_entitlement_grants(id,user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at,quota_pool_id) VALUES($1,$2,$3,'UNVERIFIED_RECEIPT_ACCESS',$4,'metered','calendar_month',3,'2026-10-01','2026-12-01',$5)", [ids[name],ids.buyer,ids.definition,randomUUID()+':'+ids.line,ids.pool]);
    const consume = (client, grant, quantity, remaining) => client.query(`INSERT INTO service_entitlement_usage(grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
      VALUES($1,$2,$3,$4,$5,'2026-10-01','2026-11-01',$6,'2026-10-23')`, [grant,ids.buyer,randomUUID().replace(/-/g,'').repeat(2),'b'.repeat(64),quantity,remaining]);
    await consume(setup,ids.old,2,1);
    await setup.query("UPDATE service_entitlement_grants SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=$1",[ids.old]);
    const race = async (client,grant) => {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try { await consume(client,grant,1,0); await client.query('COMMIT'); }
      catch(error) { await client.query('ROLLBACK'); throw error; }
    };
    const outcomes = await Promise.allSettled([race(a,ids.a),race(b,ids.b)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    const failure=outcomes.find(r=>r.status==='rejected').reason;
    assert.ok(['23514','40001'].includes(failure.code), `Unexpected quota rejection ${failure.code}`);
    assert.equal((await setup.query('SELECT sum(quantity)::text AS used FROM service_entitlement_usage')).rows[0].used,'3');
    console.log('PASS real PostgreSQL shared quota final-unit race counts revoked usage across distinct grants');
  } finally {
    for (const client of clients) await client.query('SET search_path TO public');
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const client of clients) client.release();
  }
};