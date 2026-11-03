import { BadRequestException } from '@nestjs/common';

export interface RevenueMatchingRule {
  priority: number;
  categorySlugs?: string[];
  levels?: string[];
  minPriceAmountMinor?: string | null;
  maxPriceAmountMinor?: string | null;
  weight: number;
}
export interface RevenueWeightOverride { courseId: string; weight: number }
export interface RevenueMatchingCourse {
  id: string;
  categorySlug: string | null;
  level: string;
  priceAmountMinor: number | null;
  status: string;
  moderationStatus: string;
  deletedAt: Date | null;
}

export function membershipEffectiveAt(mode: string, days: number | undefined, now: Date): Date {
  if (mode === 'immediate' && days === undefined) return new Date(now);
  if (mode === 'delayed' && Number.isSafeInteger(days) && days! > 0 && days! <= 3650) {
    return new Date(now.getTime() + days! * 86_400_000);
  }
  throw new BadRequestException('Immediate changes must omit noticeDays; delayed changes require 1-3650 whole days.');
}

export function matchRevenueRule(course: RevenueMatchingCourse, rules: RevenueMatchingRule[]): RevenueMatchingRule | null {
  if (course.deletedAt || course.status !== 'published' || course.moderationStatus !== 'clear') return null;
  return [...rules].sort((a, b) => a.priority - b.priority).find(rule => {
    if (rule.categorySlugs?.length && (!course.categorySlug || !rule.categorySlugs.includes(course.categorySlug))) return false;
    if (rule.levels?.length && !rule.levels.includes(course.level)) return false;
    if (rule.minPriceAmountMinor != null || rule.maxPriceAmountMinor != null) {
      if (course.priceAmountMinor === null) return false;
      const price = BigInt(course.priceAmountMinor);
      if (rule.minPriceAmountMinor != null && price < BigInt(rule.minPriceAmountMinor)) return false;
      if (rule.maxPriceAmountMinor != null && price > BigInt(rule.maxPriceAmountMinor)) return false;
    }
    return true;
  }) ?? null;
}

export function membershipSelections(courses: RevenueMatchingCourse[], rules: RevenueMatchingRule[], overrides: RevenueWeightOverride[]) {
  return courses.flatMap(course => {
    const rule = matchRevenueRule(course, rules);
    return rule ? [{ courseId: course.id, weight: overrides.find(item => item.courseId === course.id)?.weight ?? rule.weight }] : [];
  }).sort((a, b) => a.courseId.localeCompare(b.courseId));
}
