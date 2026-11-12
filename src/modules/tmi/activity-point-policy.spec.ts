import { evaluateActivityPointAward } from './activity-point-policy';

const occurredAt = new Date('2026-01-31T23:30:00Z');
const policy = { enabled: true, expireAfterMonths: 1, maxDaily: 100,
  rules: [{ event: 'course.completed', points: 80 }] };
const evaluate = (content = policy, awardedToday = 0, processedAt = occurredAt) =>
  evaluateActivityPointAward(content, 'course.completed', occurredAt, processedAt, awardedToday);

describe('frozen activity point policy evaluation', () => {
  it('clamps calendar-month expiry in UTC rather than overflowing February', () => {
    expect(evaluate()).toEqual({ outcome: 'awarded', amount: 80,
      expiresAt: new Date('2026-02-28T23:30:00Z') });
  });
  it('applies the daily ceiling across policy versions, including partial awards', () => {
    expect(evaluate(policy, 70)).toMatchObject({ outcome: 'awarded', amount: 30 });
    expect(evaluate(policy, 100)).toMatchObject({ outcome: 'daily_cap', amount: 0 });
    expect(evaluate({ ...policy, maxDaily: 0 }, 1000)).toMatchObject({ amount: 80 });
  });
  it('records disabled and absent rules without a zero-value ledger posting', () => {
    expect(evaluate({ ...policy, enabled: false })).toMatchObject({ outcome: 'disabled', amount: 0 });
    expect(evaluate({ ...policy, rules: [] })).toMatchObject({ outcome: 'no_rule', amount: 0 });
    expect(evaluate({ ...policy, rules: [{ event: 'course.completed', points: 0 }] })).toMatchObject({ outcome: 'no_rule', amount: 0 });
  });
  it('does not resurrect points when a delayed worker processes an already-expired event', () => {
    expect(evaluate(policy, 0, new Date('2026-02-28T23:30:00Z')))
      .toMatchObject({ outcome: 'expired_before_award', amount: 0 });
  });
  it('rejects unsupported event kinds and invalid numerical/date inputs', () => {
    expect(() => evaluateActivityPointAward(policy, 'client.claimed', occurredAt, occurredAt, 0))
      .toThrow('POINT_ACTIVITY_EVENT_UNSUPPORTED');
    expect(() => evaluate({ ...policy, expireAfterMonths: 0 })).toThrow('POINT_ACTIVITY_POLICY_INVALID');
    expect(() => evaluate(policy, -1)).toThrow('POINT_ACTIVITY_DAILY_TOTAL_INVALID');
    expect(() => evaluate(policy, 0, new Date('2026-01-30T00:00:00Z'))).toThrow('POINT_ACTIVITY_DATE_INVALID');
  });
  it('does not modify a previously selected policy or event timestamp', () => {
    const original = JSON.stringify(policy);
    evaluate();
    expect(JSON.stringify(policy)).toBe(original);
    expect(occurredAt.toISOString()).toBe('2026-01-31T23:30:00.000Z');
  });
});
