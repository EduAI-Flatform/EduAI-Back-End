import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AdminController } from './admin.controller';

describe('AdminController', () => {
  it('returns the platform overview from the admin service', async () => {
    const overview = { users: { total: 12 } };
    const service = {
      getOverview: jest.fn().mockResolvedValue(overview),
    };
    const controller = new AdminController(service as never, {} as AuditService);

    await expect(controller.getOverview()).resolves.toBe(overview);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });

  it('returns filtered audit logs from the append-only audit service', async () => {
    const result = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 };
    const auditService = {
      list: jest.fn().mockResolvedValue(result),
    };
    const controller = new AdminController({} as never, auditService as never);
    const query = { page: 1, pageSize: 25, search: 'course' };

    await expect(controller.getAuditLogs(query)).resolves.toBe(result);
    expect(auditService.list).toHaveBeenCalledWith(query);
  });

  it('requires authentication and the platform administrator role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getOverview,
      ),
    ).toEqual([RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getAuditLogs,
      ),
    ).toEqual([RoleName.platform_admin]);
  });
});
