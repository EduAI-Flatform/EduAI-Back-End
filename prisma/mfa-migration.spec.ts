import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('MFA storage migration', () => {
  let db: PGlite;
  const owner = '10000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE users (id UUID PRIMARY KEY)');
    await db.query('INSERT INTO users(id) VALUES ($1)', [owner]);
    await db.exec(readFileSync(join(__dirname, 'migrations/20261111150000_user_mfa/migration.sql'), 'utf8'));
  }, 60000);
  afterAll(async () => db.close());
  it('prevents enabling without encrypted secret and enrollment date', async () => {
    await expect(db.query('INSERT INTO user_mfa(user_id,enabled,updated_at) VALUES ($1,true,CURRENT_TIMESTAMP)', [owner])).rejects.toThrow();
  });
  it('consumes each TOTP step exactly once at the database boundary', async () => {
    await db.query("INSERT INTO user_mfa(user_id,enabled,revision,secret_encrypted,enabled_at,last_used_step,updated_at) VALUES ($1,true,1,'encrypted',CURRENT_TIMESTAMP,99,CURRENT_TIMESTAMP)", [owner]);
    const consume = 'UPDATE user_mfa SET last_used_step=100 WHERE user_id=$1 AND enabled=true AND revision=1 AND (last_used_step IS NULL OR last_used_step<100) RETURNING user_id';
    expect((await db.query(consume, [owner])).rows).toHaveLength(1);
    expect((await db.query(consume, [owner])).rows).toHaveLength(0);
  });
  it('uses array equality to prevent another recovery-code write from resurrecting consumed codes', async () => {
    await db.query("UPDATE user_mfa SET recovery_code_hashes=ARRAY['hash-a','hash-b'] WHERE user_id=$1", [owner]);
    const first = await db.query("UPDATE user_mfa SET recovery_code_hashes=ARRAY['hash-b'] WHERE user_id=$1 AND recovery_code_hashes=ARRAY['hash-a','hash-b'] RETURNING user_id", [owner]);
    const stale = await db.query("UPDATE user_mfa SET recovery_code_hashes=ARRAY['hash-a'] WHERE user_id=$1 AND recovery_code_hashes=ARRAY['hash-a','hash-b'] RETURNING user_id", [owner]);
    expect(first.rows).toHaveLength(1);
    expect(stale.rows).toHaveLength(0);
  });
});
