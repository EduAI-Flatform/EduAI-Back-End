import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import {
  AdminModerationController,
  ModerationController,
} from './moderation.controller';
import {
  ModerationAction,
  ModerationTargetType,
} from './moderation.service';

const targetId = '11111111-1111-4111-8111-111111111111';

describe('Moderation controllers', () => {
  it('delegates admin queue, detail, and confirmed state changes', async () => {
    const result = { id: targetId };
    const service = {
      list: jest.fn().mockResolvedValue(result),
      getDetail: jest.fn().mockResolvedValue(result),
      moderate: jest.fn().mockResolvedValue(result),
    };
    const controller = new AdminModerationController(service as never);
    const query = {
      targetType: ModerationTargetType.Course,
      page: 1,
      pageSize: 25,
    };
    const params = { targetType: ModerationTargetType.Course, targetId };
    const input = {
      action: ModerationAction.Reject,
      reason: 'Confirmed policy violation',
    };

    await expect(controller.list(query)).resolves.toBe(result);
    await expect(controller.getDetail(params)).resolves.toBe(result);
    await expect(
      controller.moderate(params, input, 'actor-id'),
    ).resolves.toBe(result);
    expect(service.list).toHaveBeenCalledWith(query);
    expect(service.getDetail).toHaveBeenCalledWith(
      ModerationTargetType.Course,
      targetId,
    );
    expect(service.moderate).toHaveBeenCalledWith(
      'actor-id',
      ModerationTargetType.Course,
      targetId,
      input,
    );
  });

  it('requires authentication and platform administrator authorization', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminModerationController),
    ).toBeDefined();
    for (const method of ['list', 'getDetail', 'moderate']) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          AdminModerationController.prototype[
            method as keyof AdminModerationController
          ],
        ),
      ).toEqual([RoleName.platform_admin]);
    }
  });

  it('delegates authenticated owner status without an admin role requirement', async () => {
    const result = { id: targetId };
    const service = { getOwnerStatus: jest.fn().mockResolvedValue(result) };
    const controller = new ModerationController(service as never);
    const user = { id: 'owner-id', roles: [RoleName.instructor] };
    const params = { targetType: ModerationTargetType.Course, targetId };

    await expect(controller.getStatus(params, user)).resolves.toBe(result);
    expect(service.getOwnerStatus).toHaveBeenCalledWith(
      user,
      ModerationTargetType.Course,
      targetId,
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ModerationController),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ModerationController.prototype.getStatus,
      ),
    ).toBeUndefined();
  });
});
