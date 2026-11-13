import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rollingWindowStart } from '../src/modules/membership-cards/membership-card.evaluator';

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TYPE membership_plan_version_status AS ENUM ('draft','published');
    CREATE TABLE membership_plan_versions(id uuid PRIMARY KEY,status membership_plan_version_status DEFAULT 'draft');
    CREATE TABLE commerce_orders(id uuid PRIMARY KEY,buyer_id uuid REFERENCES users(id));
    CREATE TABLE commerce_order_lines(id uuid PRIMARY KEY,order_id uuid REFERENCES commerce_orders(id),product_type text,product_reference_id uuid);
    CREATE TABLE membership_checkout_intents(order_id uuid UNIQUE REFERENCES commerce_orders(id),version_id uuid REFERENCES membership_plan_versions(id),starts_at timestamp(3),ends_at timestamp(3));`);
  for (const migration of ['20260824170000_add_service_entitlements', '20261023021000_add_receipt_quota_pools',
    '20261111090000_platform_policy_revisions', '20261113100000_card_service_limit_provenance'])
    await db.exec(readFileSync(join(__dirname, 'migrations', migration, 'migration.sql'), 'utf8'));
  return db;
}
describe('card service-limit PostgreSQL boundary', () => {
  let db: PGlite; let owner: string; let definition: string; let version: number;
  beforeAll(async () => {
    db = await createDatabase();
  }, 60000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    owner = randomUUID(); definition = randomUUID(); version = 0;
    await db.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query('INSERT INTO users(id) VALUES($1)', [owner]);
    await db.query(`INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id)
      VALUES($1,'SYNTHETIC_CARD_QUOTA','metered','calendar_month','Synthetic quota',$2)`, [definition, owner]);
  });
  afterEach(async () => db.exec('ROLLBACK'));
  const reject = async (operation: () => Promise<unknown>, message: RegExp, client = db) => {
    await client.exec('SAVEPOINT expected_rejection');
    await expect(operation()).rejects.toThrow(message);
    await client.exec('ROLLBACK TO SAVEPOINT expected_rejection');
  };
  const policy = async (quota = 3, options: { status?: string; enabled?: boolean; group?: string; effectiveAt?: string; termAnchorAt?: string; termMonths?: number; approvedAt?: string;
    basis?: 'spend' | 'topup'; additionalTiers?: Array<{ code: string; threshold: number; quota: number }> } = {}, client = db) => {
    const id = randomUUID();
    const content = { enabled: options.enabled ?? true, basis: options.basis ?? 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
      serviceLimits: { enabled: true, consumptionPriority: 'card_first', termAnchorAt: options.termAnchorAt ?? '', termMonths: options.termMonths ?? 0 },
      tiers: [{ code: 'member', name: { vi: 'Member', en: 'Member' }, threshold: 0, benefits: [], serviceLimits: [] },
        { code: 'gold', name: { vi: 'Vang', en: 'Gold' }, threshold: 100, benefits: [], serviceLimits: [{ definitionId: definition, quota: String(quota) }] }] };
    content.tiers.push(...(options.additionalTiers ?? []).map(tier => ({ code: tier.code, name: { vi: tier.code, en: tier.code },
      threshold: tier.threshold, benefits: [], serviceLimits: [{ definitionId: definition, quota: String(tier.quota) }] })));
    const effectiveAt = options.effectiveAt ?? '2026-11-01';
    await client.query(`INSERT INTO platform_policy_revisions(id,"group",version,status,content,created_by_id,approved_by_id,approved_at,effective_at,created_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$8,$7,$9)`,
    [id, options.group ?? 'membership', ++version, options.status ?? 'scheduled', JSON.stringify(content), owner, effectiveAt,
      options.approvedAt ?? new Date(Date.parse(effectiveAt) - 86400000).toISOString(),
      new Date(Date.parse(effectiveAt) - 2 * 86400000).toISOString()]);
    return id;
  };
  const card = async (policyId: string, options: { quota?: number; at?: string; start?: string; end?: string | null; tier?: string; reset?: string; amount?: string; qualification?: Record<string, unknown> } = {}, client = db) => {
    const id = randomUUID(); const at = options.at ?? '2026-11-02T00:00:00Z';
    const qualification = { basis: 'spend', currency: 'VND', qualifyingAmountMinor: options.amount ?? '100', evaluatedAt: new Date(at).toISOString(),
      windowStartsAt: rollingWindowStart(new Date(at), 12).toISOString(), windowEndsAt: new Date(at).toISOString(), ...options.qualification };
    await client.query(`INSERT INTO service_entitlement_grants(id,user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at,created_at,
      card_policy_revision_id,card_tier_code,card_source_digest,card_qualification)
      VALUES($1,$2,$3,'MEMBERSHIP_CARD',$4,'metered',$13,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [id, owner, definition, randomUUID().replace(/-/g, '').repeat(2), options.quota ?? 3, options.start ?? '2026-11-01', options.end === undefined ? '2026-12-01' : options.end,
      new Date(at).toISOString(), policyId, options.tier ?? 'gold', 'a'.repeat(64), JSON.stringify(qualification), options.reset ?? 'calendar_month']);
    return id;
  };
  const consume = (grantId: string, quantity: number, remaining: number, at = '2026-11-10', start = '2026-11-01', end: string | null = '2026-12-01', client = db) => client.query(`
    INSERT INTO service_entitlement_usage(grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [grantId, owner, randomUUID().replace(/-/g, '').repeat(2), 'b'.repeat(64), quantity, start, end, remaining, at]);
  const useReset = async (reset: 'none' | 'membership_term') => {
    definition = randomUUID();
    await db.query(`INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id)
      VALUES($1,$2,'metered',$3,'Synthetic reset quota',$4)`, [definition, 'QUOTA_' + definition.replace(/-/g, '').toUpperCase(), reset, owner]);
  };
  it('rejects a card grant without policy and qualification provenance', async () => {
    await reject(() => db.query(`INSERT INTO service_entitlement_grants(user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at)
      VALUES($1,$2,'MEMBERSHIP_CARD','unproven','metered','calendar_month',3,'2026-11-01','2026-12-01')`, [owner, definition]), /card.*provenance|provenance.*card/i);
  });
  it('requires the effective enabled membership policy, configured tier and exact quota', async () => {
    const draft = await policy(3, { status: 'draft' });
    await reject(() => card(draft), /card.*policy|policy.*card/i);
    const disabled = await policy(3, { enabled: false });
    await reject(() => card(disabled), /card.*policy|policy.*card/i);
    const branding = await policy(3, { group: 'branding' });
    await reject(() => card(branding), /card.*policy|policy.*card/i);
    const active = await policy();
    await reject(() => card(active, { tier: 'unqualified' }), /card.*tier|tier.*card/i);
    await reject(() => card(active, { quota: 30 }), /card.*quota|quota.*card/i);
    await card(active);
  });
  it('does not allow a mid-month grant window to reset consumed monthly quota', async () => {
    const active = await policy();
    await reject(() => card(active, { start: '2026-11-02' }), /card.*window|window.*card/i);
    await reject(() => card(active, { end: '2026-12-15' }), /card.*window|window.*card/i);
  });
  it('requires approval before qualification and a tier justified by the recorded amount/window', async () => {
    const futureApproval = await policy(3, { approvedAt: '2026-11-10' });
    await reject(() => card(futureApproval), /card.*policy|policy.*card/i);
    const active = await policy();
    await reject(() => card(active, { amount: '99' }), /card.*tier|tier.*card/i);
    await reject(() => card(active, { qualification: { windowStartsAt: '2026-11-01T00:00:00Z' } }), /card.*qualification|qualification.*card/i);
    await reject(() => card(active, { qualification: { currency: 'USD' } }), /card.*policy|policy.*card/i);
    await card(active);
  });
  it('accepts top-up provenance and additional Admin-defined tiers at their configured boundary', async () => {
    const active = await policy(3, { basis: 'topup', additionalTiers: [
      { code: 'platinum', threshold: 200, quota: 4 }, { code: 'diamond', threshold: 300, quota: 5 },
    ] });
    await reject(() => card(active, { tier: 'diamond', quota: 5, amount: '300' }), /card.*policy|policy.*card/i);
    await reject(() => card(active, { tier: 'diamond', quota: 5, amount: '299', qualification: { basis: 'topup' } }), /card.*tier|tier.*card/i);
    await card(active, { tier: 'diamond', quota: 5, amount: '300', qualification: { basis: 'topup' } });
  });
  it('retains immutable grant provenance and the referenced membership policy facts', async () => {
    const active = await policy(); const grant = await card(active);
    await reject(() => db.query('UPDATE service_entitlement_grants SET card_source_digest=$1 WHERE id=$2', ['b'.repeat(64), grant]), /provenance.*immutable/i);
    await reject(() => db.query("UPDATE platform_policy_revisions SET content='{}' WHERE id=$1", [active]), /membership.*immutable/i);
    await reject(() => db.query("UPDATE platform_policy_revisions SET effective_at='2026-11-10' WHERE id=$1", [active]), /membership.*immutable/i);
    await reject(() => card(active), /membership_card_grant_context_key/);
  });
  it('counts old and revoked card usage across revisions without consuming independent preexisting quota', async () => {
    const oldPolicy = await policy(); const newPolicy = await policy(5, { effectiveAt: '2026-11-15' });
    const old = await card(oldPolicy); await consume(old, 2, 1);
    await db.query("UPDATE service_entitlement_grants SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=$1", [old]);
    const purchased = randomUUID();
    await db.query(`INSERT INTO service_entitlement_grants(id,user_id,definition_id,source_type,source_id,value_type,reset_period,quota,starts_at,ends_at,created_at)
      VALUES($1::uuid,$2,$3,'ADMIN',$1::uuid::text,'metered','calendar_month',3,'2026-11-01','2026-12-01','2026-11-01')`, [purchased, owner, definition]);
    await consume(purchased, 1, 2);
    const next = await card(newPolicy, { quota: 5, at: '2026-11-16' });
    await consume(next, 1, 2, '2026-11-16');
    await reject(() => consume(next, 3, 0, '2026-11-16'), /quota exhausted/);
    await consume(purchased, 2, 0, '2026-11-17');
    const december = await card(newPolicy, { quota: 5, at: '2026-12-02', start: '2026-12-01', end: '2027-01-01' });
    await consume(december, 1, 4, '2026-12-02', '2026-12-01', '2027-01-01');
  });
  it('rejects consumption from a superseded card policy even when the old grant is active', async () => {
    const oldPolicy = await policy(); const old = await card(oldPolicy);
    await policy(5, { effectiveAt: '2026-11-15' });
    await reject(() => consume(old, 1, 2, '2026-11-16'), /card.*policy|policy.*card/i);
  });
  it('requires Serializable consumption instead of relying on a stale RepeatableRead or unlocked snapshot', async () => {
    const local = await createDatabase();
    try {
      await local.query('INSERT INTO users(id) VALUES($1)', [owner]);
      await local.query(`INSERT INTO service_entitlement_definitions(id,code,value_type,reset_period,display_name,created_by_id)
        VALUES($1,'ISOLATION_QUOTA','metered','calendar_month','Isolation quota',$2)`, [definition, owner]);
      const revision = await policy(3, {}, local); const grant = await card(revision, {}, local);
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
        await local.exec('BEGIN ISOLATION LEVEL ' + isolation);
        await reject(() => consume(grant, 1, 2, '2026-11-10', '2026-11-01', '2026-12-01', local), /card.*serializable/i, local);
        await local.exec('ROLLBACK');
      }
    } finally { await local.close(); }
  }, 30000);
  it('preserves lifetime consumption across policy start dates and quota reductions', async () => {
    await useReset('none');
    const first = await policy(); const next = await policy(5, { effectiveAt: '2026-11-15' });
    const old = await card(first, { reset: 'none', end: null });
    await consume(old, 2, 1, '2026-11-10', '2026-11-01', null);
    const current = await card(next, { reset: 'none', quota: 5, at: '2026-11-16', start: '2026-11-15', end: null });
    await consume(current, 1, 2, '2026-11-16', '2026-11-15', null);
    const reduced = await policy(1, { effectiveAt: '2026-12-01' });
    const lower = await card(reduced, { reset: 'none', quota: 1, at: '2026-12-02', start: '2026-12-01', end: null });
    await reject(() => consume(lower, 1, 0, '2026-12-02', '2026-12-01', null), /quota exhausted/);
  });
  it('pools explicitly anchored terms across revisions and resets at the original leap-year month boundary', async () => {
    await useReset('membership_term');
    const term = { termAnchorAt: '2024-01-31T19:00:00+07:00', termMonths: 1 };
    const first = await policy(3, { ...term, effectiveAt: '2024-01-01' });
    const next = await policy(5, { ...term, effectiveAt: '2024-02-25' });
    const start = '2024-01-31T12:00:00Z'; const end = '2024-02-29T12:00:00Z';
    const old = await card(first, { reset: 'membership_term', at: '2024-02-20', start, end });
    await consume(old, 2, 1, '2024-02-21', start, end);
    const current = await card(next, { reset: 'membership_term', quota: 5, at: '2024-02-26', start, end });
    await consume(current, 1, 2, '2024-02-27', start, end);
    const following = await card(next, { reset: 'membership_term', quota: 5, at: '2024-03-01', start: end, end: '2024-03-31T12:00:00Z' });
    await consume(following, 1, 4, '2024-03-02', end, '2024-03-31T12:00:00Z');
  });
});
