import { BadRequestException } from '@nestjs/common';

/** Formatting is restricted text markup, never stored or rendered as HTML. */
export function normalizeCourseDescription(value: string | null | undefined, maxLength = 4000): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (normalized.length > maxLength) throw new BadRequestException('Course description exceeds the configured maximum length.');
  return normalized || null;
}
