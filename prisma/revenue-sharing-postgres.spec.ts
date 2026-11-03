import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');
const uid = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Revenue sharing PostgreSQL persistence', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    const directory = join(__dirname, 'migrations');
    for (const name of readdirSync(directory).sort()) {
      const sql = join(directory, name, 'migration.sql');
      if (existsSync(sql)) await db.exec(readFileSync(sql, 'utf8'));
    }
    await db.exec(`
      INSERT INTO users (id,email,password_hash,full_name,updated_at) VALUES
        ('${uid(1)}','revenue-admin@example.test','hash','Admin',now()),
        ('${uid(2)}','revenue-seller@example.test','hash','Seller',now()),
        ('${uid(3)}','revenue-buyer@example.test','hash','Buyer',now());
      INSERT INTO roles (id,name,description,updated_at) VALUES ('${uid(4)}','platform_admin','Admin',now());
      INSERT INTO user_roles(user_id,role_id) VALUES ('${uid(1)}','${uid(4)}');
      INSERT INTO courses(id,instructor_id,title,slug,level,status,visibility,price_amount_minor,price_currency,updated_at)
        VALUES ('${uid(5)}','${uid(2)}','Revenue course','revenue-course','beginner','published','public',1000,'VND',now());
      INSERT INTO revenue_terms(id,title,body,created_by_id) VALUES ('${uid(6)}','Participation','Terms','${uid(1)}');
      INSERT INTO revenue_retail_policies(id,platform_fee_bps,status,notice_mode,effective_at,actor_id)
        VALUES ('${uid(7)}',2000,'active','immediate',now(),'${uid(1)}');
      INSERT INTO membership_plans(id,code,updated_at) VALUES ('${uid(8)}','REVENUE',now());
      INSERT INTO membership_plan_versions(id,plan_id,version_number,display_name,base_monthly_price_amount_minor,created_by_id,updated_at)
        VALUES ('${uid(9)}','${uid(8)}',1,'Revenue',1000,'${uid(1)}',now());
      INSERT INTO membership_duration_options(version_id,months,discount_percent,display_order) VALUES ('${uid(9)}',1,0,0);
      INSERT INTO revenue_plan_policies(id,plan_id,source_version_id,terms_id,platform_fee_bps,rules,overrides,notice_mode,effective_at,actor_id)
        VALUES ('${uid(10)}','${uid(8)}','${uid(9)}','${uid(6)}',4000,'[]','[]','immediate',now(),'${uid(1)}');
      INSERT INTO revenue_participation_events(id,course_id,seller_id,terms_id,action)
        VALUES ('${uid(11)}','${uid(5)}','${uid(2)}','${uid(6)}','accepted');
      INSERT INTO commerce_products(id,type,course_id,seller_id,status,updated_at) VALUES ('${uid(12)}','course','${uid(5)}','${uid(2)}','draft',now());
      UPDATE commerce_products SET status='active',updated_at=now() WHERE id='${uid(12)}';
      BEGIN;
      INSERT INTO commerce_orders(id,order_number,buyer_id,subtotal_amount_minor,payable_amount_minor,pricing_policy_version,updated_at)
        VALUES ('${uid(13)}','REVENUE-ORDER','${uid(3)}',1000,1000,'v1',now());
      INSERT INTO commerce_order_lines(id,order_id,product_id,product_type,product_reference_id,seller_id,display_title,unit_list_price_amount_minor,subtotal_amount_minor,final_amount_minor)
        VALUES ('${uid(14)}','${uid(13)}','${uid(12)}','course','${uid(5)}','${uid(2)}','Revenue course',1000,1000,1000);
      INSERT INTO revenue_order_snapshots(order_line_id,order_id,product_type,policy_id,platform_fee_bps,basis_amount_minor,platform_amount_minor,seller_amount_minor,participants)
        VALUES ('${uid(14)}','${uid(13)}','course','${uid(7)}',2000,1000,200,800,'[{"courseId":"${uid(5)}","sellerId":"${uid(2)}","amountMinor":"800","weight":1}]');
      COMMIT;
      INSERT INTO revenue_earning_periods(id,snapshot_id,seller_id,course_id,period_index,due_at,amount_minor)
        VALUES ('${uid(15)}','${uid(14)}','${uid(2)}','${uid(5)}',0,now(),800);
      INSERT INTO revenue_ledger_entries(id,period_id,source_key,kind,amount_minor)
        VALUES ('${uid(16)}','${uid(15)}','recognition:test','recognized',800);
    `);
  }, 120_000);
  afterAll(async () => db?.close());

  it('preserves terms, consent events, order allocations, periods and journal history', async () => {
    for (const table of ['revenue_terms','revenue_participation_events','revenue_order_snapshots','revenue_earning_periods','revenue_ledger_entries']) {
      await expect(db.exec(`DELETE FROM ${table}`)).rejects.toThrow(/revenue history is immutable/);
    }
    await expect(db.exec(`UPDATE revenue_order_snapshots SET seller_amount_minor=0`)).rejects.toThrow(/immutable/);
    await expect(db.exec(`UPDATE revenue_ledger_entries SET amount_minor=0`)).rejects.toThrow(/immutable/);
  });

  it('grants runtime append-only history access without update or delete privileges', async () => {
    const { buildRuntimePrivilegeStatement, buildRuntimeRevenuePrivilegeStatement } = require('../scripts/membership-runtime-privileges.cjs');
    await db.exec('CREATE ROLE revenue_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await db.exec(buildRuntimePrivilegeStatement('postgresql://revenue_test_runtime:unused@example.test/isolated'));
    await db.exec(buildRuntimeRevenuePrivilegeStatement('postgresql://revenue_test_runtime:unused@example.test/isolated'));
    await db.exec('SET ROLE revenue_test_runtime');
    try {
      const result = await db.query<{ title: string }>('SELECT title FROM revenue_terms');
      expect(result.rows).toContainEqual({ title: 'Participation' });
      await expect(db.exec('UPDATE revenue_terms SET title=title')).rejects.toThrow(/permission denied/);
      await expect(db.exec('DELETE FROM revenue_ledger_entries')).rejects.toThrow(/permission denied/);
      const privileges = await db.query<{ can_insert: boolean; can_update: boolean }>(
        "SELECT has_table_privilege(current_user,'revenue_ledger_entries','INSERT') AS can_insert, has_table_privilege(current_user,'revenue_plan_policies','UPDATE') AS can_update",
      );
      expect(privileges.rows[0]).toEqual({ can_insert: true, can_update: true });
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('rejects invalid fee bounds and mutually exclusive notice-day modes', async () => {
    for (const [bps, mode, days] of [[10001,'immediate','NULL'],[-1,'immediate','NULL'],[2000,'immediate','2'],[2000,'delayed','NULL'],[2000,'delayed','0']]) {
      await expect(db.exec(`INSERT INTO revenue_retail_policies(platform_fee_bps,notice_mode,notice_days,effective_at,actor_id) VALUES (${bps},'${mode}',${days},now(),'${uid(1)}')`)).rejects.toThrow(/check constraint/);
    }
  });

  it('serializes one scheduled global retail policy and keeps its terms immutable', async () => {
    await db.exec(`INSERT INTO revenue_retail_policies(id,platform_fee_bps,notice_mode,notice_days,effective_at,actor_id) VALUES ('${uid(17)}',3000,'delayed',7,now()+interval '7 days','${uid(1)}')`);
    await expect(db.exec(`INSERT INTO revenue_retail_policies(platform_fee_bps,notice_mode,effective_at,actor_id) VALUES (4000,'immediate',now(),'${uid(1)}')`)).rejects.toThrow(/unique constraint/);
    await expect(db.exec(`UPDATE revenue_retail_policies SET platform_fee_bps=5000 WHERE id='${uid(17)}'`)).rejects.toThrow(/policy terms are immutable/);
    await db.exec(`UPDATE revenue_retail_policies SET status='cancelled' WHERE id='${uid(17)}'`);
    await expect(db.exec(`UPDATE revenue_retail_policies SET status='active' WHERE id='${uid(17)}'`)).rejects.toThrow(/invalid revenue policy transition/);
  });

  it('serializes scheduled policies within a membership plan', async () => {
    await expect(db.exec(`INSERT INTO revenue_plan_policies(plan_id,source_version_id,terms_id,platform_fee_bps,rules,overrides,notice_mode,effective_at,actor_id) VALUES ('${uid(8)}','${uid(9)}','${uid(6)}',3000,'[]','[]','immediate',now(),'${uid(1)}')`)).rejects.toThrow(/unique constraint/);
  });

  it('requires positive inclusion weights and preserves published revenue-policy association', async () => {
    await expect(db.exec(`INSERT INTO membership_plan_included_courses(version_id,course_id,revenue_weight,created_by_id) VALUES ('${uid(9)}','${uid(5)}',0,'${uid(1)}')`)).rejects.toThrow(/check constraint/);
    await db.exec(`UPDATE membership_plan_versions SET revenue_policy_id='${uid(10)}' WHERE id='${uid(9)}'; UPDATE membership_plan_versions SET status='published',published_by_id='${uid(1)}',published_at=now() WHERE id='${uid(9)}';`);
    await expect(db.exec(`UPDATE membership_plan_versions SET revenue_policy_id=NULL WHERE id='${uid(9)}'`)).rejects.toThrow(/published membership revenue policy is immutable/);
  });

  it('rejects duplicate recognition sources and duplicate monthly periods', async () => {
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,kind,amount_minor) VALUES ('${uid(15)}','recognition:test','recognized',800)`)).rejects.toThrow(/unique constraint/);
    await expect(db.exec(`INSERT INTO revenue_earning_periods(snapshot_id,seller_id,course_id,period_index,due_at,amount_minor) VALUES ('${uid(14)}','${uid(2)}','${uid(5)}',0,now(),800)`)).rejects.toThrow(/unique constraint/);
  });

  it('links adjustments only to recorded canonical refunds allocated to the same line', async () => {
    await db.exec(`
      INSERT INTO commerce_payment_attempts(id,order_id,provider,local_request_identity,provider_payment_identity,provider_receiving_account_hash,provider_order_code,provider_expires_at,provider_request_started_at,status,amount_minor,currency,updated_at)
        VALUES ('${uid(20)}','${uid(13)}','payos','${uid(21)}','revenue-payment','synthetic-account-hash',700020,now()+interval '15 minutes',now(),'created',1000,'VND',now());
      BEGIN;
      UPDATE commerce_payment_attempts SET status='pending',status_operation_id='${uid(22)}',updated_at=now() WHERE id='${uid(20)}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id) VALUES ('payment','${uid(20)}','created','pending','system','${uid(22)}');
      COMMIT;
      BEGIN;
      INSERT INTO commerce_payment_events(id,payment_attempt_id,provider,provider_event_identity,provider_payment_identity,provider_settlement_reference,amount_minor,currency,next_status)
        VALUES ('${uid(23)}','${uid(20)}','payos','revenue-paid-event','revenue-payment','revenue-settlement',1000,'VND','paid');
      INSERT INTO commerce_settlements(id,order_id,payment_attempt_id,payment_event_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency,settled_at)
        VALUES ('${uid(24)}','${uid(13)}','${uid(20)}','${uid(23)}','provider_collection','matched','payos','revenue-settlement',1000,'VND',now());
      UPDATE commerce_payment_attempts SET status='paid',status_operation_id='${uid(25)}',paid_at=now(),updated_at=now() WHERE id='${uid(20)}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id) VALUES ('payment','${uid(20)}','pending','paid','provider','${uid(25)}');
      UPDATE commerce_orders SET status='confirmed',status_operation_id='${uid(26)}',confirmed_settlement_id='${uid(24)}',confirmed_at=now(),updated_at=now() WHERE id='${uid(13)}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,operation_id) VALUES ('order','${uid(13)}','pending_payment','confirmed','provider','${uid(26)}');
      COMMIT;
      BEGIN;
      INSERT INTO commerce_refunds(id,order_id,settlement_id,amount_minor,currency,provider,requested_by_id,reason_code,updated_at)
        VALUES ('${uid(27)}','${uid(13)}','${uid(24)}',100,'VND','payos','${uid(1)}','SYNTHETIC_REFUND',now());
      INSERT INTO commerce_refund_allocations(refund_id,order_line_id,amount_minor,currency) VALUES ('${uid(27)}','${uid(14)}',100,'VND');
      COMMIT;
    `);
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,kind,amount_minor) VALUES ('${uid(15)}','missing-refund','refund_recognized',-80)`)).rejects.toThrow(/recorded canonical refund/);
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,source_refund_id,kind,amount_minor) VALUES ('${uid(15)}','unrecorded-refund','${uid(27)}','refund_recognized',-80)`)).rejects.toThrow(/recorded canonical refund/);
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,source_refund_id,kind,amount_minor) VALUES ('${uid(15)}','missing-refund-id','${uid(999)}','refund_recognized',-80)`)).rejects.toThrow(/recorded canonical refund/);
    await db.exec(`
      BEGIN;
      UPDATE commerce_refunds SET status='recorded',status_operation_id='${uid(28)}',external_reference='revenue-external-refund',recorded_by_id='${uid(1)}',recorded_at=now(),updated_at=now() WHERE id='${uid(27)}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,actor_id,operation_id) VALUES ('refund','${uid(27)}','requested','recorded','user','${uid(1)}','${uid(28)}');
      COMMIT;
      INSERT INTO revenue_ledger_entries(id,period_id,source_key,source_refund_id,kind,amount_minor) VALUES ('${uid(29)}','${uid(15)}','canonical-refund','${uid(27)}','refund_recognized',-80);
    `);
    await db.exec(`
      INSERT INTO commerce_payment_events(id,payment_attempt_id,provider,provider_event_identity,provider_payment_identity,provider_settlement_reference,amount_minor,currency,next_status)
        VALUES ('${uid(30)}','${uid(20)}','payos','revenue-duplicate-event','revenue-payment','revenue-duplicate-settlement',1000,'VND','paid');
      INSERT INTO commerce_settlements(id,order_id,payment_attempt_id,payment_event_id,kind,disposition,provider,provider_settlement_reference,amount_minor,currency,settled_at)
        VALUES ('${uid(31)}','${uid(13)}','${uid(20)}','${uid(30)}','provider_collection','duplicate_collection','payos','revenue-duplicate-settlement',1000,'VND',now());
      BEGIN;
      INSERT INTO commerce_refunds(id,order_id,settlement_id,amount_minor,currency,provider,requested_by_id,reason_code,updated_at)
        VALUES ('${uid(32)}','${uid(13)}','${uid(31)}',10,'VND','payos','${uid(1)}','SYNTHETIC_DUPLICATE_REFUND',now());
      INSERT INTO commerce_refund_allocations(refund_id,order_line_id,amount_minor,currency) VALUES ('${uid(32)}','${uid(14)}',10,'VND');
      COMMIT;
      BEGIN;
      UPDATE commerce_refunds SET status='recorded',status_operation_id='${uid(33)}',external_reference='revenue-duplicate-refund',recorded_by_id='${uid(1)}',recorded_at=now(),updated_at=now() WHERE id='${uid(32)}';
      INSERT INTO commerce_lifecycle_events(entity_type,entity_id,previous_status,next_status,actor_kind,actor_id,operation_id) VALUES ('refund','${uid(32)}','requested','recorded','user','${uid(1)}','${uid(33)}');
      COMMIT;
    `);
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,source_refund_id,kind,amount_minor) VALUES ('${uid(15)}','noncanonical-refund','${uid(32)}','refund_recognized',-8)`)).rejects.toThrow(/recorded canonical refund/);
    const result = await db.query<{ source_refund_id: string }>(`SELECT source_refund_id FROM revenue_ledger_entries WHERE id='${uid(29)}'`);
    expect(result.rows[0].source_refund_id).toBe(uid(27));
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,source_refund_id,kind,amount_minor) VALUES ('${uid(15)}','recognition-with-refund','${uid(27)}','recognized',0)`)).rejects.toThrow(/check constraint/);
  });

  it('rejects negative earning periods, invalid journal kinds and dangling consent identities', async () => {
    await expect(db.exec(`INSERT INTO revenue_earning_periods(snapshot_id,seller_id,course_id,period_index,due_at,amount_minor) VALUES ('${uid(14)}','${uid(2)}','${uid(5)}',1,now(),-1)`)).rejects.toThrow(/check constraint/);
    await expect(db.exec(`INSERT INTO revenue_ledger_entries(period_id,source_key,kind,amount_minor) VALUES ('${uid(15)}','invalid-kind','payout',1)`)).rejects.toThrow(/check constraint/);
    await expect(db.exec(`INSERT INTO revenue_participation_events(course_id,seller_id,terms_id,action) VALUES ('${uid(5)}','${uid(2)}','${uid(999)}','accepted')`)).rejects.toThrow(/foreign key constraint/);
  });
});