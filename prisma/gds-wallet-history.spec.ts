import { PGlite } from '@electric-sql/pglite';
import { historyQuery, parseHistoryQuery, encodeHistoryCursor, readHistoryPage } from '../src/modules/wallet/gds-wallet-history';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('paginated owned wallet activity', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE gds_internal_wallets(id uuid, buyer_id uuid);
      CREATE TABLE gds_internal_journal(id uuid, wallet_id uuid, kind text, amount_minor bigint, occurred_at timestamptz, order_ref text);
      CREATE TABLE gds_withdrawals(id uuid, wallet_id uuid, owner_id uuid, amount_minor bigint, status text, created_at timestamptz, bank_code text, bank_short_name text, account_number text);
      INSERT INTO gds_internal_wallets VALUES ('${owner}','${owner}'),('${other}','${other}');
      INSERT INTO gds_internal_journal SELECT md5(i::text)::uuid,'${owner}',
        CASE WHEN i%4=0 THEN 'RESERVE' WHEN i%4=1 THEN 'TOPUP_CREDIT' WHEN i%4=2 THEN 'CAPTURE' ELSE 'RELEASE' END,
        10000,'2026-11-05T01:00:00.123456Z',NULL FROM generate_series(1,48)i;
      INSERT INTO gds_internal_journal VALUES (md5('other')::uuid,'${other}','TOPUP_CREDIT',999999,now(),NULL);
      INSERT INTO gds_withdrawals VALUES ('${owner}','${owner}','${owner}',50000,'PAID','2026-11-05T02:00:00Z','TPB','TPBank','000123456789');
      INSERT INTO gds_internal_journal VALUES (md5('paid')::uuid,'${owner}','WITHDRAWAL_PAID',50000,now(),'${owner}');`);
  });
  afterAll(() => db.close());
  const reader = { $queryRaw: async (q: any) => (await db.query(q.text, q.values)).rows };
  it('pages through more than40 mixed records with tied microsecond times without duplication', async () => {
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await readHistoryPage(reader as never, owner, parseHistoryQuery(owner, 'all', '20', cursor));
      ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(49); expect(new Set(ids).size).toBe(49);
    expect(ids[0]).toBe(`withdrawal-${owner}`);
  });
  it('filters before pagination and excludes holds/releases from money in and out', async () => {
    for (const [filter, count] of [['incoming',12],['outgoing',13],['payments',12],['withdrawals',1]] as const) {
      const page = await readHistoryPage(reader as never, owner, parseHistoryQuery(owner, filter, '50'));
      expect(page.items).toHaveLength(count); expect(page.hasMore).toBe(false);
    }
  });
  it('masks accounts and never returns linked withdrawal journal postings twice', async () => {
    const page = await readHistoryPage(reader as never, owner, parseHistoryQuery(owner, 'withdrawals'));
    expect(page.items[0]).toMatchObject({ type:'WITHDRAWAL', status:'PAID', accountNumber:'••••6789' });
    expect(JSON.stringify(page)).not.toContain('000123456789');
    expect((await reader.$queryRaw(historyQuery(other, parseHistoryQuery(other)))).length).toBe(1);
  });
  it('rejects malformed, cross-owner and cross-filter cursors and bounds page size', () => {
    const cursor = encodeHistoryCursor(owner, 'all', '1793840400123456', `journal-${owner}`);
    expect(() => parseHistoryQuery(other, 'all','20',cursor)).toThrow();
    expect(() => parseHistoryQuery(owner, 'incoming','20',cursor)).toThrow();
    for (const bad of ['broken','a'.repeat(800)]) expect(() => parseHistoryQuery(owner,'all','20',bad)).toThrow();
    expect(() => parseHistoryQuery(owner,'unknown')).toThrow();
    expect(() => parseHistoryQuery(owner,'all','51')).toThrow();
  });
  it('keeps pending/cancelled requests visible without marking them as outgoing money',async()=>{
    await db.exec('BEGIN');
    try {
      await db.exec(`INSERT INTO gds_withdrawals SELECT md5(i::text||'request')::uuid,'${owner}','${owner}',10000,
        CASE WHEN i=1 THEN 'PENDING' WHEN i=2 THEN 'CANCELLED' ELSE 'REJECTED' END,now(),'MB','MBBank','000123456789' FROM generate_series(1,3)i;
        INSERT INTO gds_internal_journal VALUES (md5('legacy')::uuid,'${owner}','WITHDRAWAL_RELEASE',10000,now(),'legacy:non-uuid');`);
      const requests=await readHistoryPage(reader as never,owner,parseHistoryQuery(owner,'withdrawals','50'));
      expect(requests.items).toHaveLength(5);
      const out=await readHistoryPage(reader as never,owner,parseHistoryQuery(owner,'outgoing','50'));
      expect(out.items.filter(row=>row.type==='WITHDRAWAL')).toHaveLength(1);
    }finally{await db.exec('ROLLBACK');}
  });
  it('does not shift previously loaded requests after a status update or a newer insert',async()=>{
    const first=await readHistoryPage(reader as never,owner,parseHistoryQuery(owner,'all','20'));
    await db.exec('BEGIN');
    try{
      await db.exec(`UPDATE gds_withdrawals SET status='PROCESSING';
        INSERT INTO gds_internal_journal VALUES(md5('new')::uuid,'${owner}','TOPUP_CREDIT',10000,now(),NULL);`);
      const next=await readHistoryPage(reader as never,owner,parseHistoryQuery(owner,'all','50',first.nextCursor));
      expect(next.items).toHaveLength(29);
      expect(next.items.some(row=>first.items.some(old=>old.id===row.id))).toBe(false);
    }finally{await db.exec('ROLLBACK');}
  });
});
