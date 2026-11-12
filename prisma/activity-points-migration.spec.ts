import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('activity points immutable persistence', () => {
  let db: PGlite;
  const user = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  let policy: string, source: string, ledger: string;
  let fixtureTransaction = false;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users(id UUID PRIMARY KEY);
      CREATE TABLE enrollments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), status TEXT, completed_at TIMESTAMP(3));
      CREATE TABLE tmi_ledger_entries(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), kind TEXT,
        amount INTEGER, source_type TEXT, source_id TEXT, occurred_at TIMESTAMP(3), expires_at TIMESTAMP(3), metadata JSONB, redemption_id UUID);`);
    await db.query('INSERT INTO users VALUES ($1),($2)', [user, other]);
    await db.exec(readFileSync(join(__dirname, 'migrations/20261111090000_platform_policy_revisions/migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(__dirname, 'migrations/20261112180000_activity_points/migration.sql'), 'utf8'));
    policy = (await db.query<{ id: string }>(`INSERT INTO platform_policy_revisions("group",version,status,content,created_by_id,approved_by_id,approved_at,effective_at)
      VALUES ('points',1,'scheduled','{"enabled":true,"expireAfterMonths":1,"maxDaily":0,"rules":[{"event":"course.completed","points":50}]}',$1,$1,'2026-01-01','2026-01-01') RETURNING id`, [user])).rows[0].id;
    // Isolate expected statement failures while constructing atomic posting/receipt fixtures.
    const query = db.query.bind(db);
    db.query = (async (...args: Parameters<typeof query>) => {
      if (!fixtureTransaction) return query(...args);
      await db.exec('SAVEPOINT point_fixture_statement');
      try {
        const result = await query(...args);
        await db.exec('RELEASE SAVEPOINT point_fixture_statement');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK TO SAVEPOINT point_fixture_statement; RELEASE SAVEPOINT point_fixture_statement');
        throw error;
      }
    }) as typeof db.query;
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec('BEGIN');
    fixtureTransaction = true;
    source = (await db.query<{ id: string }>(`INSERT INTO enrollments(user_id,status,completed_at)
      VALUES ($1,'completed','2026-02-01') RETURNING id`, [user])).rows[0].id;
    ledger = (await db.query<{ id: string }>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,expires_at)
      VALUES ($1,'earn',50,'platform_activity',$2,'2026-02-01','2026-03-01') RETURNING id`, [user, source])).rows[0].id;
  });
  afterEach(async () => { fixtureTransaction = false; await db.exec('ROLLBACK'); });
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
    await receipt();
    source = (await db.query<{ id: string }>(`INSERT INTO enrollments(user_id,status,completed_at)
      VALUES ($1,'completed','2026-02-01') RETURNING id`, [user])).rows[0].id;
    ledger = (await db.query<{ id: string }>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,expires_at)
      VALUES ($1,'earn',30,'platform_activity',$2,'2026-02-01','2026-03-01') RETURNING id`, [user, source])).rows[0].id;
    await expect(receipt(user, ledger, 'awarded', 50)).rejects.toThrow();
    await receipt(user, ledger, 'awarded', 30);
    await db.query(`UPDATE platform_policy_revisions SET content=jsonb_set(content,'{maxDaily}','0') WHERE id=$1`, [policy]);
  });
  it('rejects committing an activity credit without its immutable source receipt', async () => {
    fixtureTransaction = false;
    await expect(db.exec('COMMIT')).rejects.toThrow('Point activity receipt required');
  });
  it('rejects committing an expiry debit without its settlement receipt', async () => {
    await receipt();
    await db.query(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at)
      VALUES ($1,'expiry',50,'platform_activity_expiry',$2,'2026-03-01')`, [user, ledger]);
    fixtureTransaction = false;
    await expect(db.exec('COMMIT')).rejects.toThrow('Point expiry receipt required');
  });
  it('prevents rewriting native ledger facts or changing their reserved source type', async () => {
    await receipt();
    await expect(db.query('UPDATE tmi_ledger_entries SET amount=49 WHERE id=$1', [ledger])).rejects.toThrow('immutable');
    await expect(db.query("UPDATE tmi_ledger_entries SET source_type='legacy' WHERE id=$1", [ledger])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM tmi_ledger_entries WHERE id=$1', [ledger])).rejects.toThrow();
  });
  it('allows the award and source receipt to commit atomically', async () => {
    await receipt();
    fixtureTransaction = false;
    await db.exec('COMMIT');
  });
  it('rejects refund provenance that changes the original validity or exceeds the consumed debit', async () => {
    await receipt();
    const redemptionId = '10000000-0000-4000-8000-000000000010';
    const spent = (await db.query<{id: string}>(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,redemption_id)
      VALUES ($1,'redeem',20,'tmi_redemption',$2::text,'2026-02-02',$2::uuid) RETURNING id`, [user, redemptionId])).rows[0].id;
    const refund = (amount: number, expiry: string) => db.query(`INSERT INTO tmi_ledger_entries(user_id,kind,amount,source_type,source_id,occurred_at,expires_at,metadata,redemption_id)
      VALUES ($1,'refund',$2,'platform_activity_refund',$3,'2026-04-01',$4,$5::jsonb,$6)`,
      [user, amount, `${redemptionId}:${ledger}`, expiry, JSON.stringify({ refundOfEntryId: ledger, refundOfDebitId: spent }), redemptionId]);
    await expect(refund(20, '2026-05-01')).rejects.toThrow('Point refund source mismatch');
    await expect(refund(21, '2026-03-01')).rejects.toThrow('Point refund source mismatch');
    await refund(20, '2026-03-01');
    await expect(refund(1, '2026-03-01')).rejects.toThrow('Point refund source mismatch');
  });
});
