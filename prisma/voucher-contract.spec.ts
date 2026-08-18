import {
  evaluateVoucherEligibility,
  type VoucherEligibilityContext,
  type VoucherPolicy,
} from './voucher-contract';

const activeWindow = {
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
};

const baseVoucher: VoucherPolicy = {
  code: ' EDUAI20 ',
  status: 'active',
  kind: 'percentage',
  value: 20,
  currency: 'VND',
  ...activeWindow,
  minimumCoursePriceMinor: 500000,
  maximumDiscountMinor: 200000,
  usageLimit: 10,
  redeemedCount: 2,
  perUserLimit: 1,
  userRedemptionCount: 0,
  courseIds: [],
  categorySlugs: ['ai-foundations'],
  eligibleUserIds: [],
};

const baseContext: VoucherEligibilityContext = {
  now: '2026-08-18T00:00:00.000Z',
  submittedCode: 'eduai20',
  userId: 'user-1',
  courseId: 'course-1',
  categorySlug: 'ai-foundations',
  coursePrice: { amountMinor: 1499000, currency: 'VND' },
};

describe('Sprint 21 voucher contract', () => {
  it('calculates a capped percentage discount from server-shaped course price', () => {
    expect(evaluateVoucherEligibility(baseVoucher, baseContext)).toEqual({
      eligible: true,
      reason: 'eligible',
      discountAmountMinor: 200000,
      finalAmountMinor: 1299000,
    });
  });

  it('calculates a fixed discount and never returns a negative final amount', () => {
    expect(
      evaluateVoucherEligibility(
        { ...baseVoucher, kind: 'fixed', value: 2000000, maximumDiscountMinor: null },
        { ...baseContext, coursePrice: { amountMinor: 500000, currency: 'VND' } },
      ),
    ).toMatchObject({
      eligible: true,
      discountAmountMinor: 500000,
      finalAmountMinor: 0,
    });
  });

  it.each([
    ['disabled', { status: 'disabled' as const }, 'voucher_disabled'],
    ['expired', { endsAt: '2026-08-17T23:59:59.000Z' }, 'voucher_expired'],
    ['below minimum', { minimumCoursePriceMinor: 2000000 }, 'minimum_course_price_not_met'],
    ['wrong category', { categorySlugs: ['data-science'] }, 'course_scope_not_eligible'],
    ['user limit', { userRedemptionCount: 1 }, 'per_user_limit_reached'],
    ['global limit', { redeemedCount: 10 }, 'usage_limit_reached'],
  ])('rejects %s with a stable reason code', (_label, patch, reason) => {
    expect(
      evaluateVoucherEligibility(
        { ...baseVoucher, ...patch },
        baseContext,
      ),
    ).toMatchObject({ eligible: false, reason, discountAmountMinor: 0, finalAmountMinor: 1499000 });
  });

  it('rejects invalid currency and discount policy values', () => {
    expect(
      evaluateVoucherEligibility(
        { ...baseVoucher, currency: 'USD' },
        baseContext,
      ).reason,
    ).toBe('currency_mismatch');
    expect(
      evaluateVoucherEligibility(
        { ...baseVoucher, value: 101 },
        baseContext,
      ).reason,
    ).toBe('invalid_voucher_policy');
  });

  it('rejects a replayed or incorrect submitted code before discount calculation', () => {
    expect(
      evaluateVoucherEligibility(baseVoucher, {
        ...baseContext,
        submittedCode: 'OTHER-CODE',
      }).reason,
    ).toBe('code_invalid');
  });
});
