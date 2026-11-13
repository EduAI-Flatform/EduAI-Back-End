import { cardServiceLimitWindow, DEFAULT_CARD_SERVICE_LIMITS } from './membership-card-limits.policy';

describe('card service-limit reset windows', () => {
  const settings = { ...DEFAULT_CARD_SERVICE_LIMITS, termAnchorAt: '2024-01-31T12:00:00Z', termMonths: 1 };
  it('retains lifetime scope and calendar-month boundaries independently of rank windows', () => {
    expect(cardServiceLimitWindow('none', settings, new Date('2024-02-29T12:00:00Z')))
      .toEqual({ status: 'available', startsAt: null, endsAt: null });
    expect(cardServiceLimitWindow('calendar_month', settings, new Date('2024-02-29T23:59:59Z')))
      .toEqual({ status: 'available', startsAt: new Date('2024-02-01T00:00:00Z'), endsAt: new Date('2024-03-01T00:00:00Z') });
  });
  it('clamps month ends without drifting the original anchor and uses exclusive upper boundaries', () => {
    expect(cardServiceLimitWindow('membership_term', settings, new Date('2024-02-29T11:59:59.999Z')))
      .toEqual({ status: 'available', startsAt: new Date(settings.termAnchorAt), endsAt: new Date('2024-02-29T12:00:00Z') });
    expect(cardServiceLimitWindow('membership_term', settings, new Date('2024-02-29T12:00:00Z')))
      .toEqual({ status: 'available', startsAt: new Date('2024-02-29T12:00:00Z'), endsAt: new Date('2024-03-31T12:00:00Z') });
    expect(cardServiceLimitWindow('membership_term', settings, new Date('2024-03-31T12:00:00Z')))
      .toEqual({ status: 'available', startsAt: new Date('2024-03-31T12:00:00Z'), endsAt: new Date('2024-04-30T12:00:00Z') });
  });
  it('supports an explicit annual service term without resetting on each rolling rank evaluation', () => {
    const annual = { ...settings, termAnchorAt: '2024-02-29T00:00:00Z', termMonths: 12 };
    for (const at of ['2025-03-01T00:00:00Z', '2025-12-31T23:59:59Z']) {
      expect(cardServiceLimitWindow('membership_term', annual, new Date(at)))
        .toEqual({ status: 'available', startsAt: new Date('2025-02-28T00:00:00Z'), endsAt: new Date('2026-02-28T00:00:00Z') });
    }
    expect(cardServiceLimitWindow('membership_term', annual, new Date('2028-03-01T00:00:00Z')))
      .toEqual({ status: 'available', startsAt: new Date('2028-02-29T00:00:00Z'), endsAt: new Date('2029-02-28T00:00:00Z') });
  });
  it('normalizes an explicit timezone offset without changing the configured anchor', () => {
    const offset = { ...settings, termAnchorAt: '2026-01-01T07:00:00+07:00', termMonths: 3 };
    expect(cardServiceLimitWindow('membership_term', offset, new Date('2026-03-31T23:59:59Z')))
      .toEqual({ status: 'available', startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-04-01T00:00:00Z') });
    expect(offset.termAnchorAt).toBe('2026-01-01T07:00:00+07:00');
  });
  it('fails closed for missing periods, future anchors, unknown reset types and invalid dates', () => {
    expect(cardServiceLimitWindow('membership_term', DEFAULT_CARD_SERVICE_LIMITS, new Date('2026-01-01')))
      .toMatchObject({ status: 'unavailable', reason: 'SERVICE_TERM_NOT_CONFIGURED' });
    expect(cardServiceLimitWindow('membership_term', settings, new Date('2024-01-01')))
      .toMatchObject({ status: 'unavailable', reason: 'SERVICE_TERM_NOT_STARTED' });
    expect(cardServiceLimitWindow('user_controlled', settings, new Date('2026-01-01')))
      .toMatchObject({ status: 'unavailable', reason: 'UNSUPPORTED_SERVICE_RESET' });
    expect(cardServiceLimitWindow('calendar_month', settings, new Date('invalid')))
      .toMatchObject({ status: 'unavailable', reason: 'INVALID_SERVICE_LIMIT_DATE' });
  });
});
