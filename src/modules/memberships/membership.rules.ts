export interface MembershipDurationPricing {
  baseMonthlyPriceAmountMinor: bigint;
  months: number;
  priceAmountMinor: bigint | null;
  discountPercent: number | null;
}

export function calculateDurationPrice(input: MembershipDurationPricing): bigint {
  if (input.baseMonthlyPriceAmountMinor < 0n) {
    throw new Error('Base monthly price must be non-negative.');
  }
  if (!Number.isInteger(input.months) || input.months <= 0) {
    throw new Error('Membership duration months must be a positive whole number.');
  }
  const hasFixedPrice = input.priceAmountMinor !== null;
  const hasDiscount = input.discountPercent !== null;
  if (hasFixedPrice === hasDiscount) {
    throw new Error('A duration requires exactly one fixed price or discount.');
  }
  if (input.priceAmountMinor !== null) {
    if (input.priceAmountMinor < 0n) throw new Error('Fixed price must be non-negative.');
    return input.priceAmountMinor;
  }
  if (
    !Number.isInteger(input.discountPercent) ||
    input.discountPercent! < 0 ||
    input.discountPercent! > 100
  ) {
    throw new Error('Discount percent must be between zero and 100.');
  }
  return (
    input.baseMonthlyPriceAmountMinor *
    BigInt(input.months) *
    BigInt(100 - input.discountPercent!)
  ) / 100n;
}

export function addCalendarMonths(start: Date, months: number): Date {
  if (!Number.isInteger(months) || months <= 0 || Number.isNaN(start.getTime())) {
    throw new Error('A valid start and positive whole-month duration are required.');
  }
  const result = new Date(start.getTime());
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}
