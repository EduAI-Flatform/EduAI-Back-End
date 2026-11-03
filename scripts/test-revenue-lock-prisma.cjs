// Regression for PostgreSQL void decoding through Prisma 7. Disposable CI database only.
'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { NotFoundException } = require('@nestjs/common');
  const { RevenueFinanceService } = require('../dist/src/modules/revenue-sharing/revenue-finance.service.js');
  const { RevenueMembershipService } = require('../dist/src/modules/revenue-sharing/revenue-membership.service.js');
  const { MembershipAdminService } = require('../dist/src/modules/memberships/membership-admin.service.js');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    // With the former SELECT pg_advisory_xact_lock expression, Prisma rejects void before the next query.
    const finance = new RevenueFinanceService(db);
    await db.$transaction(async tx => {
      await finance.lockCheckout(tx);
      assert.equal((await tx.$queryRawUnsafe('SELECT 1::integer AS operational'))[0].operational, 1);
    });
    const membership = new RevenueMembershipService(db);
    await db.$transaction(tx => membership.synchronizeCheckout(tx));
    await membership.reconcileDue();
    // A missing version must reach the domain validation, rather than fail while decoding the lock.
    const admin = new MembershipAdminService(db, null, null);
    await assert.rejects(admin.configureIncludedCourse(randomUUID(), randomUUID(), { courseId: randomUUID(), graceDays: 0 }), NotFoundException);
    process.stdout.write('REVENUE_ADVISORY_LOCK_PRISMA=PASS\n');
  } finally {
    await db.$disconnect();
  }
}
main().catch(error => {
  process.stderr.write('REVENUE_ADVISORY_LOCK_PRISMA=FAIL ' + (error?.code || error?.name || 'Error') + '\n');
  process.exitCode = 1;
});
