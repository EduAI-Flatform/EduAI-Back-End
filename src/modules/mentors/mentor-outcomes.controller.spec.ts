import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MentorOutcomesController } from './mentor-outcomes.controller';

describe('MentorOutcomesController', () => {
  const service = { get: jest.fn(), savePrivateNote: jest.fn(), saveSharedNote: jest.fn(), createGoal: jest.fn(), updateGoal: jest.fn(), complete: jest.fn(), saveReview: jest.fn() };
  const controller = new MentorOutcomesController(service as never);
  it('keeps private notes and completion instructor-only while outcomes are participant-visible', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MentorOutcomesController.prototype.get)).toEqual([RoleName.student, RoleName.instructor]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorOutcomesController.prototype.privateNote)).toEqual([RoleName.instructor]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorOutcomesController.prototype.complete)).toEqual([RoleName.instructor]);
    expect(Reflect.getMetadata(ROLES_KEY, MentorOutcomesController.prototype.review)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, MentorOutcomesController.prototype.complete)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, MentorOutcomesController)).toHaveLength(2);
  });
});
