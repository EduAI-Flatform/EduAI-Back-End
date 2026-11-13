import { DEFAULT_PLATFORM_SETTINGS } from "./platform-settings.defaults";
import {
  validatePlatformSettings,
  validatePlatformUrl,
} from "./platform-settings.validation";
describe("platform configuration validation", () => {
  const quotaPolicy = () => ({ ...structuredClone(DEFAULT_PLATFORM_SETTINGS.membership),
    serviceLimits: { enabled: false, consumptionPriority: 'purchased_first', termAnchorAt: '', termMonths: 0 },
    tiers: DEFAULT_PLATFORM_SETTINGS.membership.tiers.map(tier => ({ ...tier,
      serviceLimits: [{ definitionId: '00000000-0000-4000-8000-000000000001', quota: '25' }] })),
  });
  it('accepts typed service-limit drafts without activating them or changing historical policy content', () => {
    const limits = quotaPolicy();
    expect(validatePlatformSettings('membership', limits)).toBe('membership');
    const original = structuredClone(DEFAULT_PLATFORM_SETTINGS.membership);
    expect(validatePlatformSettings('membership', original)).toBe('membership');
    expect(original).toEqual(DEFAULT_PLATFORM_SETTINGS.membership);
    expect(original).not.toHaveProperty('serviceLimits');
  });
  it('accepts independent service quotas for additional administrator-defined tiers', () => {
    const value = quotaPolicy();
    value.enabled = true;
    value.tiers.forEach((tier, index) => { tier.threshold = index * 100; });
    value.tiers.push({ code: 'diamond', name: { vi: 'Kim cương', en: 'Diamond' }, threshold: 300,
      benefits: [], serviceLimits: [{ definitionId: '00000000-0000-4000-8000-000000000001', quota: '80' }] });
    const snapshot = structuredClone(value);
    expect(validatePlatformSettings('membership', value)).toBe('membership');
    expect(value).toEqual(snapshot);
    expect(value.tiers[0].serviceLimits[0].quota).toBe('25');
    expect(value.tiers[3].serviceLimits[0].quota).toBe('80');
  });
  it.each(['0', '-1', '1.5', '01', '9223372036854775808', '1e3'])('rejects unsupported service quota %s', quota => {
    const value = quotaPolicy(); value.tiers[0].serviceLimits[0].quota = quota;
    expect(() => validatePlatformSettings('membership', value)).toThrow();
  });
  it('rejects duplicate definitions, invalid references, extra rule properties and ambiguous fixed terms', () => {
    const duplicate = quotaPolicy(); duplicate.tiers[0].serviceLimits.push({ ...duplicate.tiers[0].serviceLimits[0] });
    expect(() => validatePlatformSettings('membership', duplicate)).toThrow();
    const invalid = quotaPolicy(); invalid.tiers[0].serviceLimits[0].definitionId = 'not-a-definition';
    expect(() => validatePlatformSettings('membership', invalid)).toThrow();
    const extra = quotaPolicy(); Object.assign(extra.tiers[0].serviceLimits[0], { remaining: '100' });
    expect(() => validatePlatformSettings('membership', extra)).toThrow();
    const period = quotaPolicy(); period.serviceLimits.termMonths = 12;
    expect(() => validatePlatformSettings('membership', period)).toThrow();
    period.serviceLimits.termAnchorAt = '2026-01-31T00:00:00Z';
    expect(validatePlatformSettings('membership', period)).toBe('membership');
    period.serviceLimits.termAnchorAt = '2026-02-30T00:00:00Z';
    expect(() => validatePlatformSettings('membership', period)).toThrow();
  });
  it('accepts only registered point event codes and rejects duplicate rules', () => {
    const settings = { ...DEFAULT_PLATFORM_SETTINGS.points, rules: [{ event: 'course.completed', points: 80 }] };
    expect(validatePlatformSettings('points', settings)).toBe('points');
    expect(() => validatePlatformSettings('points', { ...settings, rules: [{ event: 'client.claimed', points: 80 }] })).toThrow();
    expect(() => validatePlatformSettings('points', { ...settings, rules: [...settings.rules, ...settings.rules] })).toThrow();
  });
  const activity = { kind: 'event', title: { vi: 'Sự kiện GDS', en: 'GDS event' },
    description: { vi: '', en: '' }, startsAt: '2026-12-10T09:00:00+07:00', url: '/activities', enabled: true };
  it.each([
    { ...activity, kind: 'unsupported' },
    { ...activity, title: { vi: '   ', en: '' } },
    { ...activity, startsAt: 'not-a-date' },
    { ...activity, startsAt: '2026-02-30T09:00:00Z' },
    { ...activity, startsAt: '2026-12-10T09:00:00' },
  ])('rejects activity configuration that cannot be published accurately %#', item => {
    expect(() => validatePlatformSettings('operations', { ...DEFAULT_PLATFORM_SETTINGS.operations, activities: [item] })).toThrow();
  });
  it('accepts both supported activity types, timezone-aware dates and disabled incomplete drafts', () => {
    expect(validatePlatformSettings('operations', { ...DEFAULT_PLATFORM_SETTINGS.operations,
      activities: [activity, { ...activity, kind: 'competition', startsAt: '2026-12-10T02:00:00Z' },
        { ...activity, enabled: false, startsAt: '', title: { vi: '', en: '' } }],
    })).toBe('operations');
  });
  it.each(Object.entries(DEFAULT_PLATFORM_SETTINGS))(
    "accepts initial %s settings",
    (group, value) => {
      expect(validatePlatformSettings(group, value)).toBe(group);
    },
  );
  it.each([
    "javascript:alert(1)",
    "//evil.test",
    "http://evil.test",
    "/%5cevil",
    "https://user:pass@example.com",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validatePlatformUrl(url, "url")).toThrow();
  });
  it("rejects arbitrary configuration and duplicate menu keys", () => {
    expect(() =>
      validatePlatformSettings("branding", {
        ...DEFAULT_PLATFORM_SETTINGS.branding,
        sql: "SELECT 1",
      }),
    ).toThrow();
    expect(() =>
      validatePlatformSettings("navigation", [
        DEFAULT_PLATFORM_SETTINGS.navigation[0],
        DEFAULT_PLATFORM_SETTINGS.navigation[0],
      ]),
    ).toThrow();
    expect(() => validatePlatformSettings("secrets", {})).toThrow();
  });
  it("requires distinct ascending thresholds when enabling cards", () => {
    const c = structuredClone(DEFAULT_PLATFORM_SETTINGS.membership);
    c.enabled = true;
    expect(() => validatePlatformSettings("membership", c)).toThrow();
    c.tiers[1].threshold = 100;
    c.tiers[2].threshold = 200;
    expect(validatePlatformSettings("membership", c)).toBe("membership");
    c.tiers[0].threshold = 50;
    expect(() => validatePlatformSettings("membership", c)).toThrow();
  });
  it('accepts additional administrator-defined tiers and rejects duplicate codes or overlapping thresholds', () => {
    const c = structuredClone(DEFAULT_PLATFORM_SETTINGS.membership);
    c.enabled = true;
    c.tiers.forEach((tier, index) => { tier.threshold = index * 100; });
    c.tiers.push({ code: 'diamond', name: { vi: 'Kim cuong', en: 'Diamond' }, threshold: 300, benefits: [] });
    expect(validatePlatformSettings('membership', c)).toBe('membership');
    c.tiers[3].code = 'gold';
    expect(() => validatePlatformSettings('membership', c)).toThrow();
    c.tiers[3].code = 'diamond'; c.tiers[3].threshold = 200;
    expect(() => validatePlatformSettings('membership', c)).toThrow();
  });
  it("rejects amounts beyond safe limits and invalid attachment sizes", () => {
    expect(() =>
      validatePlatformSettings("affiliate", {
        ...DEFAULT_PLATFORM_SETTINGS.affiliate,
        minimumWithdrawal: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow();
    expect(() =>
      validatePlatformSettings("operations", {
        ...DEFAULT_PLATFORM_SETTINGS.operations,
        maxAttachmentMb: 100,
      }),
    ).toThrow();
  });
});
