import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditAction } from '../../../common/audit/audit.service';
import { ListAuditLogsQueryDto } from './list-audit-logs-query.dto';

describe('ListAuditLogsQueryDto', () => {
  it('normalizes optional filters and pagination', async () => {
    const query = plainToInstance(ListAuditLogsQueryDto, {
      page: '2',
      pageSize: '50',
      search: '  course  ',
      action: AuditAction.CoursePublished,
      targetType: '  course ',
      occurredAfter: '2026-08-01T00:00:00.000Z',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query).toMatchObject({
      page: 2,
      pageSize: 50,
      search: 'course',
      targetType: 'course',
    });
  });

  it('rejects oversized pages and unknown actions', async () => {
    const query = plainToInstance(ListAuditLogsQueryDto, {
      pageSize: '101',
      action: 'RAW_TOKEN_EXPORTED',
    });

    await expect(validate(query)).resolves.not.toHaveLength(0);
  });
});
