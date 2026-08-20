import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MentorBookingsController } from './mentor-bookings.controller';

describe('MentorBookingsController', () => {
  const service = { create: jest.fn(), listStudent: jest.fn(), listMentor: jest.fn(), accept: jest.fn(), reject: jest.fn(), cancel: jest.fn(), reschedule: jest.fn() };
  const controller = new MentorBookingsController(service as never);
  it('binds requests and transitions to authenticated actors', async () => {
    await controller.create('student-id', 'mentor-id', { topic: 'Topic', scheduledStart: '2030-01-01T09:00:00Z', scheduledEnd: '2030-01-01T10:00:00Z' });
    await controller.accept('mentor-id', 'booking-id');
    expect(service.create).toHaveBeenCalledWith('student-id', 'mentor-id', expect.any(Object));
    expect(service.accept).toHaveBeenCalledWith('mentor-id', 'booking-id');
  });
  it('declares student, instructor, and shared participant boundaries', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MentorBookingsController.prototype.create)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorBookingsController.prototype.listMentor)).toEqual([RoleName.instructor]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorBookingsController.prototype.accept)).toEqual([RoleName.student, RoleName.instructor]);
    expect(Reflect.getMetadata(GUARDS_METADATA, MentorBookingsController)).toHaveLength(2);
  });
});
