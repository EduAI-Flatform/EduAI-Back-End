import { DEFAULT_PLATFORM_SETTINGS } from "./platform-settings.defaults";
import {
  validatePlatformSettings,
  validatePlatformUrl,
} from "./platform-settings.validation";
describe("platform configuration validation", () => {
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
