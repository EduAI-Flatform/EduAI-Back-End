// PostgreSQL + Prisma 7 regression for the runtime failure seen on Render.
// Runs only in CI's disposable PostgreSQL service; never touches Neon.
const assert = require('node:assert/strict');
const { PrismaClient } = require('../dist/generated/prisma/client.js');
const { PrismaPg } = require('@prisma/adapter-pg');
const { lockGdsPayosOrderNamespace } = require('../dist/src/modules/wallet/gds-payos-order-namespace.js');

async function main() {
  assert.match(process.env.DATABASE_URL || '', /^postgresql:\/\/eduai_migration_replay:/);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    await prisma.$transaction(async (tx) => {
      await lockGdsPayosOrderNamespace(tx);
      const rows = await tx.$queryRaw`SELECT 1::integer AS operational`;
      assert.equal(rows[0]?.operational, 1);
    });
    process.stdout.write('GDS_ADVISORY_LOCK_PRISMA=PASS\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`GDS_ADVISORY_LOCK_PRISMA=FAIL ${error?.name || 'Error'}\n`);
  process.exitCode = 1;
});
