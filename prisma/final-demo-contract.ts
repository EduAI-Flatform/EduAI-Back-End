import { ScholarshipApplicationStatus, ScholarshipStatus, TmiEntitlementStatus, TmiRewardStatus, VoucherStatus, type PrismaClient } from '../generated/prisma/client';
import { demoCourses } from './demo-fixtures';
import { FINAL_DEMO_IDS, finalDemoRewardIds, finalDemoScholarshipIds, finalDemoVoucherIds } from './final-demo-fixtures';

export function assertFinalDemoFixtureContract(): void {
  const groups = Object.values(FINAL_DEMO_IDS).flat();
  if (new Set(groups).size !== groups.length) throw new Error('Final demo IDs must be unique');
  if (demoCourses.length !== 10) throw new Error('Final demo design expects the existing ten-course seed');
}

export async function verifyFinalDemoData(prisma: PrismaClient): Promise<Record<string, number>> {
  assertFinalDemoFixtureContract();
  const counts = {
    courseMetadata: await prisma.course.count({ where: { id: { in: [...FINAL_DEMO_IDS.courseMetadata] }, categorySlug: { not: null } } }),
    vouchers: await prisma.voucher.count({ where: { id: { in: [...FINAL_DEMO_IDS.vouchers] } } }),
    voucherScopes: await prisma.voucherCourse.count({ where: { id: { in: [...FINAL_DEMO_IDS.voucherScopes] } } }),
    scholarships: await prisma.scholarshipCampaign.count({ where: { id: { in: [...FINAL_DEMO_IDS.scholarships] } } }),
    scholarshipScopes: await prisma.scholarshipCourse.count({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipScopes] } } }),
    scholarshipApplications: await prisma.scholarshipApplication.count({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipApplications] } } }),
    scholarshipAwards: await prisma.scholarshipAward.count({ where: { id: { in: [...FINAL_DEMO_IDS.scholarshipAwards] } } }),
    rewards: await prisma.tmiReward.count({ where: { id: { in: [...FINAL_DEMO_IDS.rewards] } } }),
    ledgerEntries: await prisma.tmiLedgerEntry.count({ where: { id: { in: [...FINAL_DEMO_IDS.ledgerEntries] } } }),
    redemptions: await prisma.tmiRedemption.count({ where: { id: { in: [...FINAL_DEMO_IDS.redemptions] } } }),
    entitlements: await prisma.tmiEntitlement.count({ where: { id: { in: [...FINAL_DEMO_IDS.entitlements] } } }),
  };
  const expectedCounts: Record<keyof typeof counts, number> = {
    courseMetadata: 10,
    vouchers: 3,
    voucherScopes: 3,
    scholarships: 2,
    scholarshipScopes: 2,
    scholarshipApplications: 3,
    scholarshipAwards: 1,
    rewards: 3,
    ledgerEntries: 2,
    redemptions: 1,
    entitlements: 1,
  };
  if (Object.entries(counts).some(([key, value]) => value !== expectedCounts[key as keyof typeof expectedCounts])) {
    throw new Error(`Final demo count verification failed: ${JSON.stringify(counts)}`);
  }
  const [activeVoucher, expiredVoucher, disabledVoucher, activeScholarship, closedScholarship, pendingApplication, awardedApplication, rejectedApplication, activeReward, disabledReward, expiredReward, activeEntitlement] = await Promise.all([
    prisma.voucher.findUnique({ where: { id: finalDemoVoucherIds.active }, select: { status: true, endsAt: true } }),
    prisma.voucher.findUnique({ where: { id: finalDemoVoucherIds.expired }, select: { status: true, endsAt: true } }),
    prisma.voucher.findUnique({ where: { id: finalDemoVoucherIds.disabled }, select: { status: true } }),
    prisma.scholarshipCampaign.findUnique({ where: { id: finalDemoScholarshipIds.active }, select: { status: true, endsAt: true } }),
    prisma.scholarshipCampaign.findUnique({ where: { id: finalDemoScholarshipIds.closed }, select: { status: true, endsAt: true } }),
    prisma.scholarshipApplication.findUnique({ where: { id: FINAL_DEMO_IDS.scholarshipApplications[0] }, select: { status: true } }),
    prisma.scholarshipApplication.findUnique({ where: { id: FINAL_DEMO_IDS.scholarshipApplications[1] }, select: { status: true } }),
    prisma.scholarshipApplication.findUnique({ where: { id: FINAL_DEMO_IDS.scholarshipApplications[2] }, select: { status: true } }),
    prisma.tmiReward.findUnique({ where: { id: finalDemoRewardIds.activeCourseAccess }, select: { status: true, endsAt: true } }),
    prisma.tmiReward.findUnique({ where: { id: finalDemoRewardIds.disabledGift }, select: { status: true } }),
    prisma.tmiReward.findUnique({ where: { id: finalDemoRewardIds.expiredVoucher }, select: { status: true, endsAt: true } }),
    prisma.tmiEntitlement.findUnique({ where: { id: FINAL_DEMO_IDS.entitlements[0] }, select: { status: true } }),
  ]);
  const now = new Date();
  if (!activeVoucher || activeVoucher.status !== VoucherStatus.active || activeVoucher.endsAt <= now || !expiredVoucher || expiredVoucher.endsAt >= now || !disabledVoucher || disabledVoucher.status !== VoucherStatus.disabled || !activeScholarship || activeScholarship.status !== ScholarshipStatus.active || !closedScholarship || closedScholarship.status !== ScholarshipStatus.closed || !pendingApplication || pendingApplication.status !== ScholarshipApplicationStatus.pending || !awardedApplication || awardedApplication.status !== ScholarshipApplicationStatus.awarded || !rejectedApplication || rejectedApplication.status !== ScholarshipApplicationStatus.rejected || !activeReward || activeReward.status !== TmiRewardStatus.active || activeReward.endsAt <= now || !disabledReward || disabledReward.status !== TmiRewardStatus.disabled || !expiredReward || expiredReward.status !== TmiRewardStatus.expired || !activeEntitlement || activeEntitlement.status !== TmiEntitlementStatus.active) {
    throw new Error('Final demo scenario state verification failed');
  }
  return counts;
}
