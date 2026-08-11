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
    const controller = new AdminController(
      service as never,
      {} as AuditService,
      {} as never,
    );

    await expect(controller.getOverview()).resolves.toBe(overview);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });

  it('returns filtered audit logs from the append-only audit service', async () => {
    const result = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 };
    const auditService = {
      list: jest.fn().mockResolvedValue(result),
    };
    const controller = new AdminController(
      {} as never,
      auditService as never,
      {} as never,
    );
    const query = { page: 1, pageSize: 25, search: 'course' };

    await expect(controller.getAuditLogs(query)).resolves.toBe(result);
    expect(auditService.list).toHaveBeenCalledWith(query);
  });

  it('returns filtered users and sanitized user details', async () => {
    const list = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 };
    const detail = { id: '11111111-1111-4111-8111-111111111111' };
    const userService = {
      listUsers: jest.fn().mockResolvedValue(list),
      getUser: jest.fn().mockResolvedValue(detail),
    };
    const controller = new AdminController(
      {} as never,
      {} as AuditService,
      userService as never,
    );
    const query = { page: 1, pageSize: 25, search: 'learner' };

    await expect(controller.getUsers(query)).resolves.toBe(list);
    await expect(controller.getUser(detail.id)).resolves.toBe(detail);
    expect(userService.listUsers).toHaveBeenCalledWith(query);
    expect(userService.getUser).toHaveBeenCalledWith(detail.id);
  });

  it('passes the authenticated administrator to confirmed user mutations', async () => {
    const result = { id: '11111111-1111-4111-8111-111111111111' };
    const userService = {
      setStatus: jest.fn().mockResolvedValue(result),
      setRoles: jest.fn().mockResolvedValue(result),
    };
    const controller = new AdminController(
      {} as never,
      {} as AuditService,
      userService as never,
    );

    await expect(
      controller.updateUserStatus(
        result.id,
        { status: 'suspended' },
        'actor-id',
      ),
    ).resolves.toBe(result);
    await expect(
      controller.updateUserRoles(
        result.id,
        { roles: [RoleName.student, RoleName.instructor] },
        'actor-id',
      ),
    ).resolves.toBe(result);
    expect(userService.setStatus).toHaveBeenCalledWith(
      'actor-id',
      result.id,
      'suspended',
    );
    expect(userService.setRoles).toHaveBeenCalledWith(
      'actor-id',
      result.id,
      [RoleName.student, RoleName.instructor],
    );
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
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminController.prototype.getUsers),
    ).toEqual([RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminController.prototype.getUser),
    ).toEqual([RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.updateUserStatus,
      ),
    ).toEqual([RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.updateUserRoles,
      ),
    ).toEqual([RoleName.platform_admin]);
  });
});
