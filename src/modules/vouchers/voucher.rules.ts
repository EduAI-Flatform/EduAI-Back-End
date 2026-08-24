export type VoucherStatus = 'draft' | 'active' | 'disabled';
export type VoucherKind = 'percentage' | 'fixed';

export interface VoucherPolicy {
  code: string;
  status: VoucherStatus;
  kind: VoucherKind;
  value: number;
  currency: string;
  startsAt: string;
  endsAt: string;
  minimumCoursePriceMinor: number | null;
  maximumDiscountMinor: number | null;
  usageLimit: number | null;
  redeemedCount: number;
  perUserLimit: number | null;
  userRedemptionCount: number;
  courseIds: string[];
  categorySlugs: string[];
  eligibleUserIds: string[];
}

export interface VoucherEligibilityContext {
  now: string;
  submittedCode: string;
  userId: string;
  courseId: string;
  categorySlug?: string | null;
  coursePrice: { amountMinor: number; currency: string };
}

export type VoucherDecisionReason =
  | 'eligible'
  | 'code_invalid'
  | 'voucher_disabled'
  | 'voucher_not_started'
  | 'voucher_expired'
  | 'invalid_voucher_policy'
  | 'invalid_course_price'
  | 'currency_mismatch'
  | 'minimum_course_price_not_met'
  | 'usage_limit_reached'
  | 'per_user_limit_reached'
  | 'user_not_eligible'
  | 'course_scope_not_eligible';

export interface VoucherDecision {
  eligible: boolean;
  reason: VoucherDecisionReason;
  discountAmountMinor: number;
  finalAmountMinor: number;
}

export function evaluateVoucherEligibility(
  policy: VoucherPolicy,
  context: VoucherEligibilityContext,
): VoucherDecision {
  const baseAmount = context.coursePrice.amountMinor;
  const fail = (reason: VoucherDecisionReason): VoucherDecision => ({
    eligible: false,
    reason,
    discountAmountMinor: 0,
    finalAmountMinor: baseAmount,
  });

  if (normalizeCode(context.submittedCode) !== normalizeCode(policy.code)) {
    return fail('code_invalid');
  }
  if (policy.status === 'disabled') return fail('voucher_disabled');
  if (policy.status !== 'active') return fail('invalid_voucher_policy');
  if (!isValidCoursePrice(context.coursePrice)) return fail('invalid_course_price');
  if (!isValidPolicy(policy)) return fail('invalid_voucher_policy');
  if (policy.currency.toUpperCase() !== context.coursePrice.currency.toUpperCase()) {
    return fail('currency_mismatch');
  }

  const now = Date.parse(context.now);
  const startsAt = Date.parse(policy.startsAt);
  const endsAt = Date.parse(policy.endsAt);
  if (now < startsAt) return fail('voucher_not_started');
  if (now >= endsAt) return fail('voucher_expired');
  if (
    policy.minimumCoursePriceMinor !== null &&
    baseAmount < policy.minimumCoursePriceMinor
  ) {
    return fail('minimum_course_price_not_met');
  }
  if (policy.usageLimit !== null && policy.redeemedCount >= policy.usageLimit) {
    return fail('usage_limit_reached');
  }
  if (policy.perUserLimit !== null && policy.userRedemptionCount >= policy.perUserLimit) {
    return fail('per_user_limit_reached');
  }
  if (
    policy.eligibleUserIds.length > 0 &&
    !policy.eligibleUserIds.includes(context.userId)
  ) {
    return fail('user_not_eligible');
  }

  const hasCourseScope = policy.courseIds.length > 0;
  const hasCategoryScope = policy.categorySlugs.length > 0;
  if (
    (hasCourseScope || hasCategoryScope) &&
    !policy.courseIds.includes(context.courseId) &&
    !(context.categorySlug && policy.categorySlugs.includes(context.categorySlug))
  ) {
    return fail('course_scope_not_eligible');
  }

  const rawDiscount =
    policy.kind === 'percentage'
      ? Math.floor((baseAmount * policy.value) / 100)
      : policy.value;
  const cappedDiscount = Math.min(
    baseAmount,
    policy.maximumDiscountMinor === null
      ? rawDiscount
      : Math.min(rawDiscount, policy.maximumDiscountMinor),
  );

  return {
    eligible: true,
    reason: 'eligible',
    discountAmountMinor: cappedDiscount,
    finalAmountMinor: baseAmount - cappedDiscount,
  };
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function isValidCoursePrice(price: VoucherEligibilityContext['coursePrice']): boolean {
  return (
    Number.isInteger(price.amountMinor) &&
    price.amountMinor >= 0 &&
    /^[A-Z]{3}$/i.test(price.currency)
  );
}

function isValidPolicy(policy: VoucherPolicy): boolean {
  const validDates =
    Number.isFinite(Date.parse(policy.startsAt)) &&
    Number.isFinite(Date.parse(policy.endsAt));
  const validValue =
    policy.kind === 'percentage'
      ? Number.isInteger(policy.value) && policy.value >= 1 && policy.value <= 100
      : Number.isInteger(policy.value) && policy.value > 0;
  const validLimits = [
    policy.minimumCoursePriceMinor,
    policy.maximumDiscountMinor,
    policy.usageLimit,
    policy.perUserLimit,
  ].every((value) => value === null || (Number.isInteger(value) && value >= 0));
  return (
    /^[A-Z0-9_-]{3,64}$/i.test(policy.code.trim()) &&
    /^[A-Z]{3}$/i.test(policy.currency) &&
    validDates &&
    Date.parse(policy.startsAt) <= Date.parse(policy.endsAt) &&
    validValue &&
    validLimits &&
    Number.isInteger(policy.redeemedCount) &&
    policy.redeemedCount >= 0 &&
    Number.isInteger(policy.userRedemptionCount) &&
    policy.userRedemptionCount >= 0
  );
}
