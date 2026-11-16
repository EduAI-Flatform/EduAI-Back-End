'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { verifyAuthSessionSchema } = require('./verify-auth-session-schema.cjs');
const owner = '00000000-0000-4000-8000-00000000f101', token = '00000000-0000-4000-8000-00000000f102';
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CI, 'true'); assert.equal(url.username, 'eduai_migration_replay');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/eduai_migration_replay');
  assert.ok(process.env.RUNNER_TEMP); assert.ok(['before', 'after'].includes(process.argv[2]));
  const file = path.join(process.env.RUNNER_TEMP, 'gds-auth-session-history.json');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const digest = async () => {
    const result = await db.query(`SELECT md5((to_jsonb(u)-'auth_revision')::text) AS account,
      md5((to_jsonb(r)-'session_family_id')::text) AS session FROM users u JOIN refresh_tokens r ON r.user_id=u.id WHERE u.id=$1 AND r.id=$2`, [owner, token]);
    assert.equal(result.rows.length, 1); return result.rows[0];
  };
  try {
    if (process.argv[2] === 'before') {
      await db.query(`INSERT INTO users(id,email,full_name,password_hash,updated_at)
        VALUES ($1,'auth-foundation@synthetic.invalid','Synthetic auth history','synthetic-old-password-hash',CURRENT_TIMESTAMP)`, [owner]);
      await db.query(`INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at)
        VALUES ($1,$2,'synthetic-old-refresh-hash',CURRENT_TIMESTAMP+interval '30 days')`, [token, owner]);
      fs.writeFileSync(file, JSON.stringify(await digest()), { mode: 0o600 });
      console.log('GDS_AUTH_SESSION_FOUNDATION_BEFORE=PASS; synthetic legacy evidence seeded, only digests persisted');
    } else {
      assert.deepEqual(await digest(), JSON.parse(fs.readFileSync(file, 'utf8')));
      const readiness = await verifyAuthSessionSchema(db);
      await db.query('BEGIN');
      await assert.rejects(() => db.query('UPDATE users SET auth_revision=-1 WHERE id=$1', [owner]), error => error.code === '23514');
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query('UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1', [owner]);
      await db.query('UPDATE refresh_tokens SET session_family_id=$1 WHERE id=$2', [owner, token]);
      await db.query('ROLLBACK');
      assert.deepEqual(await digest(), JSON.parse(fs.readFileSync(file, 'utf8')));
      console.log('GDS_AUTH_SESSION_FOUNDATION_AFTER=PASS; legacy rows unchanged, bounded revision/family schema ready, ' + JSON.stringify(readiness));
    }
  } finally { await db.end(); }
}
main().catch(() => { console.error('GDS_AUTH_SESSION_FOUNDATION=FAIL'); process.exitCode = 1; });
