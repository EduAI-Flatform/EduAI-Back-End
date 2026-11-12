const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { buildRuntimeAffiliateWalletPrivilegeStatement, grantRuntimeMembershipPrivileges } = require('./membership-runtime-privileges.cjs');
const runtimeUrl = 'postgresql://affiliate_runtime@localhost/test';

test('affiliate effects permit append/read while denying mutation and function attachment', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE affiliate_runtime NOLOGIN;
      CREATE TABLE affiliate_wallet_effects(id integer);
      CREATE FUNCTION affiliate_wallet_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION affiliate_wallet_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION gds_spending_debt_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      GRANT EXECUTE ON FUNCTION affiliate_wallet_apply(), affiliate_wallet_lock(), gds_spending_debt_guard() TO affiliate_runtime;
      GRANT ALL ON affiliate_wallet_effects TO affiliate_runtime, PUBLIC;`);
    await db.exec(buildRuntimeAffiliateWalletPrivilegeStatement(runtimeUrl));
    await db.exec('SET ROLE affiliate_runtime; INSERT INTO affiliate_wallet_effects VALUES (1)');
    assert.deepEqual((await db.query('SELECT * FROM affiliate_wallet_effects')).rows, [{ id: 1 }]);
    for (const sql of ['UPDATE affiliate_wallet_effects SET id=2', 'DELETE FROM affiliate_wallet_effects', 'TRUNCATE affiliate_wallet_effects']) {
      await assert.rejects(db.exec(sql), /permission denied/);
    }
    await db.exec('CREATE TEMP TABLE forged(id integer)');
    for (const fn of ['affiliate_wallet_apply', 'affiliate_wallet_lock', 'gds_spending_debt_guard']) {
      assert.equal((await db.query("SELECT has_function_privilege(current_user, 'public." + fn + "()', 'EXECUTE') AS allowed")).rows[0].allowed, false);
      await assert.rejects(db.exec('CREATE TRIGGER forged_' + fn + ' AFTER INSERT ON forged FOR EACH ROW EXECUTE FUNCTION public.' + fn + '()'), /permission denied/);
    }
  } finally { await db.close(); }
});

for (const ready of [false, true]) {
  test('runtime grants ' + (ready ? 'include' : 'skip') + ' affiliate effects based on additive schema presence', async () => {
    const statements = [];
    class FakeClient {
      async connect() {} async end() {}
      async query(sql) { statements.push(sql); return { rows: [{ ready: sql.includes("to_regclass('public.affiliate_wallet_effects')") && ready }] }; }
    }
    await grantRuntimeMembershipPrivileges('postgresql://migration@localhost/test', runtimeUrl, FakeClient);
    assert.equal(statements.some(sql => sql.includes('GRANT SELECT, INSERT ON public.affiliate_wallet_effects')), ready);
    assert.equal(statements.at(-1), 'COMMIT');
  });
}
