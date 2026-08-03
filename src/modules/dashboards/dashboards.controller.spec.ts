import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { DashboardsController } from './dashboards.controller';

describe('DashboardsController', () => {
  function createController() {
    const service = {
      getStudentDashboard: jest.fn().mockResolvedValue({ activeCourses: [] }),
      getInstructorDashboard: jest
        .fn()
        .mockResolvedValue({ workQueue: [] }),
    };

    return {
      controller: new DashboardsController(service as never),
      service,
    };
  }

  it('loads the current student dashboard through the authenticated identity', async () => {
    const { controller, service } = createController();
    const user = { id: 'student-id', roles: [RoleName.student] };

    await controller.getStudentDashboard(user);

    expect(service.getStudentDashboard).toHaveBeenCalledWith(user.id);
  });

  it('loads instructor aggregates using the full authenticated role context', async () => {
    const { controller, service } = createController();
    const user = { id: 'instructor-id', roles: [RoleName.instructor] };

    await controller.getInstructorDashboard(user);

    expect(service.getInstructorDashboard).toHaveBeenCalledWith(user);
  });

  it('protects both dashboards and assigns the correct roles', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DashboardsController)).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        DashboardsController.prototype.getStudentDashboard,
      ),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        DashboardsController.prototype.getInstructorDashboard,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
  });
});
