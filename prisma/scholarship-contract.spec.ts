import {
  evaluateScholarshipEligibility,
  type ScholarshipEligibilityContext,
  type ScholarshipPolicy,
} from "./scholarship-contract";

const activeWindow = {
  startsAt: "2026-08-01T00:00:00.000Z",
  endsAt: "2026-09-01T00:00:00.000Z",
};

const baseScholarship: ScholarshipPolicy = {
  status: "active",
  applicationMode: "application",
  benefitKind: "percentage_discount",
  benefitValue: 50,
  currency: "VND",
  ...activeWindow,
  quota: 10,
  awardedCount: 2,
  courseIds: [],
  categorySlugs: ["ai-foundations"],
  eligibleUserIds: ["user-1"],
};

const baseContext: ScholarshipEligibilityContext = {
  now: "2026-08-18T00:00:00.000Z",
  userId: "user-1",
  courseId: "course-1",
  categorySlug: "ai-foundations",
  alreadyApplied: false,
};

describe("Sprint 21 scholarship design contract", () => {
  it("allows an eligible application inside the campaign window", () => {
    expect(evaluateScholarshipEligibility(baseScholarship, baseContext)).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });

  it.each([
    ["draft", { status: "draft" as const }, "campaign_not_active"],
    ["paused", { status: "paused" as const }, "campaign_not_active"],
    ["before start", { startsAt: "2026-08-19T00:00:00.000Z" }, "campaign_not_active"],
    ["after end", { endsAt: "2026-08-18T00:00:00.000Z" }, "campaign_expired"],
    ["quota", { awardedCount: 10 }, "quota_reached"],
    ["ineligible user", {}, "user_not_eligible"],
    ["duplicate application", {}, "already_applied"],
  ])("rejects %s with a stable reason", (_label, patch, reason) => {
    const context =
      _label === "ineligible user"
        ? { ...baseContext, userId: "user-2" }
        : _label === "duplicate application"
          ? { ...baseContext, alreadyApplied: true }
          : baseContext;
    expect(
      evaluateScholarshipEligibility({ ...baseScholarship, ...patch }, context),
    ).toMatchObject({ eligible: false, reason });
  });

  it("allows a course-scoped campaign by course or category, but rejects unrelated courses", () => {
    const scoped = { ...baseScholarship, courseIds: ["course-special"], categorySlugs: [] };
    expect(
      evaluateScholarshipEligibility(scoped, { ...baseContext, courseId: "course-special", categorySlug: null }),
    ).toMatchObject({ eligible: true });
    expect(
      evaluateScholarshipEligibility(scoped, { ...baseContext, courseId: "course-other", categorySlug: "data-science" }),
    ).toMatchObject({ eligible: false, reason: "course_scope_not_eligible" });
  });

  it("rejects invalid percentage and fixed benefits before any award mutation", () => {
    expect(
      evaluateScholarshipEligibility({ ...baseScholarship, benefitValue: 101 }, baseContext),
    ).toMatchObject({ eligible: false, reason: "invalid_benefit" });
    expect(
      evaluateScholarshipEligibility({ ...baseScholarship, benefitKind: "fixed_credit", benefitValue: 0 }, baseContext),
    ).toMatchObject({ eligible: false, reason: "invalid_benefit" });
  });
});
