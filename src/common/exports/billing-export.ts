import { BadRequestException } from '@nestjs/common';
import { textWorkbook } from './text-workbook';
export const BILLING_EXPORT_LIMIT = 2000;
export function calendarDateRange(startDate?: unknown, endDate?: unknown) {
  const parse = (value: unknown): Date | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('INVALID_DATE_RANGE');
    const utc = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) throw new BadRequestException('INVALID_DATE_RANGE');
    return new Date(value + 'T00:00:00+07:00');
  };
  const start = parse(startDate), last = parse(endDate);
  if (start && last && start > last) throw new BadRequestException('INVALID_DATE_RANGE');
  return start || last ? { ...(start ? { gte: start } : {}), ...(last ? { lt: new Date(last.getTime() + 86400000) } : {}) } : undefined;
}
export function billingWorkbook(filename: string, rows: readonly (readonly string[])[], asOf: Date) {
  return { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const,
    dataBase64: textWorkbook(rows, 'Report').toString('base64'), exported: rows.length - 1,
    scope: 'filtered_history' as const, complete: true as const, asOf: asOf.toISOString() };
}
