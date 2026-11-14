import { DEFAULT_PLATFORM_SETTINGS } from './platform-settings.defaults';
import { validatePlatformSettings } from './platform-settings.validation';

describe('course quiz policy validation', () => {
  it('accepts historical content without adding fields to the stored revision', () => {
    const historical = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
    Reflect.deleteProperty(historical, 'quizDefaults');
    const before = JSON.stringify(historical);
    expect(validatePlatformSettings('courses', historical)).toBe('courses');
    expect(JSON.stringify(historical)).toBe(before);
  });
  it('accepts bounded decimal scores and zero as unlimited time/attempt defaults', () => {
    const content = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
    Object.assign(content.quizDefaults, { passingScore: 82.25, timeLimitMinutes: 0, maxAttempts: 0 });
    expect(validatePlatformSettings('courses', content)).toBe('courses');
  });
  it.each([{ passingScore: 101 }, { passingScore: 1.123 }, { timeLimitMinutes: 1441 }, { timeLimitMinutes: -1 },
    { maxAttempts: 101 }, { maxAttempts: 1.5 }, { allowInstructorOverrides: 'false' }, { unexpected: true }])('rejects unsupported defaults %j', patch => {
    const content = structuredClone(DEFAULT_PLATFORM_SETTINGS.courses);
    Object.assign(content.quizDefaults, patch);
    expect(() => validatePlatformSettings('courses', content)).toThrow();
  });
});
