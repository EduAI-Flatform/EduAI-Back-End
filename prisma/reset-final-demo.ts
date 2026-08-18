import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { demoCourses } from './demo-fixtures';
import { requireDemoSeedPassword } from './demo-contract';
import { FINAL_DEMO_IDS } from './final-demo-fixtures';
import { loadBackendEnv } from '../src/config/env.validation';

const env = loadBackendEnv();
requireDemoSeedPassword(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

async function reset(): Promise<void> {
  await prisma.tmiEntitlement.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.entitlements] } } });
  await prisma.tmiLedgerEntry.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.ledgerEntries] } } });
  await prisma.tmiRedemption.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.redemptions] } } });
  await prisma.tmiReward.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.rewards] } } });
  await prisma.scholarshipAward.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipAwards] } } });
  await prisma.scholarshipApplication.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipApplications] } } });
  await prisma.scholarshipCourse.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipScopes] } } });
  await prisma.scholarshipCampaign.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.scholarships] } } });
  await prisma.voucherRedemption.deleteMany({ where: { voucherId: { in: [...FINAL_DEMO_IDS.vouchers] } } });
  await prisma.voucherCourse.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.voucherScopes] } } });
  await prisma.voucher.deleteMany({ where: { id: { in: [...FINAL_DEMO_IDS.vouchers] } } });
  for (const course of demoCourses) {
    await prisma.course.update({ where: { id: course.id }, data: { categorySlug: null, priceAmountMinor: course.priceAmountMinor, priceCurrency: course.priceCurrency } });
  }
}

reset()
  .then(() => process.stdout.write('Final demo records reset; base demo seed retained.\n'))
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
