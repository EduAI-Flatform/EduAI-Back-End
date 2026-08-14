import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

const notificationStreamSelect = {
  id: true,
  type: true,
  category: true,
  title: true,
  body: true,
  link: true,
  isRead: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationStreamEvent = Prisma.NotificationGetPayload<{
  select: typeof notificationStreamSelect;
}>;

type StreamResponse = Pick<Response, 'set' | 'status' | 'write' | 'on'> & {
  flushHeaders?: () => void;
};

type NotificationSubscriber = {
  response: StreamResponse;
  heartbeat: NodeJS.Timeout;
};

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_REPLAY_EVENTS = 100;

@Injectable()
export class NotificationStreamService {
  private readonly subscribersByUser = new Map<string, Set<NotificationSubscriber>>();

  constructor(private readonly prisma: PrismaService) {}

  async open(
    userId: string,
    response: StreamResponse,
    lastEventId?: string,
  ): Promise<void> {
    response
      .status(200)
      .set({
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
    response.flushHeaders?.();

    const subscriber: NotificationSubscriber = {
      response,
      heartbeat: setInterval(() => response.write(': keepalive\n\n'), HEARTBEAT_INTERVAL_MS),
    };
    this.addSubscriber(userId, subscriber);
    response.on('close', () => this.removeSubscriber(userId, subscriber));

    for (const event of await this.listReplayEvents(userId, lastEventId)) {
      this.writeEvent(response, event);
    }
  }

  publish(userId: string, event: NotificationStreamEvent): void {
    for (const subscriber of this.subscribersByUser.get(userId) ?? []) {
      this.writeEvent(subscriber.response, event);
    }
  }

  private async listReplayEvents(
    userId: string,
    lastEventId?: string,
  ): Promise<NotificationStreamEvent[]> {
    if (!lastEventId) return [];

    const lastEvent = await this.prisma.notification.findFirst({
      where: { id: lastEventId, userId },
      select: { id: true, createdAt: true },
    });
    if (!lastEvent) return [];

    return this.prisma.notification.findMany({
      where: {
        userId,
        OR: [
          { createdAt: { gt: lastEvent.createdAt } },
          { createdAt: lastEvent.createdAt, id: { gt: lastEvent.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_REPLAY_EVENTS,
      select: notificationStreamSelect,
    });
  }

  private addSubscriber(userId: string, subscriber: NotificationSubscriber): void {
    const subscribers = this.subscribersByUser.get(userId) ?? new Set();
    subscribers.add(subscriber);
    this.subscribersByUser.set(userId, subscribers);
  }

  private removeSubscriber(userId: string, subscriber: NotificationSubscriber): void {
    clearInterval(subscriber.heartbeat);
    const subscribers = this.subscribersByUser.get(userId);
    if (!subscribers) return;

    subscribers.delete(subscriber);
    if (subscribers.size === 0) this.subscribersByUser.delete(userId);
  }

  private writeEvent(response: StreamResponse, event: NotificationStreamEvent): void {
    response.write(`id: ${event.id}\nevent: notification\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
