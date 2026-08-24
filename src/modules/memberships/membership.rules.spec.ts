import {
  addCalendarMonths,
  calculateDurationPrice,
} from './membership.rules';

describe('membership rules', () => {
  it('calculates fixed and percentage duration prices with integer-only VND math', () => {
    expect(
      calculateDurationPrice({
        baseMonthlyPriceAmountMinor: 100_001n,
        months: 3,
        priceAmountMinor: 250_000n,
        discountPercent: null,
      }),
    ).toBe(250_000n);
    expect(
      calculateDurationPrice({
        baseMonthlyPriceAmountMinor: 100_001n,
        months: 3,
        priceAmountMinor: null,
        discountPercent: 25,
      }),
    ).toBe(225_002n);
    expect(
      calculateDurationPrice({
        baseMonthlyPriceAmountMinor: 100_001n,
        months: 3,
        priceAmountMinor: null,
        discountPercent: 100,
      }),
    ).toBe(0n);
  });

  it.each([
    { priceAmountMinor: null, discountPercent: null },
    { priceAmountMinor: 1n, discountPercent: 10 },
  ])('requires exactly one pricing mode', (pricing) => {
    expect(() =>
      calculateDurationPrice({
        baseMonthlyPriceAmountMinor: 100n,
        months: 1,
        ...pricing,
      }),
    ).toThrow('exactly one');
  });

  it('uses calendar-month clamping instead of fixed-day duration math', () => {
    expect(addCalendarMonths(new Date('2027-01-31T10:15:00.000Z'), 1).toISOString()).toBe(
      '2027-02-28T10:15:00.000Z',
    );
    expect(addCalendarMonths(new Date('2028-01-31T10:15:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T10:15:00.000Z',
    );
    expect(addCalendarMonths(new Date('2027-12-31T10:15:00.000Z'), 2).toISOString()).toBe(
      '2028-02-29T10:15:00.000Z',
    );
  });
});
