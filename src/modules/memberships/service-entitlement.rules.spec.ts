import {
  entitlementUsageWindow,
  normalizeEntitlementValue,
} from './service-entitlement.rules';

describe('service entitlement rules', () => {
  it('accepts boolean, metered, and unlimited values without plan-name branching', () => {
    expect(normalizeEntitlementValue('boolean', 'none', false, null)).toEqual({
      valueType: 'boolean', resetPeriod: 'none', booleanValue: false, quota: null,
    });
    expect(normalizeEntitlementValue('metered', 'calendar_month', null, 12n)).toEqual({
      valueType: 'metered', resetPeriod: 'calendar_month', booleanValue: null, quota: 12n,
    });
    expect(normalizeEntitlementValue('unlimited', 'none', null, null)).toEqual({
      valueType: 'unlimited', resetPeriod: 'none', booleanValue: null, quota: null,
    });
  });

  it('rejects ambiguous values and reset semantics', () => {
    expect(() => normalizeEntitlementValue('boolean', 'none', null, null)).toThrow();
    expect(() => normalizeEntitlementValue('metered', 'none', null, 0n)).toThrow();
    expect(() => normalizeEntitlementValue('unlimited', 'calendar_month', null, null)).toThrow();
  });

  it('calculates UTC calendar-month windows and clamps them to grant boundaries', () => {
    expect(entitlementUsageWindow(
      'calendar_month',
      new Date('2026-01-15T10:00:00.000Z'),
      new Date('2026-03-10T10:00:00.000Z'),
      new Date('2026-02-07T09:00:00.000Z'),
    )).toEqual({
      startsAt: new Date('2026-02-01T00:00:00.000Z'),
      endsAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(entitlementUsageWindow(
      'calendar_month',
      new Date('2026-01-15T10:00:00.000Z'),
      new Date('2026-02-10T10:00:00.000Z'),
      new Date('2026-01-20T09:00:00.000Z'),
    )).toEqual({
      startsAt: new Date('2026-01-15T10:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
    });
  });

  it('uses the whole grant as a non-resetting or membership-term window', () => {
    const startsAt = new Date('2026-01-31T12:00:00.000Z');
    const endsAt = new Date('2026-04-30T12:00:00.000Z');
    expect(entitlementUsageWindow('none', startsAt, endsAt, new Date('2026-03-01')))
      .toEqual({ startsAt, endsAt });
    expect(entitlementUsageWindow('membership_term', startsAt, endsAt, new Date('2026-03-01')))
      .toEqual({ startsAt, endsAt });
  });
});
