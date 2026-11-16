import { DEFAULT_PLATFORM_SETTINGS, withCourseProgramDefaults } from './platform-settings.defaults';
import { validatePlatformSettings } from './platform-settings.validation';

describe('course program identities independent of course discount taxonomy', () => {
  it('gives the six default groups distinct stable identities', () => {
    const groups = DEFAULT_PLATFORM_SETTINGS.courses.categories;
    expect(groups.map(group => (group as any).id)).toEqual(['online', 'k12', 'vocational', 'higher-education', 'joint-programs', 'scholarships']);
  });
  it('normalizes historical labels without mutating the stored revision or inferring an unknown native catalog', () => {
    const historical = { ...DEFAULT_PLATFORM_SETTINGS.courses,
      categories: [{ vi: 'Custom', en: 'Custom' }, { vi: 'Online', en: 'Online courses' }] };
    const before = JSON.stringify(historical);
    const normalized = withCourseProgramDefaults(historical) as typeof DEFAULT_PLATFORM_SETTINGS.courses;
    expect(normalized.categories.map(group => (group as any).id)).toEqual(['legacy-program-1', 'online']);
    expect(JSON.stringify(historical)).toBe(before);
    expect(validatePlatformSettings('courses', historical)).toBe('courses');
  });
  it('retains identity after renaming/reordering and does not silently repair invalid explicit identities', () => {
    const content = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
    content.categories.reverse(); content.categories[0].en = 'Renamed';
    expect(withCourseProgramDefaults(content)).toEqual(content);
    for (const id of ['', '../unsafe', 'online']) {
      const invalid = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
      Object.assign(invalid.categories[1], { id });
      expect(() => validatePlatformSettings('courses', invalid)).toThrow();
    }
  });
  it('preserves unknown explicit groups as unconnected identities and rejects unrelated extra fields', () => {
    const content = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
    content.categories.push({ id: 'new-program', vi: 'New', en: 'New' } as any);
    expect(validatePlatformSettings('courses', content)).toBe('courses');
    Object.assign(content.categories[0], { categorySlug: 'discount-category' });
    expect(() => validatePlatformSettings('courses', content)).toThrow();
  });
});
