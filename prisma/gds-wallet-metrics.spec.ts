import { PGlite } from '@electric-sql/pglite';
import { incomeTotalsQuery, readIncomeSummary, walletTotalsQuery } from '../src/modules/wallet/gds-wallet-metrics';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const wallet = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherWallet = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('GDS owner-scoped lifetime metrics SQL', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE gds_internal_holds(wallet_id uuid, amount_minor bigint, status text);
      CREATE TABLE gds_withdrawals(wallet_id uuid, owner_id uuid, amount_minor bigint, status text);
      CREATE TABLE revenue_earning_periods(id uuid PRIMARY KEY, seller_id uuid, amount_minor bigint);
      CREATE TABLE revenue_ledger_entries(period_id uuid, kind text, amount_minor bigint, created_at timestamptz DEFAULT now());
      CREATE TABLE gds_revenue_projections(period_id uuid, review_required boolean);
      CREATE TABLE gds_withdrawal_settings(id text, revenue_cutoff_at timestamptz);
      INSERT INTO gds_withdrawal_settings VALUES ('global', '2026-11-01');
    `);
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.exec('TRUNCATE gds_internal_holds, gds_withdrawals, revenue_earning_periods, revenue_ledger_entries, gds_revenue_projections');
  });

  const run = async (query: ReturnType<typeof walletTotalsQuery>) =>
    (await db.query<Record<string, string>>(query.text, query.values)).rows[0];

  it('splits active holds and sums every paid withdrawal beyond a recent page', async () => {
    await db.query(`INSERT INTO gds_internal_holds VALUES ($1,30000,'RESERVED'),($1,999,'CAPTURED'),($2,999999,'RESERVED')`, [wallet, otherWallet]);
    await db.query(`INSERT INTO gds_withdrawals VALUES
      ($1,$2,10000,'PENDING'),($1,$2,20000,'APPROVED'),($1,$2,30000,'PROCESSING'),
      ($1,$2,99999,'CANCELLED'),($1,$2,99999,'REJECTED'),($1,$2,99999,'FAILED'),
      ($3,$4,999999,'PAID')`, [wallet, owner, otherWallet, other]);
    await db.query(`INSERT INTO gds_withdrawals SELECT $1,$2,10000,'PAID' FROM generate_series(1,25)`, [wallet, owner]);
    expect(await run(walletTotalsQuery(wallet, owner))).toEqual({
      paymentHeldMinor: '30000', withdrawalHeldMinor: '60000', totalWithdrawnMinor: '250000',
    });
  });

  it('nets refunds without double counting pre-recognition refunds or legacy review income', async () => {
    await db.query(`INSERT INTO revenue_earning_periods VALUES
      ('10000000-0000-4000-8000-000000000001',$1,100000),
      ('10000000-0000-4000-8000-000000000002',$1,200000),
      ('10000000-0000-4000-8000-000000000003',$1,80000),
      ('10000000-0000-4000-8000-000000000004',$1,40000),
      ('10000000-0000-4000-8000-000000000005',$2,999999)`, [owner, other]);
    await db.exec(`INSERT INTO revenue_ledger_entries(period_id,kind,amount_minor,created_at) VALUES
      ('10000000-0000-4000-8000-000000000001','refund_pending',-10000,'2026-11-02'),
      ('10000000-0000-4000-8000-000000000001','recognized',90000,'2026-11-03'),
      ('10000000-0000-4000-8000-000000000001','refund_recognized',-20000,'2026-11-04'),
      ('10000000-0000-4000-8000-000000000002','refund_pending',-50000,'2026-11-03'),
      ('10000000-0000-4000-8000-000000000003','recognized',80000,'2026-10-30'),
      ('10000000-0000-4000-8000-000000000004','recognized',40000,'2026-11-03');
      INSERT INTO gds_revenue_projections VALUES ('10000000-0000-4000-8000-000000000004',true);`);
    expect(await run(incomeTotalsQuery(owner))).toEqual({ recognizedMinor: '190000', pendingMinor: '150000', reviewPendingMinor: '120000' });
  });

  it('returns true zero totals for an owner with no sources and preserves bigint precision', async () => {
    expect(await run(incomeTotalsQuery(owner))).toEqual({ recognizedMinor: '0', pendingMinor: '0', reviewPendingMinor: '0' });
    await db.query(`INSERT INTO gds_withdrawals VALUES ($1,$2,9007199254740993,'PAID')`, [wallet, owner]);
    expect((await run(walletTotalsQuery(wallet, owner))).totalWithdrawnMinor).toBe('9007199254740993');
  });

  it('recovers the PostgreSQL transaction after an optional income query fails', async () => {
    await db.exec('BEGIN; ALTER TABLE revenue_ledger_entries RENAME TO temporarily_unavailable_entries;');
    try {
      const tx = {
        $executeRaw: async (parts: TemplateStringsArray) => db.exec(parts[0]),
        $queryRaw: async (query: ReturnType<typeof incomeTotalsQuery>) => (await db.query(query.text, query.values)).rows,
      };
      expect(await readIncomeSummary(tx as never, owner)).toEqual({
        status: 'UNAVAILABLE', totalMinor: null, recognizedMinor: null, pendingMinor: null, reviewPendingMinor: null,
      });
      expect(await run(walletTotalsQuery(wallet, owner))).toEqual({ paymentHeldMinor: '0', withdrawalHeldMinor: '0', totalWithdrawnMinor: '0' });
    } finally {
      await db.exec('ROLLBACK');
    }
  });
});
