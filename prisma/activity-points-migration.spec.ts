import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('activity points immutable persistence', () => {
  let db: PGlite;
  const user = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  let policy: string, source: string, ledger: string;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id UUID PRIMARY KEY);
      CREATE TABLE enrollments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), status TEXT, completed_at TIMESTAMP(3));
      CREATE TABLE tmi_ledger_entries(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), kind TEXT,
        amount INTEGER, source_type TEXT, source_id TEXT, occurred_at TIMESTAMP(3), expires_at TIMESTAMP(3));`);
    await db.query('INSERT INTO users VALUES ($1),($2)', [user, other]);
    await db.exec(readFileSync(join(__dirname, 'migrations/20261111090000_platform_policy_revisions/migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(__dirname, 'migrations/20261112180000_activity_points/migration.sql'), 'utf8'));
    policy = (await db.query<{ id: string }>(`INSERT INTO platform_policy_revisions("group",version,status,content,created_by_id,approved_by_id,approved_at,effective_at)
      VALUES ('points',1,'scheduled','{"enabled":true,"expireAfterMonths":1,"maxDaily":0,"rules":[{"event":"course.completed","points":50}]}',$1,$1,'2026-01-01','2026-01-01') RETURNING id`, [user])).rows[0].id;
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    source = (await db.query<{ id: string }>(`INSERT INTO enrollments(user_id,status,completed_at)
      VALUES ($1,'completed','2026-02-01') RETURNING id`, [user])).rows[0].id;
    ledger = (await db.query<{ id: string }>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,expires_at)
      VALUES ($1,'earn',50,'platform_activity',$2,'2026-02-01','2026-03-01') RETURNING id`, [user, source])).rows[0].id;
  });
  const receipt = (userId = user, ledgerId: string | null = ledger, outcome = 'awarded', amount = 50) => db.query<{ id: string }>(`
    INSERT INTO point_activity_receipts(user_id,event_type,source_id,policy_revision_id,outcome,amount,occurred_at,expires_at,ledger_entry_id,created_at)
    VALUES ($1,'course.completed',$2,$3,$4,$5,'2026-02-01','2026-03-01',$6,'2026-02-01') RETURNING id`, [userId, source, policy, outcome, amount, ledgerId]);

  it('retains policy/source provenance and rejects a replay of the same completion', async () => {
    await receipt();
    await expect(receipt()).rejects.toThrow();
    await expect(db.query('DELETE FROM enrollments WHERE id=$1', [source])).rejects.toThrow();
    await expect(db.query('DELETE FROM platform_policy_revisions WHERE id=$1', [policy])).rejects.toThrow();
  });
  it('prevents changing or deleting the historical outcome', async () => {
    const id = (await receipt()).rows[0].id;
    await expect(db.query('UPDATE point_activity_receipts SET amount=1 WHERE id=$1', [id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM point_activity_receipts WHERE id=$1', [id])).rejects.toThrow('immutable');
  });
  it('rejects a different owner and mismatched ledger amount', async () => {
    await expect(receipt(other)).rejects.toThrow();
    await expect(receipt(user, ledger, 'awarded', 49)).rejects.toThrow();
  });
  it('records zero outcomes without fabricating a ledger posting', async () => {
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{enabled}','false') WHERE id=$1`, [policy]);
    await receipt(user, null, 'disabled', 0);
    await expect(receipt(user, ledger, 'disabled', 0)).rejects.toThrow();
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{enabled}','true') WHERE id=$1`, [policy]);
  });
  it('rejects an uncompleted source and a policy that was not effective at the event', async () => {
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [source]);
    await expect(receipt()).rejects.toThrow();
    await db.query("UPDATE enrollments SET status='completed' WHERE id=$1", [source]);
    await db.query("UPDATE platform_policy_revisions SET effective_at='2026-02-02' WHERE id=$1", [policy]);
    await expect(receipt()).rejects.toThrow();
    await db.query("UPDATE platform_policy_revisions SET effective_at='2026-01-01' WHERE id=$1", [policy]);
  });
  it('settles a fully spent grant exactly once without a zero ledger transaction', async () => {
    await receipt();
    const sql = `INSERT INTO point_expiry_settlements(user_id,credit_entry_id,amount,settled_at)
      VALUES ($1,$2,0,'2026-03-01') RETURNING id`;
    const id = (await db.query<{ id: string }>(sql, [user, ledger])).rows[0].id;
    await expect(db.query(sql, [user, ledger])).rejects.toThrow();
    await expect(db.query('DELETE FROM point_expiry_settlements WHERE id=$1', [id])).rejects.toThrow('immutable');
  });
  it('rejects early expiry and expiry against another owner', async () => {
    await expect(db.query(`INSERT INTO point_expiry_settlements(user_id,credit_entry_id,amount,settled_at)
      VALUES ($1,$2,0,'2026-02-28')`, [user, ledger])).rejects.toThrow();
    await expect(db.query(`INSERT INTO point_expiry_settlements(user_id,credit_entry_id,amount,settled_at)
      VALUES ($1,$2,0,'2026-03-01')`, [other, ledger])).rejects.toThrow();
  });
  it('requires a matching canonical ledger posting for a positive expiry', async () => {
    await receipt();
    await expect(db.query(`INSERT INTO point_expiry_settlements(user_id,credit_entry_id,amount,settled_at)
      VALUES ($1,$2,50,'2026-03-01')`, [user, ledger])).rejects.toThrow();
    const posting = (await db.query<{id: string}>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at)
      VALUES ($1,'expiry',50,'platform_activity_expiry',$2,'2026-03-01') RETURNING id`, [user, ledger])).rows[0].id;
    await db.query(`INSERT INTO point_expiry_settlements(user_id,credit_entry_id,amount,settled_at,ledger_entry_id)
      VALUES ($1,$2,50,'2026-03-01',$3)`, [user, ledger, posting]);
  });
  it('rejects a fabricated zero outcome and a grant inconsistent with the configured rule', async () => {
    await expect(receipt(user, null, 'daily_cap', 0)).rejects.toThrow();
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{rules,0,points}','40') WHERE id=$1`, [policy]);
    await expect(receipt()).rejects.toThrow();
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{rules,0,points}','50') WHERE id=$1`, [policy]);
  });
  it('enforces the shared UTC daily cap with a partial award', async () => {
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{maxDaily}','80') WHERE id=$1`, [policy]);
    await db.query('UPDATE enrollments SET user_id=$1 WHERE id=$2', [other, source]);
    await db.query('UPDATE tmi_ledger_entries SET user_id=$1 WHERE id=$2', [other, ledger]);
    await receipt(other);
    source = (await db.query<{ id: string }>(`INSERT INTO enrollments(user_id,status,completed_at)
      VALUES ($1,'completed','2026-02-01') RETURNING id`, [other])).rows[0].id;
    ledger = (await db.query<{ id: string }>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,expires_at)
      VALUES ($1,'earn',30,'platform_activity',$2,'2026-02-01','2026-03-01') RETURNING id`, [other, source])).rows[0].id;
    await expect(receipt(other, ledger, 'awarded', 50)).rejects.toThrow();
    await receipt(other, ledger, 'awarded', 30);
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{maxDaily}','0') WHERE id=$1`, [policy]);
  });
});
