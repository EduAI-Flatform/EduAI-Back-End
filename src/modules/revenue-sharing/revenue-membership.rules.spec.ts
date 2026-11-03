import { matchRevenueRule, membershipEffectiveAt, membershipSelections } from './revenue-membership.rules';

describe('membership revenue rules', () => {
  const course = { id: 'a', categorySlug: 'coding', level: 'beginner', priceAmountMinor: 100_000, status: 'published', moderationStatus: 'clear', deletedAt: null };
  it('combines category, level and inclusive prices with AND', () => {
    const rule = { priority: 1, categorySlugs: ['coding'], levels: ['beginner'], minPriceAmountMinor: '100000', maxPriceAmountMinor: '200000', weight: 2 };
    expect(matchRevenueRule(course, [rule])?.weight).toBe(2);
    expect(matchRevenueRule({ ...course, level: 'advanced' }, [rule])).toBeNull();
    expect(matchRevenueRule({ ...course, priceAmountMinor: 99999 }, [rule])).toBeNull();
  });
  it('selects the first ordered matching rule, not the greatest weight', () => {
    expect(matchRevenueRule(course, [{ priority: 20, weight: 9 }, { priority: 10, weight: 2 }])?.weight).toBe(2);
  });
  it('excludes deleted, unmoderated and unpublished courses', () => {
    for (const update of [{ deletedAt: new Date() }, { moderationStatus: 'hidden' }, { status: 'draft' }]) {
      expect(matchRevenueRule({ ...course, ...update }, [{ priority: 1, weight: 1 }])).toBeNull();
    }
  });
  it('does not match unknown prices to a bounded rule', () => {
    expect(matchRevenueRule({ ...course, priceAmountMinor: null }, [{ priority: 1, weight: 1, minPriceAmountMinor: '0' }])).toBeNull();
  });
  it('applies per-course overrides only to courses that match', () => {
    expect(membershipSelections([course, { ...course, id: 'b', status: 'draft' }], [{ priority: 1, weight: 1 }], [{ courseId: 'a', weight: 4 }, { courseId: 'b', weight: 3 }])).toEqual([{ courseId: 'a', weight: 4 }]);
  });
  it('treats optional null price bounds as omitted', () => {
    expect(matchRevenueRule({ ...course, priceAmountMinor: null }, [{ priority: 1, weight: 2, minPriceAmountMinor: null, maxPriceAmountMinor: null }])?.weight).toBe(2);
  });  it('requires positive notice days only for delayed changes', () => {
    const now = new Date('2026-11-03T01:00:00Z');
    expect(membershipEffectiveAt('immediate', undefined, now)).toEqual(now);
    expect(membershipEffectiveAt('delayed', 2, now).toISOString()).toBe('2026-11-05T01:00:00.000Z');
    for (const value of [undefined, 0, -1, 1.5]) expect(() => membershipEffectiveAt('delayed', value, now)).toThrow();
    expect(() => membershipEffectiveAt('immediate', 3, now)).toThrow();
  });
});
