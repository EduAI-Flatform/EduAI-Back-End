import { DEMO_IDS, demoCourses, fixtureUuid } from './demo-fixtures';

export const FINAL_DEMO_IDS = {
  courseMetadata: demoCourses.map((course) => course.id),
  vouchers: [fixtureUuid(0x31, 1), fixtureUuid(0x31, 2), fixtureUuid(0x31, 3)],
  voucherScopes: [fixtureUuid(0x31, 101), fixtureUuid(0x31, 102), fixtureUuid(0x31, 103)],
  scholarships: [fixtureUuid(0x32, 1), fixtureUuid(0x32, 2)],
  scholarshipScopes: [fixtureUuid(0x32, 101), fixtureUuid(0x32, 102)],
  scholarshipApplications: [fixtureUuid(0x32, 201), fixtureUuid(0x32, 202), fixtureUuid(0x32, 203)],
  scholarshipAwards: [fixtureUuid(0x32, 301)],
  rewards: [fixtureUuid(0x33, 1), fixtureUuid(0x33, 2), fixtureUuid(0x33, 3)],
  ledgerEntries: [fixtureUuid(0x33, 101), fixtureUuid(0x33, 102)],
  redemptions: [fixtureUuid(0x33, 201)],
  entitlements: [fixtureUuid(0x33, 301)],
} as const;

export const finalDemoCourseMetadata = demoCourses.map((course, index) => ({
  id: course.id,
  categorySlug: ['machine-learning', 'data-science', 'marketing', 'ai-foundations', 'deep-learning', 'data-analysis', 'generative-ai', 'computer-vision', 'nlp', 'automation'][index],
  priceAmountMinor: index === 3 ? 0 : course.priceAmountMinor,
  priceCurrency: course.priceCurrency,
}));

export const finalDemoVoucherIds = {
  active: FINAL_DEMO_IDS.vouchers[0],
  expired: FINAL_DEMO_IDS.vouchers[1],
  disabled: FINAL_DEMO_IDS.vouchers[2],
} as const;

export const finalDemoScholarshipIds = {
  active: FINAL_DEMO_IDS.scholarships[0],
  closed: FINAL_DEMO_IDS.scholarships[1],
} as const;

export const finalDemoRewardIds = {
  activeCourseAccess: FINAL_DEMO_IDS.rewards[0],
  disabledGift: FINAL_DEMO_IDS.rewards[1],
  expiredVoucher: FINAL_DEMO_IDS.rewards[2],
} as const;

export const finalDemoAccounts = {
  studentId: DEMO_IDS.primaryStudent,
  instructorId: DEMO_IDS.primaryInstructor,
  adminId: DEMO_IDS.admin,
} as const;
