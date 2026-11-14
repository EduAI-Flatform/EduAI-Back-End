import { BadRequestException } from "@nestjs/common";
import { isISO8601 } from 'class-validator';
import { SUPPORTED_POINT_EVENTS } from '../tmi/activity-point-policy';
import { DEFAULT_CARD_SERVICE_LIMITS, validateCardServiceLimits, withCardServiceLimitDefaults } from '../membership-cards/membership-card-limits.policy';
import type { MembershipCardPolicy } from '../membership-cards/membership-card.evaluator';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_GROUPS,
  PlatformGroup,
  withCourseQuizDefaults,
} from "./platform-settings.defaults";

const localized = { vi: "", en: "" };
const arrayTemplates: Record<string, unknown> = {
  navigation: DEFAULT_PLATFORM_SETTINGS.navigation[0],
  tiers: { ...DEFAULT_PLATFORM_SETTINGS.membership.tiers[0], serviceLimits: [] },
  serviceLimits: { definitionId: '', quota: '' },
  benefits: localized,
  categories: localized,
  rules: { event: "", points: 0 },
  items: { name: "", logoUrl: "", url: "", category: "" },
  activities: {
    kind: "",
    title: localized,
    description: localized,
    startsAt: "",
    url: "",
    enabled: true,
  },
};
const limits: Record<string, [number, number]> = {
  cycleMonths: [1, 120],
  expireAfterMonths: [1, 120],
  maxDaily: [0, 1000000],
  points: [0, 1000000],
  commissionBps: [0, 10000],
  attributionDays: [1, 365],
  holdDays: [0, 365],
  descriptionMaxLength: [100, 4000],
  maxAttachmentMb: [1, 10],
  termMonths: [0, 120],
  maxAttempts: [0, 100],
  timeLimitMinutes: [0, 1440],
};
function fail(path: string): never {
  throw new BadRequestException("Invalid configuration: " + path);
}
export function validatePlatformUrl(value: string, path: string) {
  if (!value) return;
  if (
    /^\/(?!\/)[A-Za-z0-9/_?=&.%#:+-]*$/.test(value) &&
    !/%(?:0[0-9a-f]|1[0-9a-f]|5c)/i.test(value)
  )
    return;
  try {
    const u = new URL(value);
    if (u.protocol === "https:" && !u.username && !u.password) return;
  } catch {
    /* invalid */
  }
  fail(path);
}
function validateShape(value: unknown, template: unknown, path: string) {
  const key = path.split(".").slice(-1)[0];
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 100) fail(path);
    for (const item of value)
      validateShape(item, arrayTemplates[key], path + ".item");
  } else if (template && typeof template === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
    const t = template as Record<string, unknown>,
      v = value as Record<string, unknown>;
    if (
      Object.keys(v).some((k) => !Object.prototype.hasOwnProperty.call(t, k)) ||
      Object.keys(t).some((k) => !Object.prototype.hasOwnProperty.call(v, k))
    )
      fail(path);
    for (const k of Object.keys(t)) validateShape(v[k], t[k], path + "." + k);
  } else if (typeof value !== typeof template) fail(path);
  else if (typeof value === "string") {
    if (path.includes(".colors.") && !/^#[0-9a-f]{6}$/i.test(value)) fail(path);
    if (key === "kind" && !["event", "competition"].includes(value)) fail(path);
    if (key === "startsAt" && value && (!isISO8601(value, { strict: true, strictSeparator: true })
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))))
      fail(path);
    if (value.length > 2000 || /[\u0000-\u0008]/.test(value)) fail(path);
    if (/url$|path$/i.test(key)) validatePlatformUrl(value, path);
    if (
      key === "supportEmail" &&
      value &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      fail(path);
  } else if (typeof value === "number") {
    if (key === 'passingScore') {
      if (!Number.isFinite(value) || value < 0 || value > 100 || Number(value.toFixed(2)) !== value) fail(path);
      return;
    }
    const [min, max] = limits[key] ?? [0, 1000000000000];
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(path);
  }
}
export function validatePlatformSettings(
  group: string,
  content: unknown,
): PlatformGroup {
  if (!(PLATFORM_GROUPS as readonly string[]).includes(group)) fail("group");
  if (!content || JSON.stringify(content).length > 100000) fail("size");
  const validated = group === 'membership' ? withCardServiceLimitDefaults(content)
    : group === 'courses' ? withCourseQuizDefaults(content) : content;
  validateShape(
    validated,
    group === 'membership' ? { ...DEFAULT_PLATFORM_SETTINGS.membership, serviceLimits: DEFAULT_CARD_SERVICE_LIMITS }
      : DEFAULT_PLATFORM_SETTINGS[group as PlatformGroup],
    group,
  );
  const c = validated as Record<string, any>;
  if (group === 'operations' && c.activities.some((activity: any) => activity.enabled && !activity.title.vi.trim()))
    fail('activity Vietnamese title is required when published');
  if (group === "affiliate" && (c.currency !== "VND" || c.commissionBase !== "net_paid_after_recorded_refunds" || c.attributionModel !== "first_touch" || c.subAffiliateEnabled))
    fail("affiliate supported currency/base/attribution scope");
  if (group === "affiliate" && (!['unconfigured', 'platform_fee'].includes(c.fundingSource) || c.allocationPrecedence !== 'seller_entitlements_first'))
    fail('affiliate funding source and allocation precedence');
  if (group === "branding" && (!c.logoUrl || !c.name.trim()))
    fail("branding identity");
  if (group === "membership") {
    validateCardServiceLimits(c as MembershipCardPolicy);
    if (c.currency !== "VND" || c.cycleMode !== "rolling")
      fail("membership currency/cycle mode");
    if (!["spend", "topup"].includes(c.basis) || !c.tiers.length)
      fail("membership");
    if (c.enabled && c.tiers[0].threshold !== 0)
      fail("membership initial threshold must be zero");
    let previous = -1;
    const codes = new Set();
    for (const tier of c.tiers) {
      if (!/^[a-z][a-z0-9-]*$/.test(tier.code) || codes.has(tier.code))
        fail("tier code");
      codes.add(tier.code);
      if (c.enabled && tier.threshold <= previous) fail("ascending thresholds");
      previous = tier.threshold;
    }
  }
  if (group === "navigation") {
    const ids = new Set();
    for (const item of content as any[]) {
      if (!/^[a-z][a-z0-9-]*$/.test(item.id) || ids.has(item.id) || !item.path)
        fail("navigation id/path");
      ids.add(item.id);
    }
  }
  if (
    group === "partners" &&
    c.items.some(
      (p: any) =>
        !["school", "business", "scholarship", "digital"].includes(p.category),
    )
  )
    fail("partner category");
  if (group === "points") {
    const events = new Set();
    for (const r of c.rules) {
      if (!SUPPORTED_POINT_EVENTS.some(event => event === r.event) || events.has(r.event)) fail("point event");
      events.add(r.event);
    }
  }
  return group as PlatformGroup;
}
