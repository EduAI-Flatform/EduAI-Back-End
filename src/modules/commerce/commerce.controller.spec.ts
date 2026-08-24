import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CommerceController } from './commerce.controller';

describe('CommerceController cart routes', () => {
  function createController() {
    const service = {
      addCourse: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      clearCart: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      getCart: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      removeCourse: jest.fn().mockResolvedValue({ id: 'cart-id' }),
    };
    const orderService = { createOrder: jest.fn().mockResolvedValue({ id: 'order-id' }) };
    return {
      controller: new CommerceController(service as never, orderService as never),
      service,
      orderService,
    };
  }

  it('binds every cart mutation to the authenticated learner', async () => {
    const { controller, service } = createController();

    await controller.addCourse('student-id', { courseId: 'course-id' });
    await controller.removeCourse('student-id', 'course-id');
    await controller.clearCart('student-id');

    expect(service.addCourse).toHaveBeenCalledWith('student-id', 'course-id');
    expect(service.removeCourse).toHaveBeenCalledWith('student-id', 'course-id');
    expect(service.clearCart).toHaveBeenCalledWith('student-id');
  });

  it('forwards the idempotency key only to server-side order creation', async () => {
    const { controller, orderService } = createController();
    const input = { voucherApplications: [{ courseId: 'course-id', code: 'SAVE20' }] };

    await controller.createOrder('student-id', 'request-key', input);

    expect(orderService.createOrder).toHaveBeenCalledWith(
      'student-id',
      'request-key',
      input,
    );
  });

  it('requires the student role and authentication guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CommerceController.prototype.getCart)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CommerceController.prototype.addCourse)).toHaveLength(2);
  });
});
