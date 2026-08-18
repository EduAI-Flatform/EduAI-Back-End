import { ScholarshipApplicationStatus, ScholarshipApplicationMode, ScholarshipBenefitKind, ScholarshipStatus, TmiEntitlementStatus, TmiLedgerKind, TmiRewardKind, TmiRewardStatus, VoucherKind, VoucherStatus, type PrismaClient } from '../generated/prisma/client';
import { DEMO_IDS, demoCourses } from './demo-fixtures';
import { FINAL_DEMO_IDS, finalDemoAccounts, finalDemoCourseMetadata, finalDemoRewardIds, finalDemoScholarshipIds, finalDemoVoucherIds } from './final-demo-fixtures';

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function seedFinalDemoData(prisma: PrismaClient): Promise<void> {
  const now = new Date();

  for (const course of finalDemoCourseMetadata) {
    await prisma.course.update({
      where: { id: course.id },
      data: { categorySlug: course.categorySlug, priceAmountMinor: course.priceAmountMinor, priceCurrency: course.priceCurrency },
    });
  }

  await prisma.voucher.upsert({
    where: { id: finalDemoVoucherIds.active },
    create: { id: finalDemoVoucherIds.active, code: 'EDUAI-FINAL-20', status: VoucherStatus.active, kind: VoucherKind.percentage, value: 20, currency: 'VND', startsAt: addDays(now, -1), endsAt: addDays(now, 30), minimumCoursePriceMinor: 500000, maximumDiscountMinor: 300000, usageLimit: 20, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { create: [{ id: FINAL_DEMO_IDS.voucherScopes[0], courseId: demoCourses[0].id }] } },
    update: { code: 'EDUAI-FINAL-20', status: VoucherStatus.active, kind: VoucherKind.percentage, value: 20, currency: 'VND', startsAt: addDays(now, -1), endsAt: addDays(now, 30), minimumCoursePriceMinor: 500000, maximumDiscountMinor: 300000, usageLimit: 20, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { deleteMany: {}, create: [{ id: FINAL_DEMO_IDS.voucherScopes[0], courseId: demoCourses[0].id }] } },
  });
  await prisma.voucher.upsert({
    where: { id: finalDemoVoucherIds.expired },
    create: { id: finalDemoVoucherIds.expired, code: 'EDUAI-FINAL-EXPIRED', status: VoucherStatus.active, kind: VoucherKind.fixed, value: 100000, currency: 'VND', startsAt: addDays(now, -30), endsAt: addDays(now, -1), minimumCoursePriceMinor: null, maximumDiscountMinor: null, usageLimit: 10, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { create: [{ id: FINAL_DEMO_IDS.voucherScopes[1], courseId: demoCourses[1].id }] } },
    update: { code: 'EDUAI-FINAL-EXPIRED', status: VoucherStatus.active, kind: VoucherKind.fixed, value: 100000, currency: 'VND', startsAt: addDays(now, -30), endsAt: addDays(now, -1), minimumCoursePriceMinor: null, maximumDiscountMinor: null, usageLimit: 10, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { deleteMany: {}, create: [{ id: FINAL_DEMO_IDS.voucherScopes[1], courseId: demoCourses[1].id }] } },
  });
  await prisma.voucher.upsert({
    where: { id: finalDemoVoucherIds.disabled },
    create: { id: finalDemoVoucherIds.disabled, code: 'EDUAI-FINAL-OFF', status: VoucherStatus.disabled, kind: VoucherKind.fixed, value: 50000, currency: 'VND', startsAt: addDays(now, -1), endsAt: addDays(now, 30), minimumCoursePriceMinor: null, maximumDiscountMinor: null, usageLimit: 10, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { create: [{ id: FINAL_DEMO_IDS.voucherScopes[2], courseId: demoCourses[2].id }] } },
    update: { code: 'EDUAI-FINAL-OFF', status: VoucherStatus.disabled, kind: VoucherKind.fixed, value: 50000, currency: 'VND', startsAt: addDays(now, -1), endsAt: addDays(now, 30), minimumCoursePriceMinor: null, maximumDiscountMinor: null, usageLimit: 10, redeemedCount: 0, perUserLimit: 1, createdById: finalDemoAccounts.adminId, courseScopes: { deleteMany: {}, create: [{ id: FINAL_DEMO_IDS.voucherScopes[2], courseId: demoCourses[2].id }] } },
  });

  await prisma.scholarshipCampaign.upsert({
    where: { id: finalDemoScholarshipIds.active },
    create: { id: finalDemoScholarshipIds.active, title: 'Học bổng AI Foundation — Final Demo', description: 'Dữ liệu synthetic cho luồng apply và review.', status: ScholarshipStatus.active, applicationMode: ScholarshipApplicationMode.application, benefitKind: ScholarshipBenefitKind.course_access, benefitValue: 1, currency: null, startsAt: addDays(now, -1), endsAt: addDays(now, 30), quota: 2, awardedCount: 0, createdById: finalDemoAccounts.adminId, courseScopes: { create: [{ id: FINAL_DEMO_IDS.scholarshipScopes[0], courseId: demoCourses[3].id }] } },
    update: { title: 'Học bổng AI Foundation — Final Demo', description: 'Dữ liệu synthetic cho luồng apply và review.', status: ScholarshipStatus.active, applicationMode: ScholarshipApplicationMode.application, benefitKind: ScholarshipBenefitKind.course_access, benefitValue: 1, currency: null, startsAt: addDays(now, -1), endsAt: addDays(now, 30), quota: 2, awardedCount: 0, createdById: finalDemoAccounts.adminId, courseScopes: { deleteMany: {}, create: [{ id: FINAL_DEMO_IDS.scholarshipScopes[0], courseId: demoCourses[3].id }] } },
  });
  await prisma.scholarshipCampaign.upsert({
    where: { id: finalDemoScholarshipIds.closed },
    create: { id: finalDemoScholarshipIds.closed, title: 'Học bổng Data Lab — Closed Demo', description: 'Dữ liệu synthetic cho trạng thái đã đóng.', status: ScholarshipStatus.closed, applicationMode: ScholarshipApplicationMode.automatic, benefitKind: ScholarshipBenefitKind.percentage_discount, benefitValue: 50, currency: 'VND', startsAt: addDays(now, -30), endsAt: addDays(now, -1), quota: 1, awardedCount: 1, createdById: finalDemoAccounts.adminId, courseScopes: { create: [{ id: FINAL_DEMO_IDS.scholarshipScopes[1], courseId: demoCourses[1].id }] } },
    update: { title: 'Học bổng Data Lab — Closed Demo', description: 'Dữ liệu synthetic cho trạng thái đã đóng.', status: ScholarshipStatus.closed, applicationMode: ScholarshipApplicationMode.automatic, benefitKind: ScholarshipBenefitKind.percentage_discount, benefitValue: 50, currency: 'VND', startsAt: addDays(now, -30), endsAt: addDays(now, -1), quota: 1, awardedCount: 1, createdById: finalDemoAccounts.adminId, courseScopes: { deleteMany: {}, create: [{ id: FINAL_DEMO_IDS.scholarshipScopes[1], courseId: demoCourses[1].id }] } },
  });

  await prisma.scholarshipApplication.upsert({
    where: { id: FINAL_DEMO_IDS.scholarshipApplications[0] },
    create: { id: FINAL_DEMO_IDS.scholarshipApplications[0], scholarshipId: finalDemoScholarshipIds.active, userId: finalDemoAccounts.studentId, courseId: demoCourses[3].id, status: ScholarshipApplicationStatus.pending, decisionReason: null },
    update: { scholarshipId: finalDemoScholarshipIds.active, userId: finalDemoAccounts.studentId, courseId: demoCourses[3].id, status: ScholarshipApplicationStatus.pending, decisionReason: null },
  });
  await prisma.scholarshipApplication.upsert({
    where: { id: FINAL_DEMO_IDS.scholarshipApplications[1] },
    create: { id: FINAL_DEMO_IDS.scholarshipApplications[1], scholarshipId: finalDemoScholarshipIds.closed, userId: DEMO_IDS.supportingStudents[0], courseId: demoCourses[1].id, status: ScholarshipApplicationStatus.awarded, decisionReason: 'Final demo approved scenario' },
    update: { scholarshipId: finalDemoScholarshipIds.closed, userId: DEMO_IDS.supportingStudents[0], courseId: demoCourses[1].id, status: ScholarshipApplicationStatus.awarded, decisionReason: 'Final demo approved scenario' },
  });
  await prisma.scholarshipApplication.upsert({
    where: { id: FINAL_DEMO_IDS.scholarshipApplications[2] },
    create: { id: FINAL_DEMO_IDS.scholarshipApplications[2], scholarshipId: finalDemoScholarshipIds.active, userId: DEMO_IDS.supportingStudents[1], courseId: demoCourses[3].id, status: ScholarshipApplicationStatus.rejected, decisionReason: 'Synthetic rejection scenario' },
    update: { scholarshipId: finalDemoScholarshipIds.active, userId: DEMO_IDS.supportingStudents[1], courseId: demoCourses[3].id, status: ScholarshipApplicationStatus.rejected, decisionReason: 'Synthetic rejection scenario' },
  });
  await prisma.scholarshipAward.upsert({
    where: { id: FINAL_DEMO_IDS.scholarshipAwards[0] },
    create: { id: FINAL_DEMO_IDS.scholarshipAwards[0], scholarshipId: finalDemoScholarshipIds.closed, applicationId: FINAL_DEMO_IDS.scholarshipApplications[1], userId: DEMO_IDS.supportingStudents[0], courseId: demoCourses[1].id, benefitKind: ScholarshipBenefitKind.percentage_discount, benefitValue: 50, currency: 'VND', awardedAt: addDays(now, -2), revokedAt: null },
    update: { scholarshipId: finalDemoScholarshipIds.closed, applicationId: FINAL_DEMO_IDS.scholarshipApplications[1], userId: DEMO_IDS.supportingStudents[0], courseId: demoCourses[1].id, benefitKind: ScholarshipBenefitKind.percentage_discount, benefitValue: 50, currency: 'VND', awardedAt: addDays(now, -2), revokedAt: null },
  });

  await prisma.tmiReward.upsert({
    where: { id: finalDemoRewardIds.activeCourseAccess },
    create: { id: finalDemoRewardIds.activeCourseAccess, title: 'Khóa học AI Foundation — Final Demo', description: 'Quyền truy cập synthetic cho UAT.', kind: TmiRewardKind.course_access, cost: 80, status: TmiRewardStatus.active, quota: 5, redeemedCount: 1, startsAt: addDays(now, -1), endsAt: addDays(now, 30), inventoryMetadata: { courseId: demoCourses[3].id, scenario: 'final-demo' }, createdById: finalDemoAccounts.adminId },
    update: { title: 'Khóa học AI Foundation — Final Demo', description: 'Quyền truy cập synthetic cho UAT.', kind: TmiRewardKind.course_access, cost: 80, status: TmiRewardStatus.active, quota: 5, redeemedCount: 1, startsAt: addDays(now, -1), endsAt: addDays(now, 30), inventoryMetadata: { courseId: demoCourses[3].id, scenario: 'final-demo' }, createdById: finalDemoAccounts.adminId },
  });
  await prisma.tmiReward.upsert({
    where: { id: finalDemoRewardIds.disabledGift },
    create: { id: finalDemoRewardIds.disabledGift, title: 'Quà tặng disabled — Final Demo', description: 'Trạng thái disabled synthetic.', kind: TmiRewardKind.gift, cost: 50, status: TmiRewardStatus.disabled, quota: 3, redeemedCount: 0, startsAt: addDays(now, -1), endsAt: addDays(now, 30), inventoryMetadata: { scenario: 'disabled' }, createdById: finalDemoAccounts.adminId },
    update: { title: 'Quà tặng disabled — Final Demo', description: 'Trạng thái disabled synthetic.', kind: TmiRewardKind.gift, cost: 50, status: TmiRewardStatus.disabled, quota: 3, redeemedCount: 0, startsAt: addDays(now, -1), endsAt: addDays(now, 30), inventoryMetadata: { scenario: 'disabled' }, createdById: finalDemoAccounts.adminId },
  });
  await prisma.tmiReward.upsert({
    where: { id: finalDemoRewardIds.expiredVoucher },
    create: { id: finalDemoRewardIds.expiredVoucher, title: 'Voucher expired — Final Demo', description: 'Trạng thái expired synthetic.', kind: TmiRewardKind.voucher, cost: 60, status: TmiRewardStatus.expired, quota: 3, redeemedCount: 0, startsAt: addDays(now, -30), endsAt: addDays(now, -1), inventoryMetadata: { scenario: 'expired' }, createdById: finalDemoAccounts.adminId },
    update: { title: 'Voucher expired — Final Demo', description: 'Trạng thái expired synthetic.', kind: TmiRewardKind.voucher, cost: 60, status: TmiRewardStatus.expired, quota: 3, redeemedCount: 0, startsAt: addDays(now, -30), endsAt: addDays(now, -1), inventoryMetadata: { scenario: 'expired' }, createdById: finalDemoAccounts.adminId },
  });

  await prisma.tmiLedgerEntry.upsert({
    where: { id: FINAL_DEMO_IDS.ledgerEntries[0] },
    create: { id: FINAL_DEMO_IDS.ledgerEntries[0], userId: finalDemoAccounts.studentId, redemptionId: null, kind: TmiLedgerKind.earn, amount: 250, adjustmentDirection: null, sourceType: 'final_demo_seed', sourceId: 'final-demo-earn-primary', actorId: finalDemoAccounts.adminId, metadata: { scenario: 'final-demo-wallet' }, expiresAt: null },
    update: { userId: finalDemoAccounts.studentId, redemptionId: null, kind: TmiLedgerKind.earn, amount: 250, adjustmentDirection: null, sourceType: 'final_demo_seed', sourceId: 'final-demo-earn-primary', actorId: finalDemoAccounts.adminId, metadata: { scenario: 'final-demo-wallet' }, expiresAt: null },
  });
  await prisma.tmiRedemption.upsert({
    where: { id: FINAL_DEMO_IDS.redemptions[0] },
    create: { id: FINAL_DEMO_IDS.redemptions[0], userId: finalDemoAccounts.studentId, rewardId: finalDemoRewardIds.activeCourseAccess, cost: 80, idempotencyKey: 'final-demo-primary-redemption' },
    update: { userId: finalDemoAccounts.studentId, rewardId: finalDemoRewardIds.activeCourseAccess, cost: 80, idempotencyKey: 'final-demo-primary-redemption' },
  });
  await prisma.tmiLedgerEntry.upsert({
    where: { userId_kind_sourceType_sourceId: { userId: finalDemoAccounts.studentId, kind: TmiLedgerKind.redeem, sourceType: 'final_demo_seed', sourceId: 'final-demo-primary-redemption' } },
    create: { id: FINAL_DEMO_IDS.ledgerEntries[1], userId: finalDemoAccounts.studentId, redemptionId: FINAL_DEMO_IDS.redemptions[0], kind: TmiLedgerKind.redeem, amount: 80, adjustmentDirection: null, sourceType: 'final_demo_seed', sourceId: 'final-demo-primary-redemption', actorId: finalDemoAccounts.studentId, metadata: { scenario: 'final-demo-redemption' }, expiresAt: null },
    update: { redemptionId: FINAL_DEMO_IDS.redemptions[0], amount: 80, actorId: finalDemoAccounts.studentId, metadata: { scenario: 'final-demo-redemption' }, expiresAt: null },
  });
  await prisma.tmiEntitlement.upsert({
    where: { id: FINAL_DEMO_IDS.entitlements[0] },
    create: { id: FINAL_DEMO_IDS.entitlements[0], userId: finalDemoAccounts.studentId, redemptionId: FINAL_DEMO_IDS.redemptions[0], kind: TmiRewardKind.course_access, status: TmiEntitlementStatus.active, benefitMetadata: { courseId: demoCourses[3].id, scenario: 'final-demo' }, revokedAt: null },
    update: { userId: finalDemoAccounts.studentId, redemptionId: FINAL_DEMO_IDS.redemptions[0], kind: TmiRewardKind.course_access, status: TmiEntitlementStatus.active, benefitMetadata: { courseId: demoCourses[3].id, scenario: 'final-demo' }, revokedAt: null },
  });
}
