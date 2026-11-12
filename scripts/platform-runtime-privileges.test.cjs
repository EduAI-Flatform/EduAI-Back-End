const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const {
  PLATFORM_RUNTIME_TABLES,
  PLATFORM_RUNTIME_UPDATES,
  PLATFORM_RUNTIME_SCHEMA_QUERY,
  buildRuntimePlatformPrivilegeStatement,
  grantRuntimeMembershipPrivileges,
} = require('./membership-runtime-privileges.cjs');

const expectedUpdates = {
  platform_policy_revisions: ['status', 'approved_by_id', 'approved_at', 'effective_at'],
  platform_support_tickets: ['status', 'updated_at'],
  platform_support_replies: [],
  platform_partner_applications: ['status', 'updated_at'],
  user_mfa: ['revision', 'enabled', 'secret_encrypted', 'pending_secret_encrypted', 'pending_expires_at', 'last_used_step', 'recovery_code_hashes', 'enabled_at', 'updated_at'],
  affiliate_identities: [], affiliate_visits: [], affiliate_attributions: [], affiliate_accruals: [],
};
const tables = Object.keys(expectedUpdates);
const runtimeUrl = 'postgresql://platform_runtime@localhost/test';
const owner = '10000000-0000-4000-8000-000000000001';
const policy = '10000000-0000-4000-8000-000000000002';
const ticket = '10000000-0000-4000-8000-000000000003';
const identity = '10000000-0000-4000-8000-000000000004';
const visit = '10000000-0000-4000-8000-000000000005';
const attribution = '10000000-0000-4000-8000-000000000006';
const order = '10000000-0000-4000-8000-000000000007';

async function database() {
  const db = new PGlite();
  await db.exec('CREATE ROLE platform_runtime NOLOGIN; CREATE ROLE unrelated_runtime NOLOGIN; CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE commerce_orders(id uuid PRIMARY KEY); CREATE TABLE commerce_settlements(id uuid PRIMARY KEY); CREATE TABLE commerce_refunds(id uuid PRIMARY KEY);');
  for (const migration of [
    '20261111090000_platform_policy_revisions', '20261111120000_add_platform_requests',
    '20261111150000_user_mfa', '20261111160000_affiliate', '20261111170000_support_image',
  ]) await db.exec(readFileSync(join(__dirname, '../prisma/migrations', migration, 'migration.sql'), 'utf8'));
  await db.query('INSERT INTO users(id) VALUES ($1)', [owner]);
  await db.query('INSERT INTO commerce_orders(id) VALUES ($1)', [order]);
  return db;
}

test('application matrix contains exactly nine tables and seventeen approved update columns', () => {
  assert.deepEqual(PLATFORM_RUNTIME_TABLES, tables);
  assert.deepEqual(PLATFORM_RUNTIME_UPDATES, expectedUpdates);
  assert.equal(Object.values(PLATFORM_RUNTIME_UPDATES).flat().length, 17);
  assert.equal(buildRuntimePlatformPrivilegeStatement(runtimeUrl, []), '');
  assert.throws(() => buildRuntimePlatformPrivilegeStatement(runtimeUrl, [{ name: 'commerce_orders', columns: ['id'] }]), /Unexpected/);
  assert.throws(() => buildRuntimePlatformPrivilegeStatement('https://example.test', []), /runtime role/);
});

test('migrated application tables support reads, inserts and approved lifecycle changes while denying immutable writes', async () => {
  const db = await database();
  try {
    const metadata = (await db.query(PLATFORM_RUNTIME_SCHEMA_QUERY, ['public', PLATFORM_RUNTIME_TABLES])).rows;
    assert.equal(metadata.length, 9);
    // Synthetic pre-existing overbroad table and column grants must be removed.
    for (const name of tables) await db.exec('GRANT ALL ON public.' + name + ' TO platform_runtime, PUBLIC');
    await db.exec('GRANT UPDATE(content) ON platform_policy_revisions TO platform_runtime, PUBLIC');
    await db.exec('GRANT UPDATE(code) ON affiliate_identities TO platform_runtime, PUBLIC');
    await db.exec(buildRuntimePlatformPrivilegeStatement(runtimeUrl, metadata));
    await db.exec('SET ROLE platform_runtime');
    await db.exec(`
      INSERT INTO platform_policy_revisions(id,"group",version,content,created_by_id) VALUES ('${policy}','affiliate',1,'{}','${owner}');
      INSERT INTO platform_support_tickets(id,owner_id,title,content,updated_at) VALUES ('${ticket}','${owner}','Synthetic help','Synthetic content',CURRENT_TIMESTAMP);
      INSERT INTO platform_support_replies(ticket_id,author_id,content) VALUES ('${ticket}','${owner}','Synthetic reply');
      INSERT INTO platform_partner_applications(category,name,organization,phone,email,content,consent_at,updated_at) VALUES ('school','Synthetic','Synthetic school','0000000000','synthetic@example.invalid','Synthetic request',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO user_mfa(user_id,updated_at) VALUES ('${owner}',CURRENT_TIMESTAMP);
      INSERT INTO affiliate_identities(id,owner_id,kind,code) VALUES ('${identity}','${owner}','general','synthetic-code');
      INSERT INTO affiliate_visits(id,token_hash,identity_id,policy_revision_id,expires_at) VALUES ('${visit}','synthetic-hash','${identity}','${policy}',CURRENT_TIMESTAMP + INTERVAL '1 day');
      INSERT INTO affiliate_attributions(id,order_id,identity_id,buyer_id,visit_id,policy_revision_id) VALUES ('${attribution}','${order}','${identity}','${owner}','${visit}','${policy}');
      INSERT INTO affiliate_accruals(attribution_id,source_digest,delta_minor,qualifying_amount_minor,commission_bps,currency,hold_until) VALUES ('${attribution}','synthetic-digest',0,0,0,'VND',CURRENT_TIMESTAMP);
    `);
    for (const { name, columns } of metadata) {
      assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM public.' + name)).rows[0].count, 1, name + ' read/append');
      for (const column of columns) {
        const allowed = expectedUpdates[name].includes(column);
        const rights = (await db.query("SELECT has_column_privilege(current_user,$1,$2,'UPDATE') AS allowed", ['public.' + name, column])).rows[0];
        assert.equal(rights.allowed, allowed, name + '.' + column);
        const update = 'UPDATE public.' + name + ' SET "' + column + '"="' + column + '" WHERE false';
        if (allowed) await db.exec(update);
        else await assert.rejects(db.exec(update), /permission denied/, name + '.' + column);
      }
      for (const operation of ['DELETE FROM ', 'TRUNCATE ']) await assert.rejects(db.exec(operation + 'public.' + name), /permission denied/, operation + name);
    }
    await db.exec(`UPDATE platform_policy_revisions SET status='approved',approved_by_id='${owner}',approved_at=CURRENT_TIMESTAMP; UPDATE platform_support_tickets SET status='in_progress',updated_at=CURRENT_TIMESTAMP; UPDATE platform_partner_applications SET status='reviewing',updated_at=CURRENT_TIMESTAMP; UPDATE user_mfa SET revision=1,pending_secret_encrypted='synthetic-encrypted-value',pending_expires_at=CURRENT_TIMESTAMP+INTERVAL '10 minutes',updated_at=CURRENT_TIMESTAMP;`);
    for (const table of ['commerce_orders', 'commerce_settlements', 'commerce_refunds']) {
      const rights = (await db.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed", [table])).rows[0];
      assert.equal(rights.allowed, false, 'existing financial source privileges unchanged: ' + table);
    }
    await db.exec('RESET ROLE; SET ROLE unrelated_runtime');
    for (const name of tables) await assert.rejects(db.exec('SELECT * FROM public.' + name), /permission denied/, 'no PUBLIC exposure: ' + name);
  } finally { await db.close(); }
});

for (const schemaPresent of [false, true]) {
  test('deployment helper ' + (schemaPresent ? 'includes existing' : 'skips absent') + ' additive application tables', async () => {
    const statements = [];
    class FakeClient {
      async connect() {} async end() {}
      async query(sql, parameters) {
        statements.push({ sql, parameters });
        if (sql === PLATFORM_RUNTIME_SCHEMA_QUERY) return { rows: schemaPresent ? [{ name: 'platform_policy_revisions', columns: ['id', 'status', 'content'] }] : [] };
        return { rows: [{ ready: false }] };
      }
    }
    await grantRuntimeMembershipPrivileges('postgresql://migration@localhost/test', runtimeUrl, FakeClient);
    assert.deepEqual(statements.find(entry => entry.sql === PLATFORM_RUNTIME_SCHEMA_QUERY).parameters, ['public', PLATFORM_RUNTIME_TABLES]);
    assert.equal(statements.some(entry => entry.sql.includes('GRANT SELECT, INSERT ON TABLE "public"."platform_policy_revisions"')), schemaPresent);
    assert.equal(statements.at(-1).sql, 'COMMIT');
  });
}

test('grant failure rolls back the transaction and reports no connection credentials', async () => {
  const statements = [];
  class FakeClient {
    async connect() {} async end() {}
    async query(sql) {
      statements.push(sql);
      if (sql === PLATFORM_RUNTIME_SCHEMA_QUERY) return { rows: [{ name: 'user_mfa', columns: ['user_id', 'enabled'] }] };
      if (sql.includes('GRANT SELECT, INSERT ON TABLE "public"."user_mfa"')) throw new Error('Synthetic failure with connection details');
      return { rows: [{ ready: false }] };
    }
  }
  await assert.rejects(grantRuntimeMembershipPrivileges('postgresql://migration@localhost/test', runtimeUrl, FakeClient), { message: 'Runtime membership privilege grant failed' });
  assert.equal(statements.at(-1), 'ROLLBACK');
});
