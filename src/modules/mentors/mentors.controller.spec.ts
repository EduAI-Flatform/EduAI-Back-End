import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MentorsController } from './mentors.controller';

describe('MentorsController', () => {
  const service = { updateMine: jest.fn(), setActive: jest.fn(), listDirectory: jest.fn(), setApproval: jest.fn() };
  const controller = new MentorsController(service as never);

  it('binds owner and administrator mutations to authenticated actors', async () => {
    await controller.updateMine('instructor-id', { headline: 'Mentor', timezone: 'UTC', expertise: [], availability: [] });
    await controller.setApproval('admin-id', 'mentor-id', { status: 'approved' as never });
    expect(service.updateMine).toHaveBeenCalledWith('instructor-id', expect.any(Object));
    expect(service.setApproval).toHaveBeenCalledWith('admin-id', 'mentor-id', expect.any(Object));
  });

  it('declares instructor, student, and administrator role boundaries', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MentorsController.prototype.updateMine)).toEqual([RoleName.instructor]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorsController.prototype.list)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorsController.prototype.setApproval)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata(GUARDS_METADATA, MentorsController)).toHaveLength(2);
  });
});
