export type ScholarshipStatus = "draft" | "active" | "paused" | "closed";
export type ScholarshipApplicationMode = "application" | "automatic";
export type ScholarshipBenefitKind = "course_access" | "percentage_discount" | "fixed_credit";

export type ScholarshipPolicy = {
  status: ScholarshipStatus;
  applicationMode: ScholarshipApplicationMode;
  benefitKind: ScholarshipBenefitKind;
  benefitValue: number;
  currency: string | null;
  startsAt: string;
  endsAt: string;
  quota: number | null;
  awardedCount: number;
  courseIds: string[];
  categorySlugs: string[];
  eligibleUserIds: string[];
};

export type ScholarshipEligibilityContext = {
  now: string;
  userId: string;
  courseId: string;
  categorySlug: string | null;
  alreadyApplied: boolean;
};

export type ScholarshipEligibilityReason =
  | "eligible"
  | "campaign_not_active"
  | "campaign_expired"
  | "quota_reached"
  | "user_not_eligible"
  | "course_scope_not_eligible"
  | "already_applied"
  | "invalid_benefit";

export type ScholarshipEligibilityResult = {
  eligible: boolean;
  reason: ScholarshipEligibilityReason;
};

export function evaluateScholarshipEligibility(
  scholarship: ScholarshipPolicy,
  context: ScholarshipEligibilityContext,
): ScholarshipEligibilityResult {
  if (scholarship.status !== "active") {
    return { eligible: false, reason: "campaign_not_active" };
  }
  if (context.now < scholarship.startsAt) {
    return { eligible: false, reason: "campaign_not_active" };
  }
  if (context.now >= scholarship.endsAt) {
    return { eligible: false, reason: "campaign_expired" };
  }
  if (scholarship.quota !== null && scholarship.awardedCount >= scholarship.quota) {
    return { eligible: false, reason: "quota_reached" };
  }
  if (context.alreadyApplied) {
    return { eligible: false, reason: "already_applied" };
  }
  if (scholarship.eligibleUserIds.length > 0 && !scholarship.eligibleUserIds.includes(context.userId)) {
    return { eligible: false, reason: "user_not_eligible" };
  }
  if (
    scholarship.courseIds.length > 0 &&
    !scholarship.courseIds.includes(context.courseId) &&
    (!context.categorySlug || !scholarship.categorySlugs.includes(context.categorySlug))
  ) {
    return { eligible: false, reason: "course_scope_not_eligible" };
  }
  if (
    scholarship.benefitKind === "percentage_discount" &&
    (scholarship.benefitValue <= 0 || scholarship.benefitValue > 100)
  ) {
    return { eligible: false, reason: "invalid_benefit" };
  }
  if (scholarship.benefitKind === "fixed_credit" && scholarship.benefitValue <= 0) {
    return { eligible: false, reason: "invalid_benefit" };
  }
  return { eligible: true, reason: "eligible" };
}
