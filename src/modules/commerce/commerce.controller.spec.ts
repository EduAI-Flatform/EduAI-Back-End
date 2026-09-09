import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CommerceController } from './commerce.controller';

describe('CommerceController learner routes', () => {
  function createController() {
    const service = {
      addCourse: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      clearCart: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      getCart: jest.fn().mockResolvedValue({ id: 'cart-id' }),
      removeCourse: jest.fn().mockResolvedValue({ id: 'cart-id' }),
    };
    const orderService = { createOrder: jest.fn().mockResolvedValue({ id: 'order-id' }) };
    const orderHistoryService = {
      list: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 }),
      get: jest.fn().mockResolvedValue({ id: 'order-id' }),
    };
    return {
      controller: new CommerceController(
        service as never,
        orderService as never,
        orderHistoryService as never,
      ),
      service,
      orderService,
      orderHistoryService,
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

  it('lists and reads only the authenticated learner order history', async () => {
    const { controller, orderHistoryService } = createController();
    const query = { page: 2, pageSize: 10 };

    await controller.listOrders('student-id', query);
    await controller.getOrder('student-id', '11111111-1111-4111-8111-111111111111');

    expect(orderHistoryService.list).toHaveBeenCalledWith('student-id', query);
    expect(orderHistoryService.get).toHaveBeenCalledWith(
      'student-id',
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('requires the student role and authentication guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CommerceController.prototype.getCart)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CommerceController.prototype.listOrders)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CommerceController.prototype.addCourse)).toHaveLength(2);
    expect(Reflect.getMetadata(GUARDS_METADATA, CommerceController.prototype.getOrder)).toHaveLength(2);
  });
});
