import { EventEmitter } from 'events';
import { NotificationStreamEvent, NotificationStreamService } from './notification-stream.service';

const userId = '0e56a921-d211-4b4d-a869-20338624d0fb';
const otherUserId = '0e56a921-d211-4b4d-a869-20338624d0fc';
const lastEventId = '13aa8a9b-8fe5-4ec0-9ac8-b6f2a2ad29aa';
const notification: NotificationStreamEvent = {
  id: 'f27cb06b-0133-4d0e-8f72-1c98a8c6624d',
  type: 'assignment_graded',
  category: 'assignment',
  title: 'Assignment graded',
  body: 'Your assignment has been graded.',
  link: '/assignments/assignment-id/submissions/me',
  isRead: false,
  readAt: null,
  createdAt: new Date('2026-08-14T00:00:01.000Z'),
};

class TestResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly headers: Record<string, string> = {};
  statusCode?: number;

  status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  set(headers: Record<string, string>): this {
    Object.assign(this.headers, headers);
    return this;
  }

  flushHeaders = jest.fn();
  write = jest.fn((chunk: string) => this.writes.push(chunk));
}

function createService() {
  const prisma = {
    notification: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  return { prisma, service: new NotificationStreamService(prisma as never) };
}

describe('NotificationStreamService', () => {
  afterEach(() => jest.useRealTimers());

  it('streams events only to subscribers for the matching authenticated user', async () => {
    const { service } = createService();
    const recipientResponse = new TestResponse();
    const otherResponse = new TestResponse();

    await service.open(userId, recipientResponse as never);
    await service.open(otherUserId, otherResponse as never);
    service.publish(userId, notification);

    expect(recipientResponse.writes).toContain(
      `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`,
    );
    expect(otherResponse.writes).toHaveLength(0);
    recipientResponse.emit('close');
    otherResponse.emit('close');
  });

  it('replays only events after a last event owned by the authenticated user', async () => {
    const { prisma, service } = createService();
    const response = new TestResponse();
    const lastCreatedAt = new Date('2026-08-14T00:00:00.000Z');
    prisma.notification.findFirst.mockResolvedValue({ id: lastEventId, createdAt: lastCreatedAt });
    prisma.notification.findMany.mockResolvedValue([notification]);

    await service.open(userId, response as never, lastEventId);

    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: lastEventId, userId },
      select: { id: true, createdAt: true },
    });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId,
          OR: [
            { createdAt: { gt: lastCreatedAt } },
            { createdAt: lastCreatedAt, id: { gt: lastEventId } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      }),
    );
    expect(response.writes).toHaveLength(1);
    response.emit('close');
  });

  it('removes closed connections and stops their heartbeat', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const response = new TestResponse();

    await service.open(userId, response as never);
    response.emit('close');
    jest.advanceTimersByTime(25_000);
    service.publish(userId, notification);

    expect(response.writes).toHaveLength(0);
  });
});
