import { BadRequestException } from '@nestjs/common';
import { normalizeCourseDescription } from './course-description';

describe('course description boundary', () => {
  it('preserves legacy text and supported formatting', () => {
    expect(normalizeCourseDescription(' **Bold**\r\n- Item ')).toBe('**Bold**\n- Item');
    expect(normalizeCourseDescription(null)).toBeNull();
    expect(normalizeCourseDescription(undefined)).toBeUndefined();
  });
  it('removes unsafe control characters and rejects oversized text', () => {
    expect(normalizeCourseDescription('hello\u0000world')).toBe('helloworld');
    expect(() => normalizeCourseDescription('a'.repeat(4001))).toThrow(BadRequestException);
  });
  it('enforces the effective administrator-configured limit', () => {
    expect(normalizeCourseDescription('short', 5)).toBe('short');
    expect(() => normalizeCourseDescription('too long', 5)).toThrow(BadRequestException);
  });
});
