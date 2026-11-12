import { DEFAULT_PLATFORM_SETTINGS } from "./platform-settings.defaults";
import {
  validatePlatformSettings,
  validatePlatformUrl,
} from "./platform-settings.validation";
describe("platform configuration validation", () => {
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
