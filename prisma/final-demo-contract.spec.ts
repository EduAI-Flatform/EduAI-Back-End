import { describe, expect, it } from '@jest/globals';
import { FINAL_DEMO_IDS, finalDemoCourseMetadata, finalDemoRewardIds, finalDemoScholarshipIds, finalDemoVoucherIds } from './final-demo-fixtures';
import { assertFinalDemoFixtureContract } from './final-demo-contract';

describe('final demo dataset contract', () => {
  it('uses a dedicated deterministic registry without replacing the base seed', () => {
    expect(() => assertFinalDemoFixtureContract()).not.toThrow();
    expect(finalDemoCourseMetadata).toHaveLength(10);
    expect(finalDemoCourseMetadata.some((course) => course.priceAmountMinor === 0)).toBe(true);
    expect(Object.values(FINAL_DEMO_IDS).flat()).toHaveLength(31);
  });

  it('covers voucher, scholarship, and TMI final scenarios', () => {
    expect(finalDemoVoucherIds).toEqual({ active: FINAL_DEMO_IDS.vouchers[0], expired: FINAL_DEMO_IDS.vouchers[1], disabled: FINAL_DEMO_IDS.vouchers[2] });
    expect(finalDemoScholarshipIds).toEqual({ active: FINAL_DEMO_IDS.scholarships[0], closed: FINAL_DEMO_IDS.scholarships[1] });
    expect(finalDemoRewardIds).toEqual({ activeCourseAccess: FINAL_DEMO_IDS.rewards[0], disabledGift: FINAL_DEMO_IDS.rewards[1], expiredVoucher: FINAL_DEMO_IDS.rewards[2] });
  });
});
