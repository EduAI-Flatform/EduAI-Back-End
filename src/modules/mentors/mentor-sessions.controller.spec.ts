import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MentorSessionsController } from './mentor-sessions.controller';

describe('MentorSessionsController', () => {
  const service = { join: jest.fn(), leave: jest.fn() };
  const controller = new MentorSessionsController(service as never);
  const user = { id: 'student-id', roles: [RoleName.student] };

  it('binds join and leave to the authenticated actor', async () => {
    await controller.join(user, 'booking-id');
    await controller.leave(user, 'booking-id');
    expect(service.join).toHaveBeenCalledWith(user, 'booking-id');
    expect(service.leave).toHaveBeenCalledWith(user, 'booking-id');
  });

  it('requires authentication and permits only participant-capable roles', () => {
    const roles = [RoleName.student, RoleName.instructor, RoleName.platform_admin];
    expect(Reflect.getMetadata(ROLES_KEY, MentorSessionsController.prototype.join)).toEqual(roles);
    expect(Reflect.getMetadata(ROLES_KEY, MentorSessionsController.prototype.leave)).toEqual(roles);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, MentorSessionsController.prototype.join)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, MentorSessionsController.prototype.leave)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, MentorSessionsController)).toHaveLength(2);
  });
});
