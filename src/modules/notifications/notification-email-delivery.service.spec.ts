import { AppLoggerService } from '../../common/logging/app-logger.service';
import { NotificationChannel, NotificationDeliveryStatus } from '../../../generated/prisma/client';
import { NotificationEmailProvider } from './notification-email.provider';
import { NotificationEmailDeliveryService } from './notification-email-delivery.service';

const notificationId = '13aa8a9b-8fe5-4ec0-9ac8-b6f2a2ad29aa';
const deliveryId = '23aa8a9b-8fe5-4ec0-9ac8-b6f2a2ad29aa';

describe('NotificationEmailDeliveryService', () => {
  it('claims and delivers one pending email exactly once', async () => {
    const { provider, prisma, service } = createService();
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.notificationDelivery.findUnique.mockResolvedValue(deliveryFixture());

    await expect(service.deliver(notificationId)).resolves.toBe(true);

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'assignment', to: 'learner@example.test' }),
    );
    expect(prisma.notificationDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: NotificationDeliveryStatus.delivered }),
        where: { id: deliveryId },
      }),
    );
  });

  it('records a safe failed state and logs no recipient or message body on provider failure', async () => {
    const { logs, provider, prisma, service } = createService();
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.notificationDelivery.findUnique.mockResolvedValue(deliveryFixture());
    provider.send.mockRejectedValue(new Error('provider response contains sensitive content'));

    await expect(service.deliver(notificationId)).resolves.toBe(false);

    expect(prisma.notificationDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: 'provider_request_failed',
          status: NotificationDeliveryStatus.failed,
        }),
        where: { id: deliveryId },
      }),
    );
    expect(logs.join('\n')).not.toContain('learner@example.test');
    expect(logs.join('\n')).not.toContain('provider response contains sensitive content');
  });

  it('does not send when another worker already claimed the delivery', async () => {
    const { provider, prisma, service } = createService();
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.deliver(notificationId)).resolves.toBe(false);
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.findUnique).not.toHaveBeenCalled();
  });
});

function createService() {
  const logs: string[] = [];
  const provider = { send: jest.fn() } as unknown as jest.Mocked<NotificationEmailProvider>;
  provider.send.mockResolvedValue({ status: 'sent' });
  const prisma = {
    notificationDelivery: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const service = new NotificationEmailDeliveryService(
    prisma as never,
    provider,
    new AppLoggerService((entry) => logs.push(entry)),
  );

  return { logs, provider, prisma, service };
}

function deliveryFixture() {
  return {
    id: deliveryId,
    notification: {
      body: 'Assignment content',
      category: 'assignment',
      title: 'Assignment due',
      user: { email: 'learner@example.test' },
    },
  };
}
