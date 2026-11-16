import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const source = readFileSync(join(process.cwd(), 'prisma/migrations/20261116090000_auth_session_v2_foundation/migration.sql'), 'utf8');
jest.setTimeout(60000);
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE users (id uuid PRIMARY KEY, email text, password_hash text, updated_at timestamp);
    CREATE TABLE refresh_tokens (id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),token_hash text,revoked_at timestamp);
    INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000001','synthetic@example.test','synthetic-password-hash','2026-11-01');
    INSERT INTO refresh_tokens VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','synthetic-session-hash',NULL);`);
  return db;
}
describe('additive auth session foundation migration', () => {
  it('preserves old columns, defaults revision to zero and leaves legacy families null', async () => {
    const db = await fixture();
    try {
      const beforeUsers = (await db.query('SELECT to_jsonb(u) AS data FROM users u')).rows;
      const beforeTokens = (await db.query('SELECT to_jsonb(r) AS data FROM refresh_tokens r')).rows;
      await db.exec(source);
      expect((await db.query("SELECT to_jsonb(u)-'auth_revision' AS data FROM users u")).rows).toEqual(beforeUsers);
      expect((await db.query("SELECT to_jsonb(r)-'session_family_id' AS data FROM refresh_tokens r")).rows).toEqual(beforeTokens);
      expect((await db.query('SELECT auth_revision FROM users')).rows).toEqual([{ auth_revision: 0 }]);
      expect((await db.query('SELECT session_family_id FROM refresh_tokens')).rows).toEqual([{ session_family_id: null }]);
      await expect(db.exec('UPDATE users SET auth_revision=-1')).rejects.toThrow();
      await db.exec('UPDATE users SET auth_revision=auth_revision+1');
      await db.exec("UPDATE refresh_tokens SET session_family_id='00000000-0000-4000-8000-000000000003'");
      expect((await db.query('SELECT auth_revision FROM users')).rows).toEqual([{ auth_revision: 1 }]);
    } finally { await db.close(); }
  });
  it('rolls back the whole addition if legacy credential/session data changes', async () => {
    for (const mutation of ["UPDATE public.users SET password_hash='changed';", "UPDATE public.refresh_tokens SET revoked_at=now();"]) {
      const db = await fixture();
      try {
        const tampered = source.replace('ALTER TABLE public.users ADD COLUMN', mutation + '\nALTER TABLE public.users ADD COLUMN');
        await expect(db.exec(tampered)).rejects.toThrow('AUTH_SESSION_HISTORY_CHANGED');
        await db.exec('ROLLBACK');
        expect((await db.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='users' AND column_name='auth_revision'")).rows).toEqual([{ count: 0 }]);
        expect((await db.query('SELECT password_hash FROM users')).rows).toEqual([{ password_hash: 'synthetic-password-hash' }]);
        expect((await db.query('SELECT revoked_at FROM refresh_tokens')).rows).toEqual([{ revoked_at: null }]);
      } finally { await db.close(); }
    }
  });
});
